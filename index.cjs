import dotenv from 'dotenv';
import qrcode from 'qrcode-terminal';
import { createClient } from '@supabase/supabase-js';
import {
  makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

// === Carrega variáveis do .env ===
dotenv.config();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// === Conecta ao Supabase ===
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Autenticação persistente do WhatsApp ===
const { state, saveState } = useSingleFileAuthState('./auth.json');

async function startBot() {
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,          // 🚫 Não sincroniza mensagens antigas
    markOnlineOnConnect: false,      // 🚫 Não marca online
    getMessage: async () => undefined
  });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão encerrada, reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado ao WhatsApp!');
      escutarSupabase(sock);
    }
  });
}

// === Escuta atualizações no Supabase ===
function escutarSupabase(sock) {
  supabase
    .channel('pagamentos-channel')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'pagamentos',
        filter: 'status=eq.concluido',
      },
      async (payload) => {
        const pagamento = payload.new;

        if (pagamento.mensagem_enviada) return;

        const numero = pagamento.telefone_cliente.replace(/\D/g, '') + '@s.whatsapp.net';
        const mensagem =
          pagamento.mensagem_confirmação?.trim()?.length > 0
            ? pagamento.mensagem_confirmação
            : '✅ Pagamento confirmado! Obrigada 🙏';

        try {
          await sock.sendMessage(numero, { text: mensagem });
          console.log('📤 Mensagem enviada para:', numero);

          await supabase
            .from('pagamentos')
            .update({ mensagem_enviada: true })
            .eq('txid', pagamento.txid);
        } catch (err) {
          console.error('⚠️ Erro ao enviar mensagem:', err);
        }
      }
    )
    .subscribe((status) => {
      console.log('🟢 Supabase Realtime conectado:', status);
    });
}

startBot();
