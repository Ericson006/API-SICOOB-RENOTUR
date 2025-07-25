import fetch from 'node-fetch';

const PING_URL = process.env.APP_URL; // URL do seu serviço principal
const INTERVAL = 240000; // 4 minutos (menor que o timeout do Render)

setInterval(() => {
  fetch(`${PING_URL}/health`)
    .catch(() => console.log('Keepalive ping failed'));
}, INTERVAL);
