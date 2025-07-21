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

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

# === TOKEN SICOOB ===
def get_access_token():
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
    resp.raise_for_status()
    return resp.json()["access_token"]

# === VALIDAÇÃO TXID ===
def validar_txid(txid):
    return bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))

# === BUSCAR COBRANÇA VIA API SICOOB ===
def buscar_cobranca(txid, access_token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    response = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    if response.status_code == 200:
        return response.json()
    else:
        print(f"Erro ao buscar cobrança (TXID: {txid}):", response.status_code, response.text)
        return None

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        dados = request.get_json(silent=True) or {}
        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        print(f"Gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid
        }

        # Criar cobrança
        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        resp.raise_for_status()
        d = resp.json()

        brcode = d["brcode"]
        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)

        # Salvar no Supabase
        res = supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE",
            "valor": valor,
            "chave_pix": CHAVE_PIX,
            "descricao": solicitacao
        }).execute()

        if res.status_code != 201:
            print("Erro ao salvar cobrança no Supabase:", res.status_code, res.data)
            return jsonify({"error": "Erro ao salvar cobrança"}), 500

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
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
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"Buscando cobrança para TXID: {txid}")

    if not validar_txid(txid):
        return "TXID inválido", 400

    try:
        # Busca no Supabase
        res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()

        if res.status_code != 200:
            print("Erro ao buscar cobrança no Supabase:", res.status_code, res.data)
            return "Erro ao buscar cobrança", 500

        dados = res.data

        if not dados:
            return "Cobrança não encontrada no banco", 404

    except Exception as e:
        print("Exceção ao buscar cobrança no Supabase:", e)
        return "Erro ao buscar cobrança", 500

    # Buscar também na API do Sicoob para validar status
    try:
        token = get_access_token()
        cobranca_api = buscar_cobranca(txid, token)
        if cobranca_api is None:
            print("Cobrança não encontrada via API Sicoob para TXID:", txid)
        else:
            print("Cobrança encontrada via API Sicoob:", cobranca_api)
    except Exception as e:
        print("Erro ao buscar cobrança via API Sicoob:", e)
        cobranca_api = None

    return render_template(
        "pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid,
        VALOR=dados.get("valor", "0.00"),
        COBRANCA_API=cobranca_api  # Se quiser usar no template
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    try:
        res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()

        if res.status_code != 200:
            print("Erro ao buscar status no Supabase:", res.status_code, res.data)
            return jsonify({"status": "ERRO"}), 500

        if not res.data:
            return jsonify({"status": "NAO_ENCONTRADO"}), 404

        return jsonify({"status": res.data["status"]})
    except Exception as e:
        print("Exceção ao buscar status:", e)
        return jsonify({"status": "ERRO"}), 500

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json()
    if not data or "pix" not in data:
        return jsonify({"error": "JSON inválido"}), 400

    txid = data["pix"][0].get("txid")
    if not txid:
        return jsonify({"error": "txid ausente"}), 400

    try:
        res = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
        if res.status_code != 200:
            print("Erro ao atualizar status no Supabase:", res.status_code, res.data)
    except Exception as e:
        print("Erro ao atualizar status:", e)

    return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
