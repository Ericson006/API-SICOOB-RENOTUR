import { makeWASocket, useSingleFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import path from 'path';

const authFolder = './auth';
let sock = null;

async function connectWhatsApp() {
  try {
    const { state, saveState } = useSingleFileAuthState(path.join(authFolder, 'creds.json'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
      browser: ['Bot Pagamentos', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'close') {
        setTimeout(connectWhatsApp, 5000); // Reconexão rápida
      }
    });

    return sock;
  } catch (err) {
    console.error('WhatsApp connection error:', err.message);
    setTimeout(connectWhatsApp, 10000);
  }
}

export async function sendMessage(number, message) {
  if (!sock) throw new Error('WhatsApp not connected');
  const jid = number.replace(/\D/g, '') + '@s.whatsapp.net';
  return sock.sendMessage(jid, { text: message });
}

connectWhatsApp();
