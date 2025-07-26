import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// SOLUÇÃO DEFINITIVA - FORMA COMPROVADA
import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import authState from '@whiskeysockets/baileys/lib/Utils/auth-state.js';

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

  // USO CORRETO - FORMA COMPROVADA
  const { state, saveState } = authState.useSingleFileAuthState(`${authFolder}/creds.json`);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: { level: 'warn' }
  });

  sock.ev.on('creds.update', saveState);

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'close') {
      const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Conexão encerrada. ${shouldReconnect ? 'Reconectando...' : 'Faça login novamente'}`);
      if (shouldReconnect) setTimeout(startBot, 5000);
    } else if (update.connection === 'open') {
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

// Inicialização segura
startBot().catch(error => {
  console.error('💥 Erro fatal:', error);
  process.exit(1);
});

// Health check endpoint
import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`🩺 Health check ativo na porta ${PORT}`));
