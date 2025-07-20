from flask import Flask, render_template, jsonify, request
import requests, qrcode, os, json, uuid

# Certificado e endpoints
CERT_FILE = "certs/certificado.pem"
KEY_FILE  = "certs/chave-privada.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

app = Flask(__name__, template_folder="templates", static_folder="static")

# Garante pastas
os.makedirs("cobrancas", exist_ok=True)
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
        return render_template(
            "pix_template.html",
            QRCODE_IMG=dados["qrcode_img"],
            PIX_CODE=dados["pix_copia_cola"]
        )
    except FileNotFoundError:
        return "Cobrança não encontrada",404
    
@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json()
    print("🔔 Webhook recebido:", data)

    # Aqui você pode processar os dados recebidos, por exemplo:
    txid = data.get("txid")
    valor = data.get("valor", {}).get("original")
    status = data.get("status")

    # Exemplo: salvar confirmação em um banco de dados ou marcar como pago
    # salvar_pagamento_confirmado(txid, valor, status)

    return jsonify({"status": "ok"}), 200

@app.route('/webhook-pix', methods=['POST'])
def webhook_pix():
    data = request.json
    txid = data.get('txid')
    status = data.get('status')
    pagador = data.get('pagador', {})
    nome = pagador.get('nome')
    cpf = pagador.get('cpf')

    if status == 'CONCLUIDA':
        print(f"Cobrança {txid} foi paga por {nome} (CPF: {cpf})")
        # Aqui você pode salvar o status no banco ou arquivo

    return '', 200


if __name__=="__main__":
    app.run(debug=True)
