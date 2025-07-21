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

# Supabase via env-vars
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

# — Helpers Pix API
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

def validar_txid(txid):
    return bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))

# — Endpoints
@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    dados = request.get_json(silent=True) or {}
    valor = float(dados.get("valor", "140.00"))
    solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")

    token = get_access_token()
    txid = uuid.uuid4().hex.upper()[:32]
    print(f"[GERAR] TXID={txid} valor={valor:.2f}")

    payload = {
        "calendario": {"expiracao": 3600},
        "valor": {"original": f"{valor:.2f}"},
        "chave": CHAVE_PIX,
        "solicitacaoPagador": solicitacao,
        "txid": txid
    }

    # 1) Cria no Sicoob
    resp = requests.post(
        COB_URL,
        json=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        cert=(CERT_FILE, KEY_FILE)
    )
    resp.raise_for_status()
    d = resp.json()

    brcode = d["brcode"]
    # 2) Gera QR local
    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    # 3) Insere no Supabase
    sb = supabase.table("cobrancas").insert({
        "txid": txid,
        "brcode": brcode,
        "status": "PENDENTE",
        "valor": valor,
        "chave_pix": CHAVE_PIX,
        "descricao": solicitacao
    }).execute()

    # sb.data é a lista de linhas inseridas
    if not sb.data or sb.error:
        print("[ERROR] Insert Supabase:", sb.error, sb.data)
        return jsonify({"error": "Falha ao salvar cobrança"}), 500

    return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"[PIX PAGE] TXID={txid}")
    if not validar_txid(txid):
        return "TXID inválido", 400

    sb = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    if sb.error:
        print("[ERROR] Query Supabase:", sb.error)
        return "Erro ao buscar cobrança", 500
    if not sb.data:
        return "Cobrança não encontrada", 404

    dados = sb.data
    return render_template("pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=dados["brcode"],
        STATUS=dados["status"],
        TXID=txid,
        VALOR=dados["valor"]
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    sb = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    if sb.error:
        print("[ERROR] Status Supabase:", sb.error)
        return jsonify({"status":"ERRO"}), 500
    if not sb.data:
        return jsonify({"status":"NAO_ENCONTRADO"}), 404
    return jsonify({"status": sb.data["status"]})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json(force=True)
    print("[WEBHOOK] recebido:", data)
    # extrai txid
    txid = None
    if isinstance(data.get("pix"), list) and data["pix"]:
        txid = data["pix"][0].get("txid")
    else:
        txid = data.get("txid")
    if not txid:
        return jsonify({"error":"txid ausente"}), 400
    print(f"[WEBHOOK] confirmando TXID={txid}")

    # garante que existe
    chk = supabase.table("cobrancas").select("txid").eq("txid", txid).single().execute()
    if chk.error or not chk.data:
        print("[WEBHOOK] txid não encontrado no DB")
        return jsonify({"error":"txid não existe"}), 404

    up = supabase.table("cobrancas").update({"status":"CONCLUIDO"}).eq("txid", txid).execute()
    if up.error or not up.data:
        print("[WEBHOOK] falha no update:", up.error, up.data)
        return jsonify({"error":"falha ao atualizar status"}), 500

    print(f"[WEBHOOK] status atualizado para CONCLUIDO no {txid}")
    return "", 204

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
