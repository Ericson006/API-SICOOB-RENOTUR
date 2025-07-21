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
def buscar_cobranca(txid, access_token):
    url = f"{COB_URL}/{txid}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    response = requests.get(url, headers=headers, cert=(CERT_FILE, KEY_FILE))
    if response.status_code == 200:
        return response.json()
    else:
        print(f"Erro ao buscar cobrança (TXID: {txid}):", response.status_code, response.text)
        return None

@app.route("/")
def index():
    return render_template("gerador_pix.html")

@app.route("/api/gerar_cobranca", methods=["POST"])
def api_gerar_cobranca():
    try:
        dados = request.get_json(silent=True) or {}
        valor = float(dados.get("valor", "140.00"))
        solicitacao = dados.get("solicitacao", "Pagamento referente à compra da passagem")

        token = get_access_token()
        txid = uuid.uuid4().hex.upper()[:32]
        print(f"Gerando cobrança TXID={txid} valor={valor:.2f}")

        payload = {
            "calendario": {"expiracao": 3600},
            "valor": {"original": f"{valor:.2f}"},
            "chave": CHAVE_PIX,
            "solicitacaoPagador": solicitacao,
            "txid": txid
        }

        # Criar cobrança na API Sicoob
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

        # Salvar no Supabase
        try:
            res = supabase.table("cobrancas").insert({
                "txid": txid,
                "brcode": brcode,
                "status": "PENDENTE",
                "valor": valor,
                "chave_pix": CHAVE_PIX,
                "descricao": solicitacao
            }).execute()
            dados_res = res.data
            if not dados_res:
                print("Erro: resposta vazia ao inserir no Supabase")
                return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500
        except Exception as e:
            print("Erro ao salvar cobrança no Supabase:", e)
            return jsonify({"error": "Erro ao salvar cobrança no banco"}), 500

        return jsonify({"txid": txid, "link_pix": f"/pix/{txid}"})

    except requests.exceptions.HTTPError as http_err:
        resp = http_err.response
        try:
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.json()
            }), resp.status_code
        except Exception:
            return jsonify({
                "error": f"HTTP {resp.status_code}",
                "detail": resp.text
            }), resp.status_code
    except Exception as e:
        print("Erro na geração da cobrança:", e)
        return jsonify({"error": str(e)}), 500

@app.route("/pix/<txid>")
def pix_page(txid):
    print(f"Buscando cobrança para TXID: {txid}")

    if not validar_txid(txid):
        return "TXID inválido", 400

    try:
        res = supabase.table("cobrancas").select("*").eq("txid", txid).single().execute()
        dados = res.data
        if not dados:
            return "Cobrança não encontrada no banco", 404
    except Exception as e:
        print("Erro ao buscar cobrança no Supabase:", e)
        return "Erro ao buscar cobrança", 500

    # Buscar também na API do Sicoob para validar status
    try:
        token = get_access_token()
        cobranca_api = buscar_cobranca(txid, token)
        if cobranca_api is None:
            print("Cobrança não encontrada via API Sicoob para TXID:", txid)
        else:
            print("Cobrança encontrada via API Sicoob:", cobranca_api)
    except Exception as e:
        print("Erro ao buscar cobrança via API Sicoob:", e)
        cobranca_api = None

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
    try:
        res = supabase.table("cobrancas").select("status").eq("txid", txid).single().execute()
        dados = res.data
        if not dados:
            return jsonify({"status": "NAO_ENCONTRADO"}), 404
        return jsonify({"status": dados["status"]})
    except Exception as e:
        print("Erro ao buscar status no Supabase:", e)
        return jsonify({"status": "ERRO"}), 500

@app.route("/webhook/pix", methods=["POST"])
def webhook_pix():
    data = request.get_json(silent=True)
    print("📥 Webhook recebido (raw):", data)

    if not data:
        print("⚠️ JSON inválido recebido no webhook")
        return jsonify({"error": "JSON inválido"}), 400

    txid = None
    if isinstance(data.get("pix"), list) and data["pix"]:
        txid = data["pix"][0].get("txid")
    elif data.get("txid"):
        txid = data.get("txid")

    print(f"🔍 txid bruto extraído: {txid!r}")

    if not txid:
        print("⚠️ txid ausente no webhook")
        return jsonify({"error": "txid ausente"}), 400

    txid = txid.strip().upper()
    print(f"✅ txid normalizado: {txid!r}")

    try:
        res_check = supabase.table("cobrancas") \
            .select("txid") \
            .eq("txid", txid) \
            .single() \
            .execute()
        print("🔎 Supabase check:", res_check.data)

        if not res_check.data:
            print("⚠️ txid não encontrado no banco:", txid)
            return jsonify({"error": "txid não encontrado"}), 404

        res_update = supabase.table("cobrancas") \
            .update({"status": "CONCLUIDO"}) \
            .eq("txid", txid) \
            .execute()
        print("✏️ Supabase update:", res_update.data)

    except Exception as e:
        print("❌ Erro durante operação no Supabase:", e)
        return jsonify({"error": "Erro interno ao atualizar status"}), 500

    print(f"🎉 Status atualizado para CONCLUIDO no txid {txid}")
    return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
