import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { Client, LocalAuth } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import pino from 'pino';

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
  process.env.SUPABASE_KEY,
  {
    db: { schema: 'public' },
    global: { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } }
  }
);

// Configurações otimizadas para baixo consumo de RAM
const authFolder = `${__dirname}/auth`;
const bucket = 'auth-session';
const logger = pino({ level: 'warn' });

// Variáveis globais
let ultimoQR = null;
let client = null;
let reconectando = false;
let pollingInterval = null;
let contadorPolling = 0;
let ultimoTxidProcessado = null;

// Configuração do Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==============================================
// FUNÇÕES PRINCIPAIS (OTIMIZADAS)
// ==============================================

async function baixarAuthDoSupabase() {
  logger.info('Baixando auth do Supabase...');
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
      await fs.writeFile(`${authFolder}/${file.name}`, Buffer.from(await res.arrayBuffer()));
    }
    return true;
  } catch (error) {
    logger.error('Erro ao baixar auth: %s', error.message);
    return false;
  }
}

async function sendMessageWithRetry(chatId, content, options = {}) {
  const MAX_RETRIES = 2;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await client.sendMessage(chatId, content, options);
      logger.info('Mensagem enviada para %s', chatId);
      return message;
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

// ==============================================
// INICIALIZAÇÃO DO WHATSAPP-WEB.JS
// ==============================================

function startBot() {
  client = new Client({
    authStrategy: new LocalAuth({ clientId: "bot", dataPath: authFolder }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process'
      ]
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
  });

  client.on('qr', async qr => {
    ultimoQR = qr;
    logger.info('QR Code gerado');
    QRCode.toString(qr, { type: 'terminal' }, (err, url) => {
      if (!err) console.log(url);
    });
  });

  client.on('ready', () => {
    logger.warn('✅ Bot pronto!');
    iniciarPollingCobrancas();
  });

  client.on('disconnected', (reason) => {
    logger.warn('Desconectado: %s', reason);
    if (!reconectando) {
      reconectando = true;
      setTimeout(() => {
        startBot();
        reconectando = false;
      }, 10000);
    }
  });

  client.initialize();
}

// ==============================================
// SISTEMA DE POLLING (MANTIDO COM AJUSTES)
// ==============================================

function iniciarPollingCobrancas() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(verificarCobrancasPendentes, 20000);
  verificarCobrancasPendentes();
}

async function verificarCobrancasPendentes() {
  if (!client || !client.info) return;
  
  contadorPolling++;
  const horaInicio = new Date();
  logger.info('Verificação %d iniciada', contadorPolling);

  try {
    const { data: cobrancas, error } = await supabase
      .from('cobrancas')
      .select('*')
      .or('status.eq.concluido,status.eq.Concluído,status.eq.CONCLUIDO,status.eq.PAGO')
      .or('mensagem_enviada.eq.false,mensagem_enviada.is.null')
      .not('telefone_cliente', 'is', null)
      .limit(10);

    if (error) throw error;

    if (cobrancas?.length > 0) {
      for (const cobranca of cobrancas) {
        await processarCobranca(cobranca);
      }
    }
  } catch (error) {
    logger.error('Erro no polling: %s', error.message);
  } finally {
    logger.info('Tempo da verificação: %dms', (new Date() - horaInicio));
  }
}

async function processarCobranca(cobranca) {
  try {
    let telefone = String(cobranca.telefone_cliente).replace(/\D/g, '');
    if (telefone.length === 10 && telefone.startsWith('11')) {
      telefone = telefone.substring(0, 2) + '9' + telefone.substring(2);
    }
    
    const chatId = `55${telefone}@c.us`;
    const valorFormatado = cobranca.valor.toFixed(2).replace('.', ',');
    const mensagem = cobranca.mensagem_confirmacao || 
      `✅ Pagamento confirmado!\n💵 Valor: R$${valorFormatado}`;

    await sendMessageWithRetry(chatId, mensagem);

    await supabase.from('cobrancas')
      .update({ 
        mensagem_enviada: true,
        data_envio: new Date().toISOString()
      })
      .eq('txid', cobranca.txid);
  } catch (error) {
    logger.error('Erro ao processar cobrança: %s', error.message);
  }
}

// ==============================================
// ROTAS EXPRESS (SIMPLIFICADAS)
// ==============================================

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/qr', (req, res) => {
  if (!ultimoQR) return res.status(404).send('QR não disponível');
  res.json({ qr: ultimoQR });
});

app.get('/', async (req, res) => {
  try {
    if (!ultimoQR) return res.status(404).send('QR não disponível');
    const qrImage = await QRCode.toDataURL(ultimoQR);
    res.send(`
      <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="text-align:center;">
          <h1>📲 Conecte o WhatsApp</h1>
          <img src="${qrImage}" width="300" />
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Erro ao gerar QR');
  }
});

// ==============================================
// INICIALIZAÇÃO DO SERVIDOR
// ==============================================

app.listen(PORT, () => {
  logger.info(`Servidor rodando na porta ${PORT}`);
  
  // Monitor de memória
  setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    if (used > 400) logger.warn('ALERTA: Uso de memória: %.2fMB', used);
  }, 60000);

  // Inicia o bot
  baixarAuthDoSupabase().then(() => startBot());
});

process.on('SIGINT', () => {
  logger.info('Desligando...');
  if (client) client.destroy();
  process.exit(0);
});
