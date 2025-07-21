from flask import Flask, render_template, jsonify, request
import requests, qrcode, os, json, uuid
from supabase import create_client, Client

# Certificados armazenados no secret files do render
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

# Inicializa supabase com as variáveis de ambiente
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")

# Garante pastas para QR codes
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

def salvar_cobranca_supabase(txid, brcode, status="PENDENTE"):
    data = {
        "txid": txid,
        "brcode": brcode,
        "status": status
    }
    response = supabase.table("cobrancas").insert(data).execute()
    if response.error:
        print("Erro ao salvar cobrança no Supabase:", response.error)
        return False
    return True

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
    loc    = d["location"]
    link   = loc if loc.startswith("http") else "https://"+loc

    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    sucesso = salvar_cobranca_supabase(txid, brcode)
    if not sucesso:
        raise Exception("Falha ao salvar cobrança no banco")

    return txid

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

        sucesso = salvar_cobranca_supabase(txid, brcode)
        if not sucesso:
            return jsonify({"error": "Falha ao salvar cobrança no banco"}), 500

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
    # Busca cobrança no supabase
    response = supabase.table("cobrancas").select("*").eq("txid", txid).execute()
    if response.error:
        return f"Erro ao buscar cobrança: {response.error}", 500
    dados_list = response.data
    if not dados_list:
        return "Cobrança não encontrada", 404
    dados = dados_list[0]

    status = dados.get("status", "PENDENTE")

    dados_template = {
        "qrcode_img": f"/static/qrcodes/{txid}.png",
        "pix_copia_cola": dados["brcode"]
    }

    return render_template("pix_template.html",
        QRCODE_IMG=dados_template["qrcode_img"],
        PIX_CODE=dados_template["pix_copia_cola"],
        STATUS=status,
        TXID=txid
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    response = supabase.table("cobrancas").select("status").eq("txid", txid).execute()
    if response.error:
        return jsonify({"error": str(response.error)}), 500
    data = response.data
    if not data:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404
    return jsonify({"status": data[0]["status"]})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json()
    if not data or "pix" not in data:
        return jsonify({"error": "JSON inválido"}), 400
    pagamento = data["pix"][0]
    txid = pagamento.get("txid")
    status = "CONCLUIDO"
    response = supabase.table("cobrancas").update({"status": status}).eq("txid", txid).execute()
    if response.error:
        return jsonify({"error": f"Falha ao atualizar status: {response.error}"}), 500
    return "", 200

if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT",5000))
    app.run(host='0.0.0.0', port=port, debug=True)
