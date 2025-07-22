import os
import requests
import uuid
import qrcode
import re
from flask import Flask, render_template, jsonify, request
from supabase import create_client, Client

# === CONFIGURAÇÕES ===
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL = "https://api.sicoob.com.br/pix/api/v2/cob"
CHAVE_PIX = "04763318000185"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api-sicoob-renotur.onrender.com")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

# === Funções utilitárias ===

def get_access_token():
    print("[get_access_token] Solicitando token de acesso...")
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
    print(f"[get_access_token] Resposta status: {resp.status_code}")
    resp.raise_for_status()
    token = resp.json().get("access_token")
    print(f"[get_access_token] Token obtido, tamanho={len(token) if token else 0}")
    return token

def validar_txid(txid):
    valid = bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))
    print(f"[validar_txid] TXID='{txid}' válido? {valid}")
    return valid

def buscar_cobranca(txid, access_token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    print(f"[buscar_cobranca] Consultando cobrança TXID={txid}")
    response = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    print(f"[buscar_cobranca] Resposta status: {response.status_code}")
    if response.status_code == 200:
        print(f"[buscar_cobranca] Dados da cobrança: {response.json()}")
        return response.json()
    else:
        print(f"[buscar_cobranca] Erro ao buscar cobrança (TXID: {txid}): {response.status_code} {response.text}")
        return None

# === Rotas ===

@app.route("/")
def index():
    print("[index] Página inicial acessada")
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        dados = request.get_json(silent=True) or {}
        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")

        print(f"[api_gerar_cobranca] Dados recebidos: valor={valor}, solicitacao='{solicitacao}'")

        token = get_access_token()

        txid = uuid.uuid4().hex.upper()[:32]
        print(f"[api_gerar_cobranca] Gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid,
            "webhookUrl": f"{BASE_URL}/webhook/pix"
        }

        print(f"[api_gerar_cobranca] Payload para criação da cobrança: {payload}")

        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        print(f"[api_gerar_cobranca] Resposta da criação status: {resp.status_code}")
        resp.raise_for_status()
        d = resp.json()
        print(f"[api_gerar_cobranca] Resposta JSON da criação: {d}")

        brcode = d.get("brcode")
        if not brcode:
            print("[api_gerar_cobranca] ERRO: brcode ausente na resposta")
            return jsonify({"error": "Resposta incompleta da API"}), 500

        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)
        print(f"[api_gerar_cobranca] QR Code salvo em: {img_path}")

        # Salvar no Supabase
        try:
            res = supabase.table("cobrancas").insert({
                "txid": txid,
                "brcode": brcode,
                "status": "PENDENTE",
                "valor": valor,
                "chave_pix": CHAVE_PIX,
                "descricao": solicitacao
            }).execute()

            if res.error:
                print(f"[api_gerar_cobranca] ERRO ao salvar no Supabase: {res.error}")
                return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

            if not res.data:
                print("[api_gerar_cobranca] ERRO: resposta vazia do Supabase")
                return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

            print(f"[api_gerar_cobranca] Cobrança salva no Supabase: {res.data}")

        except Exception as e:
            print(f"[api_gerar_cobranca] Exceção ao salvar no Supabase: {e}")
            return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            print(f"[api_gerar_cobranca] HTTPError {resp.status_code}: {resp.json()}")
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.json()
            }), resp.status_code
        except Exception:
            print(f"[api_gerar_cobranca] HTTPError {resp.status_code}: {resp.text}")
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.text
            }), resp.status_code

    except Exception as e:
        print(f"[api_gerar_cobranca] Erro inesperado: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"[pix_page] Buscando cobrança para TXID: {txid}")

    if not validar_txid(txid):
        return "TXID inválido", 400

    try:
        res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
        dados = res.data
        if not dados:
            print(f"[pix_page] Cobrança não encontrada no banco para TXID: {txid}")
            return "Cobrança não encontrada no banco", 404
        print(f"[pix_page] Dados da cobrança no banco: {dados}")
    except Exception as e:
        print(f"[pix_page] Erro ao buscar cobrança no Supabase: {e}")
        return "Erro ao buscar cobrança", 500

    try:
        token = get_access_token()
        cobranca_api = buscar_cobranca(txid, token)
        if cobranca_api is None:
            print(f"[pix_page] Cobrança não encontrada via API Sicoob para TXID: {txid}")
        else:
            print(f"[pix_page] Cobrança via API Sicoob: {cobranca_api}")
    except Exception as e:
        print(f"[pix_page] Erro ao buscar cobrança via API Sicoob: {e}")
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
    print(f"[api_status] Consultando status para TXID: {txid}")
    try:
        res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
        dados = res.data
        if not dados:
            print(f"[api_status] TXID não encontrado: {txid}")
            return jsonify({"status": "NAO_ENCONTRADO"}), 404
        print(f"[api_status] Status encontrado: {dados['status']}")
        return jsonify({"status": dados["status"]})
    except Exception as e:
        print(f"[api_status] Erro ao buscar status no Supabase: {e}")
        return jsonify({"status": "ERRO"}), 500


@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json(silent=True)
    print(f"[webhook_pix] Webhook recebido: {data}")

    if not data:
        print("[webhook_pix] JSON inválido recebido")
        return jsonify({"error": "JSON inválido"}), 400

    txid = None
    if "pix" in data and isinstance(data["pix"], list) and len(data["pix"]) > 0:
        txid = data["pix"][0].get("txid")
    elif "txid" in data:
        txid = data.get("txid")

    if not txid:
        print("[webhook_pix] txid ausente no webhook")
        return jsonify({"error": "txid ausente"}), 400

    print(f"[webhook_pix] Recebido txid: {txid}")

    try:
        res_check = supabase.table("cobrancas").select("txid").eq("txid", txid).single().execute()
        if not res_check.data:
            print(f"[webhook_pix] txid não encontrado no banco: {txid}")
            return jsonify({"error": "txid não encontrado"}), 404

        res_update = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
        if res_update.error:
            print(f"[webhook_pix] Erro ao atualizar status no Supabase: {res_update.error}")
            return jsonify({"error": "Erro ao atualizar status"}), 500

        print(f"[webhook_pix] Status atualizado para CONCLUIDO no txid {txid}")

    except Exception as e:
        print(f"[webhook_pix] Exceção ao atualizar status: {e}")
        return jsonify({"error": "Exceção ao atualizar status"}), 500

    return "", 200


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    print(f"[main] Iniciando servidor na porta {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
