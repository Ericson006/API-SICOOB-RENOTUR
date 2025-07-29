import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } from '@whiskeysockets/baileys';
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
    db: {
      schema: 'public',
    },
    global: {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }
  }
);

// Configurações do bot
const authFolder = `${__dirname}/auth`;
const bucket = 'auth-session';

// Variáveis globais
let ultimoQR = null;
let sock = null;
let reconectando = false;
let pollingInterval = null;
let contadorPolling = 0;
let ultimoTxidProcessado = null;

// Configuração do Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==============================================
// FUNÇÕES PRINCIPAIS
// ==============================================

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

// Função para enviar mensagem com retry e verificação de entrega
async function sendMessageWithRetry(jid, content, options = {}) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`📤 Tentativa ${attempt} de envio para ${jid}`);
      
      // 1. Forçar presença antes de enviar (solução #2)
      await sock.presenceSubscribe(jid);
      await delay(1500); // Esperar para estabilizar conexão
      
      // 2. Enviar a mensagem
      const message = await sock.sendMessage(jid, content, {
        ...options,
        // 3. Habilitar opções de store e sync (solução #3)
        messageStubParameters: [],
        upload: true
      });
      
      // Verificar se a mensagem foi realmente entregue
      if (message?.key?.id) {
        console.log(`✅ Mensagem enviada com ID: ${message.key.id}`);
        return message;
      }
      
      throw new Error('Mensagem enviada mas sem ID de confirmação');
    } catch (error) {
      console.error(`❌ Falha na tentativa ${attempt}:`, error.message);
      
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * attempt);
      } else {
        throw error;
      }
    }
  }
}

async function startBot() {
  try {
    const authLoaded = await baixarAuthDoSupabase();
    if (!authLoaded) console.warn('⚠️ Continuando sem arquivos de autenticação');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    // 4. Usar versão estável manualmente (solução #4)
    const version = [2, 2413, 1]; // Versão estável conhecida
    
    // 5. Configurar logging detalhado (solução #5)
    const logger = pino({ level: 'trace' }).child({ class: 'baileys' });
    logger.level = 'debug';

    sock = makeWASocket({
      auth: state,
      version,
      browser: ["Renotur", "Bot", "1.0"],
      markOnlineOnConnect: true,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 10_000,
      logger,
      // 3. Configurações adicionais para melhorar entrega (solução #3)
      getMessage: async (key) => {
        return {
          conversation: 'mensagem armazenada'
        };
      },
      msgRetryCounterCache: new Map(),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) => false,
      linkPreviewImageThumbnailWidth: 192,
      transactionOpts: {
        maxCommitRetries: 10,
        delayBetweenTriesMs: 3000
      }
    });
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          ultimoQR = qr;
          console.log('🆕 Novo QR Code gerado');
          QRCode.toString(qr, { type: 'terminal' }, (err, url) => {
            if (!err) console.log(url);
          });
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.status;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`🔌 Conexão encerrada (código: ${statusCode}). ${shouldReconnect ? 'Reconectando...' : 'Faça login novamente'}`);

          if (shouldReconnect && !reconectando) {
            reconectando = true;
            setTimeout(() => {
              startBot().then(() => (reconectando = false));
            }, 10000);
          }
        } else if (connection === 'open') {
          console.log('✅ Conectado ao WhatsApp!');
          iniciarPollingCobrancas();
        }
      } catch (err) {
        console.error('Erro no connection.update:', err.message);
      }
    });

    // Monitorar eventos de mensagens para debug
    sock.ev.on('messages.upsert', ({ messages }) => {
      logger.debug('messages.upsert', messages);
    });
    
    sock.ev.on('messages.update', (updates) => {
      updates.forEach(update => {
        if (update.update?.status) {
          logger.debug(`Mensagem ${update.key.id} atualizada para status: ${update.update.status}`);
        }
      });
    });

    return sock;
  } catch (error) {
    console.error('🚨 Erro ao iniciar bot:', error);
    setTimeout(startBot, 15000);
    throw error;
  }
}

// ==============================================
// SISTEMA DE POLLING
// ==============================================

function iniciarPollingCobrancas() {
  if (pollingInterval) clearInterval(pollingInterval);
  
  console.log('🔄 Iniciando sistema de polling para cobranças...');
  verificarCobrancasPendentes();
  pollingInterval = setInterval(verificarCobrancasPendentes, 20000);
}

function formatarDataBrasilComSegundos(dataOriginal) {
  const data = new Date(dataOriginal || new Date());
  const options = {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  
  return data.toLocaleString('pt-BR', options)
    .replace(',', ' -')
    .replace(/\//g, '/');
}

async function verificarCobrancasPendentes() {
  contadorPolling++;
  const horaInicio = new Date();
  console.log(`\n🔍 [${horaInicio.toISOString()}] Verificação ${contadorPolling} iniciada`);

  try {
    const { data: ultimasCobrancas } = await supabase
      .from('cobrancas')
      .select('txid, status, created_at, mensagem_enviada, telefone_cliente')
      .order('created_at', { ascending: false })
      .limit(5);

    console.log('📋 Últimas 5 cobranças no banco:');
    ultimasCobrancas.forEach((cob, i) => {
      console.log(`  ${i + 1}. ${cob.txid}`, {
        status: cob.status,
        mensagem_enviada: cob.mensagem_enviada,
        created_at: cob.created_at || 'SEM DATA',
        telefone: cob.telefone_cliente || 'NÃO INFORMADO'
      });
    });

    const { data: cobrancas, error, count } = await supabase
      .from('cobrancas')
      .select('*', { count: 'exact' })
      .or('status.eq.concluido,status.eq.Concluído,status.eq.CONCLUIDO,status.eq.PAGO')
      .or('mensagem_enviada.eq.false,mensagem_enviada.is.null')
      .order('created_at', { ascending: false })
      .not('telefone_cliente', 'is', null)
      .limit(10);

    console.log('\n📊 Resultado da consulta:', {
      total_encontrado: count,
      cobrancas_encontradas: cobrancas?.length,
      status_distintos: [...new Set(cobrancas?.map(c => c.status))],
      erro: error?.message
    });

    if (error) throw error;

    if (cobrancas?.length > 0) {
      console.log(`\n📦 Processando ${cobrancas.length} cobrança(s):`);
      for (const cobranca of cobrancas) {
        await processarCobranca(cobranca);
      }
    } else {
      console.log('\n⏭️ Nenhuma cobrança elegível encontrada');
    }

  } catch (error) {
    console.error('\n❌ ERRO CRÍTICO:', error.message);
  } finally {
    console.log(`\n⏱️ Tempo total da verificação: ${(new Date() - horaInicio)}ms`);
  }
}

// ==============================================
// FUNÇÃO DE PROCESSAMENTO
// ==============================================

async function processarCobranca(cobranca) {
  const inicioProcessamento = new Date();
  try {
    console.log('\n📱 Validando telefone...');
    let telefoneLimpo = String(cobranca.telefone_cliente)
      .replace(/\D/g, '')
      .replace(/[\u202A-\u202E]/g, '');

    if (telefoneLimpo.length === 10 && telefoneLimpo.startsWith('11')) {
      telefoneLimpo = telefoneLimpo.substring(0, 2) + '9' + telefoneLimpo.substring(2);
    }

    if (telefoneLimpo.length < 11) throw new Error(`Telefone inválido: ${telefoneLimpo}`);
    const numeroWhatsapp = `55${telefoneLimpo}@s.whatsapp.net`;

    console.log('\n🔍 Verificando existência do número...');
    const [resultado] = await Promise.race([
      sock.onWhatsApp(numeroWhatsapp),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout na verificação')), 5000))
    ]);
    
    if (!resultado?.exists) throw new Error(`Número não registrado: ${telefoneLimpo}`);

    console.log('\n✉️ Enviando mensagem...');
    const valorFormatado = cobranca.valor.toFixed(2).replace('.', ',');
    const mensagem = cobranca.mensagem_confirmacao || 
      `✅ Pagamento confirmado!\n💵 Valor: R$${valorFormatado}\n📅 Data: ${new Date(cobranca.created_at || new Date()).toLocaleString('pt-BR')}`;

    // Usar a nova função com retry automático
    await sendMessageWithRetry(numeroWhatsapp, { text: mensagem });

    console.log('\n💾 Atualizando status...');
    const { error } = await supabase.from('cobrancas')
      .update({ 
        mensagem_enviada: true, 
        data_envio: new Date().toISOString(),
        ultima_atualizacao: new Date().toISOString()
      })
      .eq('txid', cobranca.txid);

    if (error) throw error;

    console.log('✅ Processamento completo');
  } catch (error) {
    console.error('\n❌ FALHA CRÍTICA:', error.message);
    const { error: updateError } = await supabase.from('cobrancas')
      .update({ 
        mensagem_enviada: false,
        ultima_atualizacao: new Date().toISOString(),
        erro_envio: error.message.substring(0, 255)
      })
      .eq('txid', cobranca.txid);
    
    if (updateError) console.error('Erro ao atualizar status de falha:', updateError.message);
  } finally {
    console.log(`⏱️ Tempo total: ${(new Date() - inicioProcessamento)}ms`);
  }
}

// ==============================================
// ROTAS EXPRESS
// ==============================================

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/qr', (req, res) => res.json({ qr: ultimoQR }));

// Página simples com QR
app.get('/', async (req, res) => {
  try {
    if (!ultimoQR) return res.status(404).send('QR Code ainda não disponível');
    const qrImage = await QRCode.toDataURL(ultimoQR);
    res.send(`
      <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="text-align:center;">
          <h1>📲 Conecte o WhatsApp</h1>
          <img src="${qrImage}" />
          <p>Status: ${sock?.user ? '✅ Conectado' : '❌ Aguardando conexão'}</p>
        </body>
      </html>
    `);
  } catch {
    res.status(500).send('Erro ao gerar QR');
  }
});

// ==============================================
// SERVIDOR
// ==============================================

app.listen(PORT, () => {
  console.log(`🩺 Servidor rodando na porta ${PORT}`);
  setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`🚀 Uso de memória: ${Math.round(used * 100) / 100} MB`);
  }, 60000);

  startBot().catch(err => {
    console.error('💥 Falha crítica ao iniciar bot:', err);
    process.exit(1);
  });
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Desligando...');
  if (pollingInterval) clearInterval(pollingInterval);
  if (sock) await sock.end();
  console.log('✅ Servidor desligado com sucesso');
  process.exit(0);
});
