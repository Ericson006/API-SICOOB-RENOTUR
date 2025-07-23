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

def validar_txid(txid):
    ok = bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))
    print(f"[validar_txid] {txid} → {ok}")
    return ok

def validar_telefone(telefone: str) -> bool:
    # Remove espaços, traços e parênteses
    telefone = re.sub(r'[\s\-\(\)]', '', telefone)

    # Verifica se tem apenas dígitos e se tem entre 10 e 13 caracteres (com DDI)
    return telefone.isdigit() and 10 <= len(telefone) <= 13

def enviar_msg_whatsapp(telefone: str, mensagem: str):
    url_bot_api = os.getenv("BOT_WHATSAPP_API_URL", "http://localhost:3000/enviar")
    params = {"numero": telefone, "mensagem": mensagem}
    try:
        resp = requests.get(url_bot_api, params=params, timeout=10)
        resp.raise_for_status()
        print(f"[WhatsApp] Mensagem enviada para {telefone}")
    except Exception as e:
        print(f"[WhatsApp] Falha ao enviar mensagem para {telefone}: {e}")

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
@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    dados = request.json or {}
    valor = float(dados.get("valor", 140.00))
    solicit = dados.get("solicitacao", "")
    telefone = dados.get("telefone_cliente", None)  # novo campo telefone
    
    # Validação simples do telefone (você deve definir a função validar_telefone)
    if telefone and not validar_telefone(telefone):
        return jsonify({"erro": "Telefone inválido"}), 400

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
                         headers={"Authorization": f"Bearer {token}"},
                         cert=(CERT_FILE, KEY_FILE))
    resp.raise_for_status()
    brcode = resp.json().get("brcode")

    img = qrcode.make(brcode)
    img_path = f"static/qrcodes/{txid}.png"
    img.save(img_path)

    dados_insert = {
        "txid": txid,
        "brcode": brcode,
        "status": "PENDENTE",
        "valor": valor,
        "chave_pix": CHAVE_PIX,
        "descricao": solicit
    }

    if telefone:
        dados_insert["telefone_cliente"] = telefone

    supabase.table("cobrancas").insert(dados_insert).execute()

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

        # Buscar dados da cobrança com base no txid
        response = supabase.table("cobrancas").select("telefone_cliente").eq("txid", txid).execute()

        if response.data and len(response.data) > 0:
            telefone_cliente = response.data[0].get("telefone_cliente")
            if telefone_cliente:
                # Aqui, a mensagem pode ser customizada
                mensagem = f"Olá! Seu pagamento via PIX foi confirmado com sucesso. Obrigado por comprar com a Renotur. 🚌✨"

                # Enviar para o bot WhatsApp (a função será criada no próximo passo)
                enviar_msg_whatsapp(telefone_cliente, mensagem)
        if status_sicoob == "CONCLUIDA":
            upd = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
            print("[webhook_pix] Supabase atualizado:", upd)
        
            # Buscar telefone do cliente da cobrança
            rec = supabase.table("cobrancas").select("telefone_cliente, valor").eq("txid", txid).single().execute()
            telefone = rec.data.get("telefone_cliente") if rec.data else None
            valor = rec.data.get("valor") if rec.data else None
        
            if telefone:
                mensagem = f"Olá! Seu pagamento no valor de R$ {valor:.2f} foi confirmado. Obrigado por comprar com a Renotur! 🚌✨"
                enviar_msg_whatsapp(telefone, mensagem)
        
            return "", 200


# ——— MAIN ———

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)

