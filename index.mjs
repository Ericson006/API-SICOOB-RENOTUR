import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import {
  makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const authFolder = path.join(__dirname, 'auth');
const bucket = 'auth-session';

async function baixarAuthDoSupabase() {
  console.log('🔄 Baixando arquivos de autenticação do Supabase...');
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

  const { data, error } = await supabase.storage.from(bucket).list('', { limit: 100 });

  if (error) {
    console.error('❌ Erro ao listar arquivos de sessão:', error.message);
    return false;
  }

  for (const file of data) {
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(bucket)
      .createSignedUrl(file.name, 3600);
    if (signedUrlError) {
      console.error(`❌ Erro ao gerar URL para ${file.name}:`, signedUrlError.message);
      continue;
    }

    try {
      const res = await fetch(signedUrlData.signedUrl);
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(path.join(authFolder, file.name), Buffer.from(buffer));
      console.log(`⬇️  Arquivo baixado: ${file.name}`);
    } catch (fetchErr) {
      console.error(`❌ Erro ao baixar ${file.name}:`, fetchErr.message);
    }
  }

  console.log('✅ Arquivos de autenticação baixados.');
  return true;
}

async function testarConexaoTabelaPagamentos() {
  console.log('🔍 Testando conexão com a tabela "pagamentos"...');
  const { data, error } = await supabase.from('pagamentos').select('*').limit(3);

  if (error) {
    console.error('❌ Erro ao acessar tabela pagamentos:', error.message);
    return false;
  }

  console.log(`✅ Conexão OK. Exemplo de registros:`);
  console.log(data);
  return true;
}

async function startBot() {
  const authLoaded = await baixarAuthDoSupabase();
  if (!authLoaded) {
    console.warn('⚠️ Continuando sem arquivos de autenticação (login manual necessário).');
  }

  const { state, saveState } = useSingleFileAuthState('./auth/creds.json');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined
  });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão encerrada. Reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado ao WhatsApp!');
      escutarSupabase(sock);
    }
  });

  const conexaoOk = await testarConexaoTabelaPagamentos();
  if (!conexaoOk) {
    console.error('🚨 Falha na conexão com Supabase.');
  }
}

function escutarSupabase(sock) {
  console.log('🔔 Escutando tabela pagamentos via Supabase Realtime...');
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
        console.log('🔄 Evento recebido do Supabase:', payload);

        const pagamento = payload.new;
        if (pagamento.mensagem_enviada) {
          console.log('⚠️ Já notificado. Ignorando.');
          return;
        }

        const numero = pagamento.telefone_cliente.replace(/\D/g, '') + '@s.whatsapp.net';
        const mensagem = pagamento.mensagem_confirmação?.trim()?.length > 0
          ? pagamento.mensagem_confirmação
          : '✅ Pagamento confirmado! Obrigada 🙏';

        try {
          await sock.sendMessage(numero, { text: mensagem });
          console.log(`📤 Mensagem enviada para: ${numero}`);

          await supabase
            .from('pagamentos')
            .update({ mensagem_enviada: true })
            .eq('txid', pagamento.txid);

          console.log(`✔️ Atualizado: mensagem_enviada = true no txid: ${pagamento.txid}`);
        } catch (err) {
          console.error('⚠️ Erro ao enviar mensagem:', err);
        }
      }
    )
    .subscribe((status) => {
      console.log('🟢 Status canal Realtime:', status);
    });
}

startBot();
