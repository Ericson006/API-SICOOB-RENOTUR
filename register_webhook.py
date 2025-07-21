import requests, os, json

# Reaproveita seus certificados e credenciais
CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE  = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"

def get_access_token():
    payload = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "scope": "cob.write cob.read pix.read webhook.read webhook.write"
    }
    resp = requests.post(
        TOKEN_URL,
        data=payload,
        headers={"Content-Type":"application/x-www-form-urlencoded"},
        cert=(CERT_FILE, KEY_FILE)
    )
    resp.raise_for_status()
    return resp.json()["access_token"]

def register_webhook(chave_pix, webhook_url):
    token = get_access_token()
    url = f"https://api.sicoob.com.br/pix/api/v2/webhook/{chave_pix}"
    body = {"webhookUrl": webhook_url}
    resp = requests.put(
        url,
        json=body,
        headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
        cert=(CERT_FILE, KEY_FILE)
    )
    try:
        resp.raise_for_status()
        print("✅ Webhook registrado com sucesso!")
        print(json.dumps(resp.json(), indent=2))
    except requests.HTTPError:
        print("❌ Falha ao registrar webhook:")
        print(resp.status_code, resp.text)

if __name__ == "__main__":
    # Substitua pela sua chave Pix (CNPJ ou TXID)
    CHAVE_PIX = "04763318000185"
    # Sua URL pública de callback:
    WEBHOOK_URL = "https://api-sicoob-renotur.onrender.com/webhook"
    register_webhook(CHAVE_PIX, WEBHOOK_URL)
