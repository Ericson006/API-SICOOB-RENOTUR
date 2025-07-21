from flask import Flask, render_template, jsonify, request
import requests, qrcode, os, json, uuid
from supabase import create_client, Client
from datetime import datetime

# Certificados armazenados no secret files do render
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

# Configurações Supabase - coloque as variáveis de ambiente no Render ou local
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")

# Garante pastas locais para qrcodes
os.makedirs("static/qrcodes", exist_ok=True)

def get_access_token():
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type":"client_credentials",
            "client_id":CLIENT_ID,
            "scope":"cob.write cob.read pix.read webhook.read webhook.write"
        },
        headers={"Content-Type":"application/x-www-form-urlencoded"},
        cert=(CERT_FILE,KEY_FILE)
    )
    resp.raise_for_status()
    return resp.json()["access_token"]

def cria_cobranca_e_salva():
    token = get_access_token()
    txid  = uuid.uuid4().hex.upper()[:32]
    payload = {
      "calendario": {"expiracao":3600},
      "valor":      {"original":"140.00"},
      "chave":      "04763318000185",
      "solicitacaoPagador":"Pagamento referente a compra da passagem",
      "txid":       txid
    }
    resp = requests.post(
        COB_URL,
        json=payload,
        headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
        cert=(CERT_FILE,KEY_FILE)
    )
    resp.raise_for_status()
    d = resp.json()

    brcode = d["brcode"]

    # Gerar QR code e salvar imagem local
    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    # Salvar no Supabase
    supabase.table("cobrancas").insert({
        "txid": txid,
        "brcode": brcode,
        "status": "PENDENTE",
        "created_at": datetime.utcnow()
    }).execute()

    return txid, img_path, brcode

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        token = get_access_token()
        txid  = uuid.uuid4().hex.upper()[:32]
        payload = {
            "calendario": {"expiracao":3600},
            "valor": {"original":"140.00"},
            "chave": "04763318000185",
            "solicitacaoPagador": "Pagamento referente a compra da passagem",
            "txid": txid
        }
        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        resp.raise_for_status()
        d = resp.json()

        brcode = d["brcode"]
        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)

        # Salvar no Supabase
        supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE",
            "created_at": datetime.utcnow()
        }).execute()

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try: detail = resp.json()
        except: detail = resp.text
        return jsonify({"error": f"HTTP {resp.status_code}", "detail": detail}), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    # Buscar cobrança no Supabase
    res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    if res.error or res.data is None:
        return "Cobrança não encontrada", 404

    dados = res.data

    # Monta o caminho do qr code local
    qrcode_img = f"/static/qrcodes/{txid}.png"

    return render_template("pix_template.html",
        QRCODE_IMG=qrcode_img,
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    if res.error or res.data is None:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404
    return jsonify({"status": res.data["status"]})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json()
    if not data or "pix" not in data:
        return jsonify({"error": "JSON inválido"}), 400
    pagamento = data["pix"][0]
    txid = pagamento.get("txid")
    if not txid:
        return jsonify({"error": "txid ausente"}), 400

    # Atualizar status para CONCLUIDO no Supabase
    supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()

    return "", 200

if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT",5000))
    app.run(host='0.0.0.0', port=port, debug=True)
