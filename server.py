from flask import Flask, request, render_template, redirect, url_for
from gera_pix import gerar_pix
import json
import os

app = Flask(__name__)

@app.route("/", methods=["GET", "POST"])
def gerar():
    if request.method == "POST":
        nome = request.form["nome"]
        valor = float(request.form["valor"])
        txid, copia_cola, imagem_qr = gerar_pix(nome, valor)
        return redirect(url_for("resultado", txid=txid))
    return render_template("gerador_pix.html")

@app.route("/resultado/<txid>")
def resultado(txid):
    try:
        with open(f"cobrancas/{txid}.json") as f:
            dados = json.load(f)
    except FileNotFoundError:
        return "Cobrança não encontrada", 404
    return render_template("pix_template.html", dados=dados)

if __name__ == "__main__":
    app.run()
