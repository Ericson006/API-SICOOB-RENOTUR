import requests
import json

# Certificados e credenciais
CERT_FILE = "/etc/secrets/certificado.pem"  # caminho para seu certificado .pem
KEY_FILE  = "/etc/secrets/chave-privada-sem-senha.pem"  # caminho para sua chave privada
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"  # seu client_id da API
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"

def get_access_token():
    """
    Obtém o token de acesso OAuth2 via client credentials
    """
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
    """
    Registra um webhook para uma chave Pix no Sicoob via API

    Args:
        chave_pix (str): chave Pix (CNPJ, CPF ou TXID)
        webhook_url (str): URL pública para receber notificações

    Retorna:
        None
    """
    token = get_access_token()
    url = f"https://api.sicoob.com.br/pix/api/v2/webhook/{chave_pix}"
    body = {"webhookUrl": webhook_url}
    
    resp = requests.put(
        url,
        json=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        cert=(CERT_FILE, KEY_FILE)
    )
    
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        print(f"❌ Falha ao registrar webhook: HTTP {resp.status_code}")
        print(resp.text)
        raise e

    # Tenta ler JSON, mas pode não ter conteúdo (ex: 204 No Content)
    try:
        data = resp.json()
        print("✅ Webhook registrado com sucesso! Resposta da API:")
        print(json.dumps(data, indent=2))
    except ValueError:
        # Se não vier JSON, imprime texto bruto
        print("✅ Webhook registrado com sucesso! (sem corpo JSON)")
        print(f"Status HTTP: {resp.status_code}")
        print("Resposta da API:", resp.text or "<vazio>")

if __name__ == "__main__":
    # Substitua pela sua chave Pix (CNPJ, CPF ou TXID)
    CHAVE_PIX = "04763318000185"
    # Substitua pela sua URL pública para receber webhook
    WEBHOOK_URL = "https://api-sicoob-renotur.onrender.com/webhook/pix"
    
    print(f"Registrando webhook para chave {CHAVE_PIX} na URL {WEBHOOK_URL}")
    register_webhook(CHAVE_PIX, WEBHOOK_URL)
