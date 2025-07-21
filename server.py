import os
import requests
import uuid
import qrcode
import re
from flask import Flask, render_template, jsonify, request
from supabase import create_client, Client

# === CONFIGURAÇÕES ===
CERT_FILE    = "/etc/secrets/certificado.pem"
KEY_FILE     = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID    = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL    = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL      = "https://api.sicoob.com.br/pix/api/v2/cob"
CHAVE_PIX    = "04763318000185"

# Supabase (variáveis de ambiente no Render)
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

@app.route("/")
def index():
    return render_template("gerador_pix.html")

# === GERAR COBRANÇA ===
@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        dados = request.get_json(silent=True) or {}
        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        app.logger.info(f"gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid
        }

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

        result = supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE",
            "valor": valor,
            "chave_pix": CHAVE_PIX
        }).execute()
        if result.error:
            app.logger.error("Erro ao inserir no Supabase: %s", result.error)

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            detail = resp.json()
        except:
            detail = resp.text
        return jsonify({"error": f"HTTP {resp.status_code}", "detail": detail}), resp.status_code

    except Exception as e:
        app.logger.exception("Erro inesperado em gerar_cobranca")
        return jsonify({"error": str(e)}), 500

# === PÁGINA PIX ===
@app.route("/pix/<txid>")
def pix_page(txid):
    app.logger.info(f"exibindo cobrança TXID={txid}")

    if not validar_txid(txid):
        return "TXID inválido", 400

    res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    if res.error or not res.data:
        app.logger.error("Cobrança não encontrada no Supabase: %s", res.error)
        return "Cobrança não encontrada", 404

    dados = res.data
    return render_template(
        "pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid,
        VALOR=f"{dados.get('valor', 0):.2f}"
    )

# === STATUS VIA AJAX ===
@app.route("/api/status/<txid>")
def api_status(txid):
    res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    if res.error or not res.data:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404
    return jsonify({"status": res.data["status"]})

# === WEBHOOK PIX ===
@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json()
    if not data or "pix" not in data:
        return jsonify({"error": "JSON inválido"}), 400

    txid = data["pix"][0].get("txid")
    if not txid:
        return jsonify({"error": "txid ausente"}), 400

    upd = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
    if upd.error:
        app.logger.error("Erro ao atualizar status no Supabase: %s", upd.error)

    return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=True)

