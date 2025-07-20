import requests

CERT_FILE = "certs/certificado.pem"
KEY_FILE  = "certs/chave-privada.pem"
CLIENT_ID = "86849d09-141d-4c35-8e67-ca0ba9b0073a"
TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token"
COB_URL   = "https://api.sicoob.com.br/pix/api/v2/cob"

def get_access_token():
    payload = {
        "grant_type":"client_credentials",
        "client_id": CLIENT_ID,
        "scope":     "cob.write cob.read pix.read webhook.read webhook.write"
    }
    resp = requests.post(
        TOKEN_URL, data=payload,
        headers={"Content-Type":"application/x-www-form-urlencoded"},
        cert=(CERT_FILE, KEY_FILE), timeout=15
    )
    resp.raise_for_status()
    return resp.json()["access_token"]

def gera_cobranca_pix():
    token = get_access_token()
    payload = {
        "calendario": {"expiracao":3600},
        "valor":      {"original":"140.00"},
        "chave":      "04763318000185",
        "solicitacaoPagador":"Pagamento referente a compra da passagem"
    }
    resp = requests.post(
        COB_URL, json=payload,
        headers={"Authorization":f"Bearer {token}", "Content-Type":"application/json"},
        cert=(CERT_FILE, KEY_FILE), timeout=15
    )
    resp.raise_for_status()
    d = resp.json()
    loc = d.get("location"); br = d.get("brcode")
    if not loc or not br:
        raise RuntimeError("Resposta incompleta da API")
    link = loc if loc.startswith("http") else "https://"+loc
    return {"link_pix":link, "brcode":br}
