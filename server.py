import os
import requests
import uuid
import qrcode
import re
from flask import Flask, render_template, jsonify, request
from supabase import create_client, Client
from datetime import datetime

# === CONFIGURAÇÕES ===
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL = "https://api.sicoob.com.br/pix/api/v2/cob"
CHAVE_PIX = "04763318000185"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api-sicoob-renotur.onrender.com")  # URL base da sua API

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

def log(msg: str):
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    print(f"[{now} UTC] {msg}")

# === TOKEN SICOOB ===
def get_access_token():
    log("Iniciando get_access_token()")
    try:
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": CLIENT_ID,
                "scope": "cob.write cob.read pix.read webhook.read webhook.write"
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            cert=(CERT_FILE, KEY_FILE)
        )
        log(f"Resposta get_access_token status: {resp.status_code}")
        resp.raise_for_status()
        token = resp.json().get("access_token")
        log(f"Token obtido: {token[:10]}... (length: {len(token)})")
        return token
    except Exception as e:
        log(f"Erro em get_access_token: {e}")
        raise

# === VALIDAÇÃO TXID ===
def validar_txid(txid):
    log(f"Validando TXID: {txid}")
    valid = bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))
    log(f"TXID válido? {valid}")
    return valid

# === BUSCAR COBRANÇA VIA API SICOOB ===
def buscar_cobranca(txid, access_token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    log(f"Buscando cobrança na API Sicoob: {url}")
    try:
        response = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
        log(f"Resposta busca cobrança status: {response.status_code}")
        if response.status_code == 200:
            json_resp = response.json()
            log(f"Cobrança encontrada: {json_resp}")
            return json_resp
        else:
            log(f"Erro ao buscar cobrança (TXID: {txid}): {response.status_code} - {response.text}")
            return None
    except Exception as e:
        log(f"Erro em buscar_cobranca: {e}")
        return None

@app.before_request
def log_request_info():
    log(f"Requisição recebida: {request.method} {request.url}")
    log(f"Headers: {dict(request.headers)}")
    if request.method == "POST":
        try:
            log(f"Body: {request.get_data().decode('utf-8')}")
        except Exception as e:
            log(f"Erro ao decodificar body: {e}")

@app.route("/")
def index():
    log("Rota / acessada")
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    log("Rota /api/gerar_cobranca acessada")
    try:
        dados = request.get_json(silent=True) or {}
        log(f"Dados recebidos na API gerar_cobranca: {dados}")

        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")
        log(f"Valor: {valor}, Solicitacao: {solicitacao}")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        log(f"Gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid,
            "webhookUrl": f"{BASE_URL}/webhook/pix"
        }
        log(f"Payload para criar cobrança: {payload}")

        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        log(f"Resposta da criação da cobrança status: {resp.status_code}")
        resp.raise_for_status()
        d = resp.json()
        log(f"Resposta JSON criação da cobrança: {d}")

        brcode = d.get("brcode")
        if not brcode:
            log("BRCode ausente na resposta da criação da cobrança")
            return jsonify({"error": "BRCode ausente"}), 500

        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)
        log(f"QR Code salvo em: {img_path}")

        try:
            res = supabase.table("cobrancas").insert({
                "txid": txid,
                "brcode": brcode,
                "status": "PENDENTE",
                "valor": valor,
                "chave_pix": CHAVE_PIX,
                "descricao": solicitacao
            }).execute()
            log(f"Resposta Supabase insert: {res.status_code} - {res.data} - {res.error}")
            if not res.data:
                log("Erro: resposta vazia ao inserir no Supabase")
                return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500
        except Exception as e:
            log(f"Erro ao salvar cobrança no Supabase: {e}")
            return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        log(f"HTTPError em gerar_cobranca: {resp.status_code} - {resp.text}")
        try:
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.json()
            }), resp.status_code
        except Exception:
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.text
            }), resp.status_code
    except Exception as e:
        log(f"Erro na geração da cobrança: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    log(f"Rota /pix/{txid} acessada")
    log(f"Validando txid: {txid}")

    if not validar_txid(txid):
        log(f"TXID inválido: {txid}")
        return "TXID inválido", 400

    try:
        res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
        dados = res.data
        log(f"Dados encontrados no Supabase: {dados}")
        if not dados:
            log(f"Cobrança não encontrada no banco para TXID: {txid}")
            return "Cobrança não encontrada no banco", 404
    except Exception as e:
        log(f"Erro ao buscar cobrança no Supabase: {e}")
        return "Erro ao buscar cobrança", 500

    try:
        token = get_access_token()
        cobranca_api = buscar_cobranca(txid, token)
        if cobranca_api is None:
            log(f"Cobrança via API Sicoob não encontrada para TXID: {txid}")
        else:
            log(f"Cobrança via API Sicoob encontrada: {cobranca_api}")
    except Exception as e:
        log(f"Erro ao buscar cobrança via API Sicoob: {e}")
        cobranca_api = None

    return render_template(
        "pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid,
        VALOR=dados.get("valor", "0.00"),
        COBRANCA_API=cobranca_api
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    log(f"Rota /api/status/{txid} acessada")
    try:
        res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
        dados = res.data
        log(f"Status encontrado no Supabase: {dados}")
        if not dados:
            return jsonify({"status": "NAO_ENCONTRADO"}), 404
        return jsonify({"status": dados["status"]})
    except Exception as e:
        log(f"Erro ao buscar status no Supabase: {e}")
        return jsonify({"status": "ERRO"}), 500

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    log(f"Rota /webhook/pix acessada - Requisição recebida")
    log(f"Headers: {dict(request.headers)}")
    log(f"URL chamada: {request.url}")
    log(f"Path da rota: {request.path}")
    data = request.get_json(silent=True)
    log(f"Corpo do webhook recebido: {data}")

    if not data:
        log("⚠️ JSON inválido recebido no webhook")
        return jsonify({"error": "JSON inválido"}), 400

    txid = None
    if "pix" in data and isinstance(data["pix"], list) and len(data["pix"]) > 0:
        txid = data["pix"][0].get("txid")
    elif "txid" in data:
        txid = data.get("txid")

    if not txid:
        log("⚠️ txid ausente no webhook")
        return jsonify({"error": "txid ausente"}), 400

    log(f"TXID recebido no webhook: {txid}")

    try:
        res_check = supabase.table("cobrancas").select("txid").eq("txid", txid).single().execute()
        log(f"Verificação Supabase para TXID: {res_check.data}")

        if not res_check.data:
            log(f"❌ txid não encontrado no banco: {txid}")
            return jsonify({"error": "txid não encontrado"}), 404

        res_update = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
        log(f"✅ Status atualizado para CONCLUIDO no txid {txid} - Resposta update: {res_update.data}")

    except Exception as e:
        log(f"🔥 Erro ao atualizar status no Supabase: {e}")
        return jsonify({"error": "Exceção ao atualizar status"}), 500

    return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    log(f"Aplicação iniciada no host 0.0.0.0, porta {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
