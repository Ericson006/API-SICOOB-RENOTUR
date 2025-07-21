import requests, uuid

CERT_FILE = "/etc/secrets/certificado.pem"
KEY_FILE  = "/etc/secrets/chave-privada-sem-senha.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

def get_access_token():
    payload = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "scope": "cob.write cob.read pix.read webhook.read webhook.write"
    }
    resp = requests.post(
        TOKEN_URL, data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        cert=(CERT_FILE, KEY_FILE), timeout=15
    )
    resp.raise_for_status()
    return resp.json()["access_token"]

def gera_cobranca_pix(valor_reais: float):
    token = get_access_token()
    txid = uuid.uuid4().hex.upper()[:32]

    valor_str = f"{valor_reais:.2f}"
    payload = {
        "calendario": {"expiracao": 3600},
        "valor": {"original": valor_str},
        "chave": "04763318000185",
        "solicitacaoPagador": "Pagamento referente à compra da passagem",
        "txid": txid
    }

    resp = requests.post(
        COB_URL, json=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        cert=(CERT_FILE, KEY_FILE), timeout=15
    )
    resp.raise_for_status()

    d = resp.json()
    link = d.get("location")
    brcode = d.get("brcode")

    if not link or not brcode:
        raise RuntimeError("Resposta incompleta da API")

    return {
        "link_pix": (link if link.startswith("http") else f"https://{link}"),
        "brcode": brcode
    }
