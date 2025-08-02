// Módulos nativos do Node
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';

// Módulos de terceiros
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import whatsappPkg from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
const { Client, LocalAuth } = whatsappPkg;

// Configuração de paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuração do ambiente
dotenv.config();

// Verificação das variáveis de ambiente
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY || !process.env.CHROMIUM_PATH) {
  console.error('❌ SUPABASE_URL, SUPABASE_KEY e CHROMIUM_PATH são obrigatórios');
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

// Configurações
const authFolder = `${__dirname}/auth`;
const bucket = 'auth-session';

// Configuração do logger
const logger = pino({
  level: 'debug', // Aumentado para debug para mais informações
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// Variáveis globais
let ultimoQR = null;
let client = null;
let reconectando = false;
let pollingInterval = null;
let contadorPolling = 0;

// Configuração do Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==============================================
// FUNÇÕES PRINCIPAIS (ATUALIZADAS)
// ==============================================

async function limparSessaoAntiga() {
  try {
    logger.info('Limpando sessão anterior...');
    await fs.rm(authFolder, { recursive: true, force: true });
    await fs.mkdir(authFolder, { recursive: true });
    logger.info('Sessão limpa com sucesso');
  } catch (error) {
    logger.error('Erro ao limpar sessão: %s', error.message);
  }
}

async function verificarInstalacaoChromium() {
  try {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox']
    });
    await browser.close();
    logger.info('Chromium verificado com sucesso');
    return true;
  } catch (error) {
    logger.error('Falha ao verificar Chromium: %s', error.message);
    return false;
  }
}

async function startBot() {
  // Verificar Chromium antes de iniciar
  if (!await verificarInstalacaoChromium()) {
    logger.error('Chromium não está funcionando corretamente');
    setTimeout(startBot, 30000);
    return;
  }

  // Limpar sessão antiga se estiver reconectando
  if (reconectando) {
    await limparSessaoAntiga();
    reconectando = false;
  }

  logger.info('🚀 Iniciando cliente WhatsApp...');
  
  try {
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "bot",
        dataPath: authFolder
      }),
      puppeteer: {
        headless: 'new',
        executablePath: process.env.CHROMIUM_PATH,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--remote-debugging-port=9222'
        ],
        timeout: 180000,
        dumpio: true // Para logs detalhados
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1013006690.html'
      }
    });

    // Eventos do WhatsApp (ATUALIZADOS)
    client.on('qr', async qr => {
      ultimoQR = qr;
      logger.info('QR Code gerado, aguardando leitura...');
      QRCode.toString(qr, { type: 'terminal' }, (err, url) => {
        if (!err) console.log(url);
      });
    });

    client.on('authenticated', () => {
      logger.info('Autenticado com sucesso!');
    });

    client.on('auth_failure', msg => {
      logger.error('Falha na autenticação: %s', msg);
      reconectando = true;
    });

    client.on('loading_screen', (percent, message) => {
      logger.debug('Carregando: %s (%s%)', message, percent);
    });

    client.on('ready', () => {
      logger.warn('✅ Bot pronto e conectado!');
      iniciarPollingCobrancas();
    });

    client.on('disconnected', async reason => {
      logger.warn('⚠️ Desconectado: %s', reason);
      reconectando = true;
      setTimeout(() => startBot(), 10000);
    });

    await client.initialize();
    logger.info('📡 Cliente inicializado com sucesso');

  } catch (err) {
    logger.error('Erro ao inicializar cliente: %s', err.message);
    setTimeout(() => startBot(), 15000);
  }
}

// ==============================================
// ROTAS HTTP (ATUALIZADAS)
// ==============================================

app.get('/health', (req, res) => res.status(200).json({ 
  status: 'OK',
  connected: client?.info ? true : false
}));

app.get('/qr', async (req, res) => {
  if (!ultimoQR) return res.status(404).json({ error: 'QR não disponível' });
  
  try {
    const qrImage = await QRCode.toDataURL(ultimoQR);
    res.json({ 
      qr: ultimoQR,
      qrImage: qrImage,
      status: client?.info ? 'connected' : 'waiting'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar QR' });
  }
});

app.get('/', async (req, res) => {
  try {
    if (!ultimoQR) return res.status(404).send('QR não disponível');
    
    const qrImage = await QRCode.toDataURL(ultimoQR);
    res.send(`
      <html>
        <head>
          <title>WhatsApp Bot</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
            img { max-width: 300px; height: auto; margin: 20px auto; display: block; }
            .status { padding: 10px; margin: 20px; border-radius: 5px; }
            .connected { background: #4CAF50; color: white; }
            .disconnected { background: #F44336; color: white; }
          </style>
        </head>
        <body>
          <h1>📲 Conecte o WhatsApp</h1>
          <img src="${qrImage}" alt="QR Code" />
          <div class="status ${client?.info ? 'connected' : 'disconnected'}">
            Status: ${client?.info ? '✅ Conectado' : '❌ Aguardando conexão'}
          </div>
          ${!client?.info ? '<p>Escaneie o QR code pelo app do WhatsApp > Dispositivos vinculados</p>' : ''}
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Erro ao gerar página');
  }
});

// ==============================================
// INICIALIZAÇÃO (ATUALIZADA)
// ==============================================

async function main() {
  try {
    // Verificar e criar pasta auth
    await fs.mkdir(authFolder, { recursive: true });
    
    // Iniciar servidor
    app.listen(PORT, () => {
      logger.info(`Servidor rodando na porta ${PORT}`);
      
      // Monitor de memória
      setInterval(() => {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        logger.debug('Uso de memória: %.2fMB', used);
      }, 60000);

      // Iniciar bot
      startBot();
    });

  } catch (err) {
    logger.error('Erro na inicialização: %s', err.message);
    process.exit(1);
  }
}

// Gerenciamento de desligamento
process.on('SIGINT', async () => {
  logger.info('Desligando...');
  
  if (pollingInterval) clearInterval(pollingInterval);
  
  if (client) {
    await client.destroy();
    logger.info('Conexão com WhatsApp encerrada');
  }
  
  process.exit(0);
});

// Iniciar aplicação
main();
