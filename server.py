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
WEBHOOK_MANAGE_URL = "https://api.sicoob.com.br/pix/api/v2/webhook"
CHAVE_PIX = "04763318000185"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api-sicoob-renotur.onrender.com")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

# ——— UTILITÁRIOS ———

def get_access_token():
    print("[get_access_token] Solicitando token...")
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
    token = resp.json().get("access_token")
    print(f"[get_access_token] Token recebido (len={len(token)})")
    return token

def register_sicoob_webhook():
    print("[register_sicoob_webhook] Iniciando registro do webhook...")  # print inicial
    token = get_access_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    try:
        resp_list = requests.get(WEBHOOK_MANAGE_URL, headers=headers, cert=(CERT_FILE, KEY_FILE))
        resp_list.raise_for_status()
        existing = resp_list.json()
        print("[register] Resposta completa do GET:", existing)
    except Exception as e:
        print(f"[register] Erro ao obter webhooks existentes: {e}")
        return

    desired = f"{BASE_URL}/webhook"
    print(f"[register] URL desejada para webhook: {desired}")

    # Se 'existing' for um dicionário com chave 'webhooks', por exemplo
    if isinstance(existing, dict) and "webhooks" in existing:
        webhooks = existing["webhooks"]
    elif isinstance(existing, list):
        webhooks = existing
    else:
        print("[register] Formato inesperado da resposta de webhooks.")
        return

    if not any(w.get("url") == desired for w in webhooks if isinstance(w, dict)):
        print(f"[register] Registrando webhook com URL: {desired}")
        payload = {"url": desired}
        try:
            resp = requests.post(WEBHOOK_MANAGE_URL, json=payload, headers=headers, cert=(CERT_FILE, KEY_FILE))
            print(f"[register] Registrando webhook: {desired} — status {resp.status_code}")
            resp.raise_for_status()
        except Exception as e:
            print(f"[register] Falha ao registrar webhook: {e}")
    else:
        print("[register] Webhook já registrado corretamente.")

def validar_txid(txid):
    ok = bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))
    print(f"[validar_txid] {txid} → {ok}")
    return ok

def buscar_cobranca(txid, token):
    url = f"{COB_URL}/{txid}"
    headers = { "Authorization": f"Bearer {token}", "Content-Type": "application/json" }
    resp = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    if resp.status_code == 200:
        data = resp.json()
        print(f"[buscar] Cobrança API Sicoob: {data}")
        return data
    print(f"[buscar] Erro {resp.status_code}: {resp.text}")
    return None

# ——— ROTAS ———

@app.before_request
def startup_tasks():
    print("🔧 Executando tarefas de inicialização...")
    try:
        register_sicoob_webhook()
        print("✅ Webhook registrado com sucesso!")
    except Exception as e:
        print("❌ Falha ao registrar webhook:", e)

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    dados = request.json or {}
    valor = float(dados.get("valor", 140.00))
    solicit = dados.get("solicitacao", "")
    token = get_access_token()
    txid = uuid.uuid4().hex.upper()[:32]

    payload = {
        "calendario": {"expiracao": 3600},
        "valor": {"original": f"{valor:.2f}"},
        "chave": CHAVE_PIX,
        "solicitacaoPagador": solicit,
        "txid": txid,
        "webhookUrl": f"{BASE_URL}/webhook"
    }
    resp = requests.post(COB_URL, json=payload,
                         headers={"Authorization":f"Bearer {token}"},
                         cert=(CERT_FILE, KEY_FILE))
    resp.raise_for_status()
    brcode = resp.json().get("brcode")

    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    supabase.table("cobrancas").insert({
        "txid": txid, "brcode": brcode,
        "status": "PENDENTE", "valor": valor,
        "chave_pix": CHAVE_PIX, "descricao": solicit
    }).execute()

    return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

@app.route("/pix/<txid>")
def pix_page(txid):
    if not validar_txid(txid):
        return "TXID inválido", 400
    rec = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute().data
    cobr = rec or {}
    token = get_access_token()
    api_data = buscar_cobranca(txid, token)
    return render_template("pix_template.html",
                           QRCODE_IMG=f"/static/qrcodes/{txid}.png",
                           PIX_CODE=cobr.get("brcode",""), STATUS=cobr.get("status"),
                           TXID=txid, VALOR=cobr.get("valor"), COBRANCA_API=api_data)

@app.route("/api/status/<txid>")
def api_status(txid):
    rec = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute().data
    return jsonify({"status": rec.get("status") if rec else "NAO_ENCONTRADO"})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json(silent=True)
    print("[webhook_pix] Webhook recebido:", data)
    txid = None
    if isinstance(data.get("pix"), list):
        txid = data["pix"][0].get("txid")
    elif data.get("txid"):
        txid = data["txid"]

    if not txid:
        print("[webhook_pix] txid ausente")
        return jsonify({"error":"txid ausente"}), 400

    # Confirma status via Sicoob
    try:
        token = get_access_token()
        cobranca = buscar_cobranca(txid, token)
        status_sicoob = cobranca.get("status") if cobranca else None
        print(f"[webhook_pix] Status via Sicoob: {status_sicoob}")

        if status_sicoob == "CONCLUIDA":
            upd = supabase.table("cobrancas") \
                          .update({"status":"CONCLUIDO"}) \
                          .eq("txid", txid).execute()
            print("[webhook_pix] Supabase atualizado:", upd)
            return "", 200
        else:
            print(f"[webhook_pix] Status não é CONCLUIDA ({status_sicoob})")
            return jsonify({"msg": f"Status não é CONCLUIDA: {status_sicoob}"}), 202

    except Exception as e:
        print(f"[webhook_pix] Erro ao confirmar status: {e}")
        return jsonify({"error": str(e)}), 500

# ——— MAIN ———

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)

