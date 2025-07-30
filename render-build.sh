#!/usr/bin/env bash
# Atualiza pacotes e instala Chromium para Puppeteer
apt-get update
apt-get install -y chromium-browser chromium-browser-l10n chromium-codecs-ffmpeg

# Exporta caminho do Chromium para Puppeteer
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Instala dependências Node
npm install
