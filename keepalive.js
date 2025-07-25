import fetch from 'node-fetch';

const PING_URL = process.env.APP_URL || 'http://localhost:3000';
const INTERVAL = 240000; // 4 minutos (menor que o timeout do Render)

async function ping() {
  try {
    const start = Date.now();
    const res = await fetch(`${PING_URL}/health`);
    const data = await res.json();
    console.log(`Ping successful (${Date.now() - start}ms):`, data.status);
  } catch (err) {
    console.error('Ping failed:', err.message);
  }
  setTimeout(ping, INTERVAL);
}

ping();
