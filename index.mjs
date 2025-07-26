import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pkg from 'pg';

const { Client: PgClient } = pkg;

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

// Variáveis globais
let ultimoQR = null;
let sock = null; // Instância do socket do WhatsApp
let reconectando = false;

// Configuração do Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

async function baixarAuthDoSupabase() {
  console.log('🔄 Baixando arquivos de autenticação...');
  try {
    await fs.mkdir(authFolder, { recursive: true });
    
    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 100 });

    if (error) throw error;

    for (const file of files) {
      if (file.name.startsWith('.tmp')) continue;
      
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
  try {
    const authLoaded = await baixarAuthDoSupabase();
    if (!authLoaded) console.warn('⚠️ Continuando sem arquivos de autenticação');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { default: baileys } = await import('@whiskeysockets/baileys');

    sock = baileys.makeWASocket({
      auth: state,
      printQRInTerminal: true,
      getMessage: async () => ({})
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (update.qr) {
        ultimoQR = update.qr;
        console.log('🆕 Novo QR Code gerado');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`🔌 Conexão encerrada (código: ${statusCode}). ${shouldReconnect ? 'Reconectando...' : 'Faça login novamente'}`);

        if (shouldReconnect && !reconectando) {
          reconectando = true;
          setTimeout(() => {
            startBot().then(() => reconectando = false);
          }, 10000);
        }
      } else if (connection === 'open') {
        console.log('✅ Conectado ao WhatsApp!');
        escutarSupabase();
        startPgListener();
      }
    });

    return sock;
  } catch (error) {
    console.error('🚨 Erro ao iniciar bot:', error);
    throw error;
  }
}

function escutarSupabase() {
  console.log('🔔 Iniciando escuta do Supabase...');
  
  const channel = supabase
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
          .eq('txid', pagamento.txid)
          .select('txid');
      } catch (error) {
        console.error('⚠️ Erro ao enviar mensagem:', error.message);
      }
    })
    .subscribe();
}

async function startPgListener() {
  if (!process.env.SUPABASE_DB_URL) {
    console.warn('⚠️ SUPABASE_DB_URL não configurado - listener PostgreSQL desativado');
    return;
  }

  try {
    const pgClient = new PgClient({
      connectionString: process.env.SUPABASE_DB_URL,
    });

    await pgClient.connect();
    await pgClient.query('LISTEN pagamento_confirmado');

    console.log('🟢 Aguardando confirmações de pagamento via PostgreSQL LISTEN...');

    pgClient.on('notification', async (msg) => {
      if (msg.channel === 'pagamento_confirmado') {
        const payload = JSON.parse(msg.payload);
        console.log('✅ Pagamento confirmado via PostgreSQL:', payload);
        
        if (sock) {
          const numero = `${payload.telefone_cliente.replace(/\D/g, '')}@s.whatsapp.net`;
          const mensagem = payload.mensagem_confirmação || '✅ Pagamento confirmado via PostgreSQL! Obrigado.';
          
          try {
            await sock.sendMessage(numero, { text: mensagem });
            console.log(`📤 Mensagem enviada para ${numero}`);
          } catch (error) {
            console.error('⚠️ Erro ao enviar mensagem via PostgreSQL listener:', error.message);
          }
        }
      }
    });

    pgClient.on('error', (err) => {
      console.error('⚠️ Erro na conexão PostgreSQL:', err.message);
      // Tentar reconectar após um tempo
      setTimeout(startPgListener, 5000);
    });

    return pgClient;
  } catch (error) {
    console.error('🚨 Erro ao iniciar listener PostgreSQL:', error);
    // Tentar novamente após um tempo
    setTimeout(startPgListener, 5000);
  }
}

// Rotas do Express

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rota para retornar o QR em JSON
app.get('/qr', (req, res) => {
  res.json({ qr: ultimoQR });
});

// Rota raiz serve o QR gerado como imagem
app.get('/', async (req, res) => {
  try {
    if (!ultimoQR) {
      return res.status(404).send('QR Code ainda não disponível');
    }
    
    const qrImage = await QRCode.toDataURL(ultimoQR); 
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h1>📲 Escaneie o QR Code</h1>
          <img src="${qrImage}" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao gerar imagem do QR Code.');
  }
});

// Endpoint para receber webhook do Supabase
app.post('/webhook', async (req, res) => {
  const payload = req.body;

  console.log('Recebi webhook:', JSON.stringify(payload, null, 2));

  const oldRow = payload.old;
  const newRow = payload.new;

  if (oldRow?.status === 'PENDENTE' && newRow?.status === 'CONCLUIDO') {
    const telefone = newRow.telefone_cliente;
    const mensagem = 'Seu pagamento foi confirmado. Muito obrigado por escolher a Renotur!';

    try {
      if (sock) {
        const jid = telefone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: mensagem });
        console.log('Mensagem enviada para', jid);
      } else {
        console.warn('⚠️ WhatsApp não conectado - mensagem não enviada');
      }
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err);
    }
  }

  res.status(200).send('Webhook recebido');
});

// Inicialização do servidor
async function startServer() {
  // Monitoramento de memória
  setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`🚀 Uso de memória: ${Math.round(used * 100) / 100} MB`);
  }, 30000);

  try {
    await startBot();
    console.log('🤖 Bot iniciado com sucesso!');
  } catch (error) {
    console.error('💥 Erro fatal ao iniciar bot:', error);
    process.exit(1);
  }
}

app.listen(PORT, () => {
  console.log(`🩺 Servidor rodando na porta ${PORT}`);
  startServer();
});

// Limpeza ao sair
process.on('SIGINT', async () => {
  console.log('🛑 Desconectando...');
  supabase.removeAllChannels();
  process.exit(0);
});
