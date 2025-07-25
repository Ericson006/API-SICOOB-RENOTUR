// Importações essenciais
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Configuração de paths
const currentFileUrl = import.meta.url;
const currentFilePath = fileURLToPath(currentFileUrl);
const currentDirPath = dirname(currentFilePath);

// Solução para importar o Baileys (CommonJS)
const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const { 
  makeWASocket, 
  useSingleFileAuthState, 
  fetchLatestBaileysVersion, 
  DisconnectReason 
} = baileys;

// Configuração do ambiente
dotenv.config();

// Inicialização do Supabase
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_KEY
);

// Configurações do bot
const authFolder = `${currentDirPath}/auth`;
const bucket = 'auth-session';

async function baixarAuthDoSupabase() {
  console.log('🔄 Baixando arquivos de autenticação...');
  try {
    if (!fs.existsSync(authFolder)) await fs.mkdir(authFolder, { recursive: true });

    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 100 });

    if (error) throw error;

    for (const file of files) {
      const { data: signedUrl } = await supabase.storage
        .from(bucket)
        .createSignedUrl(file.name, 3600);
      
      const res = await fetch(signedUrl.signedUrl);
      await fs.writeFile(`${authFolder}/${file.name}`, Buffer.from(await res.arrayBuffer()));
      console.log(`⬇️ Baixado: ${file.name}`);
    }
    return true;
  } catch (error) {
    console.error('❌ Erro ao baixar auth:', error.message);
    return false;
  }
}

async function testarConexaoSupabase() {
  try {
    const { data, error } = await supabase.from('pagamentos').select('*').limit(1);
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('❌ Erro no Supabase:', error.message);
    return false;
  }
}

async function startBot() {
  const authLoaded = await baixarAuthDoSupabase();
  if (!authLoaded) console.warn('⚠️ Continuando sem arquivos de autenticação');

  const { state, saveState } = useSingleFileAuthState(`${authFolder}/creds.json`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    logger: { level: 'warn' }
  });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Conexão encerrada. ${shouldReconnect ? 'Reconectando...' : 'Login necessário'}`);
      if (shouldReconnect) setTimeout(startBot, 5000);
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
      escutarSupabase(sock);
    }
  });

  const conexaoOk = await testarConexaoSupabase();
  if (!conexaoOk) console.error('🚨 Falha na conexão com Supabase');
}

function escutarSupabase(sock) {
  console.log('🔔 Escutando tabela pagamentos...');
  
  supabase
    .channel('pagamentos-channel')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'pagamentos',
      filter: 'status=eq.concluido'
    }, async (payload) => {
      const pagamento = payload.new;
      if (pagamento.mensagem_enviada) return;

      const numero = `${pagamento.telefone_cliente.replace(/\D/g, '')}@s.whatsapp.net`;
      const mensagem = pagamento.mensagem_confirmação || '✅ Pagamento confirmado! Obrigado.';

      try {
        await sock.sendMessage(numero, { text: mensagem });
        console.log(`📤 Mensagem enviada para ${numero}`);
        
        await supabase
          .from('pagamentos')
          .update({ mensagem_enviada: true })
          .eq('txid', pagamento.txid);
      } catch (error) {
        console.error('⚠️ Erro ao enviar mensagem:', error.message);
      }
    })
    .subscribe();
}

// Inicialização do bot com tratamento de erros
startBot().catch(error => {
  console.error('💥 Erro fatal:', error);
  process.exit(1);
});

// Health check endpoint (opcional para Render)
import express from 'express';
const app = express();
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🩺 Health check ativo na porta ${process.env.PORT || 3000}`);
});
