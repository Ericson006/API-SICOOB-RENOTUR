import os
from flask import Flask, render_template, jsonify, request
import requests
import qrcode
import uuid
from supabase import create_client, Client

# Certificados armazenados no secret files do render
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL = "https://api.sicoob.com.br/pix/api/v2/cob"

# Configurações Supabase (variáveis de ambiente)
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

print("SUPABASE_URL:", SUPABASE_URL)
print("SUPABASE_KEY:", (SUPABASE_KEY[:6] + "...") if SUPABASE_KEY else None)

# Cria cliente Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")

# Garante pasta para armazenar QR Codes localmente
os.makedirs("static/qrcodes", exist_ok=True)

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

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        # Recebe JSON com valor, se enviado; senão usa padrão
        dados = request.get_json(silent=True) or {}
        valor = dados.get("valor", "140.00")
        solicitacao = dados.get("solicitacao", "Pagamento referente a compra da passagem")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": str(valor)},
            "chave": "04763318000185",
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

        # Inserir no Supabase, tratando erros com raise_for_status()
        result = supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE",
            "valor": valor,
            "chave_pix": "04763318000185",
        }).execute()
        try:
            result.raise_for_status()
        except Exception as e:
            print("Erro ao inserir cobrança:", e)

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        return jsonify({"error": f"HTTP {resp.status_code}", "detail": detail}), resp.status_code

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    try:
        res.raise_for_status()
    except Exception as e:
        print("Erro ao buscar cobrança:", e)
        return "Erro ao buscar cobrança", 500

    if not res.data:
        return "Cobrança não encontrada", 404

    dados = res.data
    qrcode_img = f"/static/qrcodes/{txid}.png"

    return render_template(
        "pix_template.html",
        QRCODE_IMG=qrcode_img,
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid,
        VALOR=dados.get("valor", "0.00")
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    try:
        res.raise_for_status()
    except Exception as e:
        print("Erro ao buscar status:", e)
        return jsonify({"status": "ERRO"}), 500

    if not res.data:
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

    result = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
    try:
        result.raise_for_status()
    except Exception as e:
        print("Erro ao atualizar status no Supabase:", e)

    return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
