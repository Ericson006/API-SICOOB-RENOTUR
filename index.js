import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const authFolder = path.join(__dirname, 'auth');
const bucket = 'auth-session';

async function baixarAuthDoSupabase() {
  console.log('🔄 Iniciando download dos arquivos de autenticação do Supabase Storage...');
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

  const { data, error } = await supabase.storage.from(bucket).list('', { limit: 100 });

  if (error) {
    console.error('❌ Erro ao listar arquivos de sessão no Storage:', error.message);
    return false;
  }
  console.log(`📁 Encontrados ${data.length} arquivos na pasta auth-session.`);

  for (const file of data) {
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(bucket)
      .createSignedUrl(file.name, 3600);
    if (signedUrlError) {
      console.error(`❌ Erro ao criar URL para ${file.name}:`, signedUrlError.message);
      continue;
    }

    try {
      const res = await fetch(signedUrlData.signedUrl);
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(path.join(authFolder, file.name), Buffer.from(buffer));
      console.log(`⬇️ Arquivo baixado: ${file.name}`);
    } catch (fetchErr) {
      console.error(`❌ Falha ao baixar arquivo ${file.name}:`, fetchErr.message);
    }
  }
  console.log('✅ Download dos arquivos de autenticação finalizado.');
  return true;
}

async function testarConexaoTabelaPagamentos() {
  console.log('🔍 Testando conexão com a tabela "pagamentos"...');
  const { data, error } = await supabase
    .from('pagamentos')
    .select('*')
    .limit(3);

  if (error) {
    console.error('❌ Erro ao acessar tabela pagamentos:', error.message);
    return false;
  }
  console.log(`✅ Conexão OK. Encontrados ${data.length} registros na tabela pagamentos (exemplo):`);
  console.log(data);
  return true;
}

async function startBot() {
  const authLoaded = await baixarAuthDoSupabase();
  if (!authLoaded) {
    console.warn('⚠️ Continuando sem arquivos de autenticação baixados (novo login será necessário).');
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
      console.log('❌ Conexão fechada, reconectar?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado ao WhatsApp!');
      escutarSupabase(sock);
    }
  });

  // Testa acesso tabela pagamentos ao iniciar
  const conexaoOk = await testarConexaoTabelaPagamentos();
  if (!conexaoOk) {
    console.error('🚨 Falha na conexão com Supabase. Verifique as variáveis de ambiente e permissões.');
  }
}

function escutarSupabase(sock) {
  console.log('🔔 Inscrevendo no canal Realtime da tabela pagamentos...');
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
          console.log('⚠️ Pagamento já notificado, ignorando.');
          return;
        }

        const numero = pagamento.telefone_cliente.replace(/\D/g, '') + '@s.whatsapp.net';
        const mensagem =
          pagamento.mensagem_confirmação?.trim()?.length > 0
            ? pagamento.mensagem_confirmação
            : '✅ Pagamento confirmado! Obrigada 🙏';

        try {
          await sock.sendMessage(numero, { text: mensagem });
          console.log(`📤 Mensagem enviada para: ${numero}`);

          await supabase
            .from('pagamentos')
            .update({ mensagem_enviada: true })
            .eq('txid', pagamento.txid);
          console.log(`✔️ Atualizado mensagem_enviada para true no registro txid: ${pagamento.txid}`);
        } catch (err) {
          console.error('⚠️ Erro ao enviar mensagem:', err);
        }
      }
    )
    .subscribe((status) => {
      console.log('🟢 Status da inscrição Realtime:', status);
    });
}

startBot();
