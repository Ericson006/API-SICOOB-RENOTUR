import requests
import uuid
import json
import qrcode
from PIL import Image
import os

def gerar_pix(nome, valor):
    txid = str(uuid.uuid4())[:32]
    payload = {
        "calendario": {"expiracao": 3600},
        "devedor": {"nome": nome},
        "valor": {"original": f"{valor:.2f}"},
        "chave": "sua-chave-pix-aqui",
        "solicitacaoPagador": "Pagamento via Pix",
        "infoAdicionais": []
    }

    headers = {
        "Authorization": "Bearer seu-token-aqui",
        "Content-Type": "application/json"
    }

    response = requests.post(
        "https://api.sicoob.com.br/pix/api/v2/cob",
        json=payload,
        headers=headers,
        cert=("certificado.pem", "chave.key")  # cert e key
    )

    if response.status_code != 201:
        raise Exception(f"Erro ao gerar cobrança: {response.text}")

    data = response.json()
    txid = data["txid"]
    pix_copia_cola = data["loc"]["id"]

    # Gera QR Code
    payload_qr = requests.get(
        f"https://api.sicoob.com.br/pix/api/v2/loc/{pix_copia_cola}/qrcode",
        headers=headers,
        cert=("certificado.pem", "chave.key")
    ).json()

    codigo_qr = payload_qr["qrcode"]
    imagem_qr = qrcode.make(codigo_qr)

    os.makedirs("static/qrcodes", exist_ok=True)
    caminho_imagem = f"static/qrcodes/{txid}.png"
    imagem_qr.save(caminho_imagem)

    # Salva cobrança
    os.makedirs("cobrancas", exist_ok=True)
    with open(f"cobrancas/{txid}.json", "w") as f:
        json.dump({
            "txid": txid,
            "pix_copia_cola": codigo_qr,
            "qrcode_img": "/" + caminho_imagem
        }, f)

    return txid, codigo_qr, caminho_imagem
