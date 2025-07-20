from flask import Flask, render_template, jsonify, request
import requests, qrcode, os, json, uuid

# Certificados armazenados no secret files do render
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

app = Flask(__name__, template_folder="templates", static_folder="static")

# Garante pastas
os.makedirs("cobrancas", exist_ok=True)
os.makedirs("static/qrcodes", exist_ok=True)

STATUS_DIR = "status_pagamentos"
os.makedirs(STATUS_DIR, exist_ok=True)

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
    txid  = str(uuid.uuid4())[:32]
    payload = {
      "calendario":{"expiracao":3600},
      "valor":{"original":"140.00"},
      "chave":"04763318000185",
      "solicitacaoPagador":"Pagamento referente a compra da passagem",
    }
    resp = requests.post(
        COB_URL,
        json=payload,
        headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
        cert=(CERT_FILE,KEY_FILE)
    )
    resp.raise_for_status()
    d = resp.json()
    # pega o brcode e location
    brcode = d["brcode"]
    loc    = d["location"]
    link   = loc if loc.startswith("http") else "https://"+loc

    # gera QR
    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    # grava JSON
    dados = {
        "qrcode_img": f"/static/qrcodes/{txid}.png",
        "pix_copia_cola": brcode
    }
    with open(f"cobrancas/{txid}.json","w",encoding="utf-8") as f:
        json.dump(dados,f,ensure_ascii=False)

    return txid

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        token = get_access_token()
        txid  = str(uuid.uuid4())[:32]
        payload = {
            "calendario": {"expiracao":3600},
            "valor": {"original":"140.00"},
            "chave": "04763318000185",
            "solicitacaoPagador": "Pagamento referente a compra da passagem",
        }
        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        resp.raise_for_status()
        d = resp.json()

        # extrai dados da resposta
        brcode = d["brcode"]
        loc = d["location"]
        link = loc if loc.startswith("http") else "https://" + loc

        # gera QR code
        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)

        # salva dados
        dados = {
            "qrcode_img": f"/static/qrcodes/{txid}.png",
            "pix_copia_cola": brcode
        }
        with open(f"cobrancas/{txid}.json", "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)

        return jsonify({
            "txid": txid,
            "link_pix": f"/pix/{txid}"
        })

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            detail = resp.json()
        except ValueError:
            detail = resp.text
        return jsonify({
            "error": f"HTTP {resp.status_code}",
            "detail": detail
        }), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    try:
        with open(f"cobrancas/{txid}.json","r",encoding="utf-8") as f:
            dados = json.load(f)
    except FileNotFoundError:
        return "Cobrança não encontrada",404

    status = "PENDENTE"
    try:
        with open(f"{STATUS_DIR}/{txid}.json", "r", encoding="utf-8") as f:
            status_data = json.load(f)
            status = status_data.get("status", "PENDENTE")
    except FileNotFoundError:
        pass  # Se não houver status, assume pendente

    return render_template(
        "pix_template.html",
        QRCODE_IMG=dados["qrcode_img"],
        PIX_CODE=dados["pix_copia_cola"],
        STATUS=status,
        TXID=txid  # <--- esta linha adicionada para frontend
    )
    
@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json()
    print("🔔 Webhook recebido:", data)

    txid = data.get("txid")
    status = data.get("status")

    if not txid:
        return jsonify({"error": "txid missing"}), 400

    with open(f"{STATUS_DIR}/{txid}.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    return jsonify({"status": "ok"}), 200

@app.route("/api/status/<txid>")
def api_status(txid):
    try:
        with open(f"{STATUS_DIR}/{txid}.json", "r", encoding="utf-8") as f:
            status_data = json.load(f)
        status = status_data.get("status", "PENDENTE")
        return jsonify({"status": status})
    except FileNotFoundError:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404

# Necessário para deploy no Render: usar host 0.0.0.0 e porta da variável de ambiente
if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT", 5000))  # Padrão 5000 localmente, mas Render sobrescreve
    app.run(host='0.0.0.0', port=port, debug=True)
