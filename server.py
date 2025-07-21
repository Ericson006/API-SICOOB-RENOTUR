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

# variáveis de ambiente no Render
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
def buscar_cobranca(txid, token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    resp = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    if resp.status_code == 200:
        return resp.json()
    else:
        print(f"[WARN] cobrança não encontrada via API Sicoob ({resp.status_code}): {resp.text}")
        return None

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        body = request.get_json(silent=True) or {}
        valor = float(body.get("valor", 140.00))
        solicitacao = body.get("solicitacao", "Pagamento referente à compra da passagem")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        print(f"[INFO] gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid
        }

        # cria cobrança no Sicoob
        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        resp.raise_for_status()
        data = resp.json()

        brcode = data["brcode"]
        # gera QR code local
        img = qrcode.make(brcode)
        path = f"static/qrcodes/{txid}.png"
        img.save(path)

        # salva apenas o mínimo no Supabase
        supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE"
        }).execute()

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        r = http_err.response
        detail = r.json() if r.headers.get("Content-Type","").startswith("application/json") else r.text
        return jsonify({"error": f"HTTP {r.status_code}", "detail": detail}), r.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"[INFO] exibindo cobrança TXID={txid}")

    if not validar_txid(txid):
        return "TXID inválido", 400

    # busca dados no Supabase
    supa = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    if supa.error or not supa.data:
        return "Cobrança não encontrada no banco", 404
    reg = supa.data

    # busca detalhes na API Sicoob (para valor e descrição)
    token = get_access_token()
    detalhes = buscar_cobranca(txid, token) or {}
    valor = detalhes.get("valor", {}).get("original", "0.00")
    solicitacao = detalhes.get("solicitacaoPagador", "")

    return render_template(
        "pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=reg["brcode"],
        STATUS=reg["status"],
        TXID=txid,
        VALOR=valor,
        DESCRICAO=solicitacao
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    supa = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    if supa.error or not supa.data:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404
    return jsonify({"status": supa.data["status"]})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json() or {}
    pix_list = data.get("pix") or []
    if not pix_list or not pix_list[0].get("txid"):
        return jsonify({"error": "JSON inválido"}), 400

    txid = pix_list[0]["txid"]
    supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
    print(f"[INFO] webhook marcou TXID={txid} como CONCLUIDO")
    return "", 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
