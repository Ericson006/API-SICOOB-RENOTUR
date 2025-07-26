import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';

// Configuração de paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuração do ambiente
dotenv.config();

// Verificação das variáveis de ambiente
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_KEY são obrigatórios');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Configurações do bot
const authFolder = `${__dirname}/auth`;
const bucket = 'auth-session';

async function baixarAuthDoSupabase() {
  console.log('🔄 Baixando arquivos de autenticação...');
  try {
    await fs.mkdir(authFolder, { recursive: true });
    
    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 100 });

    if (error) throw error;

    for (const file of files) {
      const { data: signedUrl } = await supabase.storage
        .from(bucket)
        .createSignedUrl(file.name, 3600);
      
      const res = await fetch(signedUrl.signedUrl);
      await fs.writeFile(
        `${authFolder}/${file.name}`,
        Buffer.from(await res.arrayBuffer())
      );
      console.log(`⬇️ Baixado: ${file.name}`);
    }
    return true;
  } catch (error) {
    console.error('❌ Erro ao baixar auth:', error.message);
    return false;
  }
}

async function startBot() {
  const authLoaded = await baixarAuthDoSupabase();
  if (!authLoaded) console.warn('⚠️ Continuando sem arquivos de autenticação');

  // SOLUÇÃO 100% MANUAL - SEM DEPENDÊNCIA DE FUNÇÕES EXTERNAS
  const authFile = `${authFolder}/creds.json`;
  let creds = {};
  
  try {
    const data = await fs.readFile(authFile, 'utf-8');
    creds = JSON.parse(data);
    console.log('🔑 Credenciais carregadas com sucesso');
  } catch (error) {
    console.warn('⚠️ Criando novo arquivo de autenticação');
  }

  // Função para salvar o estado - COMPLETAMENTE MANUAL
  const saveState = () => {
    fs.writeFile(authFile, JSON.stringify(creds, null, 2))
      .then(() => console.log('💾 Credenciais salvas'))
      .catch(err => console.error('❌ Erro ao salvar credenciais:', err));
  };

  // Importação DINÂMICA do Baileys para evitar conflitos de inicialização
  const { default: baileys } = await import('@whiskeysockets/baileys');
  const { DisconnectReason } = baileys;

  // Configuração simplificada do socket
  const sock = baileys.makeWASocket({
    auth: {
      creds,
      keys: {}
    },
    printQRInTerminal: true,
    // Logger mínimo para evitar problemas
    logger: {
      level: 'warn',
      info: (...args) => console.log('[INFO]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
      debug: () => {} // Desabilitado para reduzir logs
    }
  });

  sock.ev.on('creds.update', (updatedCreds) => {
    creds = updatedCreds;
    saveState();
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`🔌 Conexão encerrada (código: ${statusCode}). ${shouldReconnect ? 'Reconectando...' : 'Faça login novamente'}`);
      if (shouldReconnect) setTimeout(startBot, 5000);
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!');
      escutarSupabase(sock);
    }
  });
}

function escutarSupabase(sock) {
  console.log('🔔 Iniciando escuta do Supabase...');
  
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

// Health check endpoint
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.status(200).send('OK'));

// Inicialização segura
app.listen(PORT, async () => {
  console.log(`🩺 Health check ativo na porta ${PORT}`);
  
  try {
    await startBot();
    console.log('🤖 Bot iniciado com sucesso!');
  } catch (error) {
    console.error('💥 Erro fatal ao iniciar bot:', error);
    process.exit(1);
  }
});
