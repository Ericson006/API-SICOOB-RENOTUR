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
WEBHOOK_MANAGE_URL = "https://api.sicoob.com.br/pix/api/v1/webhook"
CHAVE_PIX = "04763318000185"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api-sicoob-renotur.onrender.com")

# Cria cliente Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = Flask(__name__, template_folder="templates", static_folder="static")
os.makedirs("static/qrcodes", exist_ok=True)

# === Funções utilitárias ===

def get_access_token():
    print("[get_access_token] Solicitando token de acesso...")
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
    print(f"[get_access_token] Resposta status: {resp.status_code}")
    resp.raise_for_status()
    token = resp.json().get("access_token")
    print(f"[get_access_token] Token obtido, tamanho={len(token) if token else 0}")
    return token

def register_sicoob_webhook():
    """Registra (ou revalida) o webhook na API de webhooks do Sicoob."""
    token = get_access_token()
    payload = {"webhookUrl": f"{BASE_URL}/webhook/pix"}
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    print(f"[register_webhook] Registrando webhook no Sicoob: {payload['webhookUrl']}")
    resp = requests.post(
        WEBHOOK_MANAGE_URL,
        json=payload,
        headers=headers,
        cert=(CERT_FILE, KEY_FILE)
    )
    print(f"[register_webhook] status {resp.status_code} — {resp.text}")
    resp.raise_for_status()

def validar_txid(txid):
    valid = bool(re.fullmatch(r"[A-Za-z0-9]{26,35}", txid))
    print(f"[validar_txid] TXID='{txid}' válido? {valid}")
    return valid

def buscar_cobranca(txid, access_token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    print(f"[buscar_cobranca] Consultando cobrança TXID={txid}")
    response = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    print(f"[buscar_cobranca] Resposta status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"[buscar_cobranca] Dados da cobrança: {data}")
        return data
    else:
        print(f"[buscar_cobranca] Erro ao buscar cobrança (TXID: {txid}): {response.status_code} {response.text}")
        return None

# === Rotas ===

@app.route("/")
def index():
    print("[index] Página inicial acessada")
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        dados = request.get_json(silent=True) or {}
        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")
        print(f"[api_gerar_cobranca] Dados recebidos: valor={valor}, solicitacao='{solicitacao}'")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        print(f"[api_gerar_cobranca] Gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid,
            "webhookUrl": f"{BASE_URL}/webhook/pix"
        }
        print(f"[api_gerar_cobranca] Payload para criação: {payload}")

        resp = requests.post(
            COB_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            cert=(CERT_FILE, KEY_FILE)
        )
        print(f"[api_gerar_cobranca] Status criação: {resp.status_code}")
        resp.raise_for_status()
        d = resp.json()
        print(f"[api_gerar_cobranca] JSON criação: {d}")

        brcode = d.get("brcode")
        if not brcode:
            print("[api_gerar_cobranca] ERRO: brcode ausente")
            return jsonify({"error": "Resposta incompleta da API"}), 500

        img = qrcode.make(brcode)
        img_path = f"static/qrcodes/{txid}.png"
        img.save(img_path)
        print(f"[api_gerar_cobranca] QR Code salvo: {img_path}")

        # Salvar no Supabase
        res = supabase.table("cobrancas").insert({
            "txid": txid,
            "brcode": brcode,
            "status": "PENDENTE",
            "valor": valor,
            "chave_pix": CHAVE_PIX,
            "descricao": solicitacao
        }).execute()
        print(f"[api_gerar_cobranca] Supabase insert result: {res}")
        if not res.data:
            print("[api_gerar_cobranca] ERRO: Sem dados retornados")
            return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

        print(f"[api_gerar_cobranca] Cobrança salva: {res.data}")
        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            print(f"[api_gerar_cobranca] HTTPError {resp.status_code}: {resp.json()}")
            return jsonify({"error": f"HTTP {resp.status_code}", "detail": resp.json()}), resp.status_code
        except Exception:
            print(f"[api_gerar_cobranca] HTTPError {resp.status_code}: {resp.text}")
            return jsonify({"error": f"HTTP {resp.status_code}", "detail": resp.text}), resp.status_code
    except Exception as e:
        print(f"[api_gerar_cobranca] Erro inesperado: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"[pix_page] Carregando PIX {txid}")
    if not validar_txid(txid):
        return "TXID inválido", 400

    res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
    dados = res.data
    print(f"[pix_page] Dados do banco: {dados}")
    token = get_access_token()
    cobranca_api = buscar_cobranca(txid, token) if dados else None

    return render_template(
        "pix_template.html",
        QRCODE_IMG=f"/static/qrcodes/{txid}.png",
        PIX_CODE=dados["brcode"],
        STATUS=dados.get("status", "PENDENTE"),
        TXID=txid,
        VALOR=dados.get("valor", "0.00"),
        COBRANCA_API=cobranca_api
    )

@app.route("/api/status/<txid>")
def api_status(txid):
    print(f"[api_status] Consultando status {txid}")
    res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
    dados = res.data
    print(f"[api_status] Resultado: {dados}")
    if not dados:
        return jsonify({"status": "NAO_ENCONTRADO"}), 404
    return jsonify({"status": dados["status"]})

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json(silent=True)
    print(f"[webhook_pix] Webhook recebido: {data}")
    if not data:
        return jsonify({"error": "JSON inválido"}), 400

    txid = None
    if "pix" in data and isinstance(data["pix"], list) and data["pix"]:
        txid = data["pix"][0].get("txid")
    elif data.get("txid"):
        txid = data["txid"]

    if not txid:
        return jsonify({"error": "txid ausente"}), 400

    print(f"[webhook_pix] Processando txid: {txid}")
    res_update = supabase.table("cobrancas").update({"status": "CONCLUIDO"}).eq("txid", txid).execute()
    print(f"[webhook_pix] Supabase update result: {res_update}")
    if not res_update.data:
        return jsonify({"error": "Erro ao atualizar status"}), 500

    print(f"[webhook_pix] Status atualizado para CONCLUIDO no txid {txid}")
    return "", 200

if __name__ == '__main__':
    # Registra webhook no Sicoob antes de iniciar
    try:
        register_sicoob_webhook()
    except Exception as e:
        print(f"[main] Falha ao registrar webhook: {e}")

    port = int(os.environ.get("PORT", 5000))
    print(f"[main] Iniciando servidor na porta {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
