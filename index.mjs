import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

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
    // Limpeza e preparação
    await fs.rm(authFolder, { recursive: true, force: true });
    await fs.mkdir(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { default: makeWASocket } = await import('@whiskeysockets/baileys');

    // Configuração robusta sem defaultLogger
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      getMessage: async () => ({}),
      browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    // Gerenciamento de QR Code manual
    let qrGenerated = false;
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr && !qrGenerated) {
        ultimoQR = qr;
        qrGenerated = true;
        QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
          if (!err) {
            console.log('🆕 QR Code para conexão:');
            console.log(url);
          }
        });
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`🔌 Conexão fechada, ${shouldReconnect ? 'reconectando...' : 'faça login novamente'}`);
        
        if (shouldReconnect) {
          setTimeout(startBot, 10000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com SUCESSO!');
        escutarSupabase(sock);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', () => {});

    return sock;
  } catch (error) {
    console.error('🚨 ERRO no bot:', {
      message: error.message,
      stack: error.stack
    });
    setTimeout(startBot, 20000);
  }
}

function iniciarServicos(sock) {
  console.log('🛠️ Iniciando todos os serviços...');
  
  // 1. Serviço do Supabase
  escutarSupabase(sock);
  
  // 2. Verificação de saúde
  setInterval(() => {
    console.log('🏥 Status:', {
      memory: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
      connection: sock.user ? 'OK' : 'OFFLINE'
    });
  }, 60000);
}

function escutarSupabase(sock) {
  console.log('🔔 Iniciando escuta da tabela cobrancas...');

  const channel = supabase
    .channel('cobrancas-realtime')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'cobrancas',
      filter: 'status=eq.concluido'
    }, async (payload) => {
      try {
        console.log('📦 Evento recebido:', payload);
        
        if (payload.new.mensagem_enviada) return;
        
        const numero = `${payload.new.telefone_cliente.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(numero, {
          text: payload.new.mensagem_confirmação || '✅ Cobrança confirmada!'
        });
        
        await supabase
          .from('cobrancas')
          .update({ mensagem_enviada: true })
          .eq('txid', payload.new.txid);
          
        console.log('✔️ Mensagem enviada e registro atualizado');
      } catch (error) {
        console.error('❌ Erro no processamento:', error.message);
      }
    })
    .subscribe((status, err) => {
      if (err) console.error('❌ Erro na conexão:', err);
      else console.log('✅ Listener ativo (status:', status, ')');
    });
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
  console.log('Webhook recebido:', JSON.stringify(payload, null, 2));

  const oldRow = payload.old;
  const newRow = payload.new;

  if (oldRow?.status === 'PENDENTE' && newRow?.status === 'CONCLUIDO') {
    const telefone = newRow.telefone_cliente;
    const mensagem = 'Sua cobrança foi confirmada. Muito obrigado!';

    try {
      if (sock) {
        const jid = telefone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: mensagem });
        console.log(`📤 Mensagem enviada via webhook para ${jid}`);
        
        await supabase
          .from('cobrancas')  // ← Nome corrigido aqui
          .update({ mensagem_enviada: true })
          .eq('txid', newRow.txid);
      }
    } catch (err) {
      console.error('Erro no webhook:', err);
    }
  }

  res.status(200).send('OK');
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

// Adicione esta rota para testes manuais
app.get('/teste-cobranca', async (req, res) => {
  try {
    await supabase
      .from('cobrancas')
      .update({ status: 'concluido', mensagem_enviada: false })
      .eq('txid', 'teste-123');
      
    res.send('Atualização de teste disparada! Verifique os logs.');
  } catch (error) {
    res.status(500).send('Erro: ' + error.message);
  }
});

// Limpeza ao sair
process.on('SIGINT', async () => {
  console.log('🛑 Desconectando...');
  supabase.removeAllChannels();
  process.exit(0);
});
