import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { useMultiFileAuthState, DisconnectReason, makeWASocket } from '@whiskeysockets/baileys';
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
// FUNÇÕES PRINCIPAIS ATUALIZADAS
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

async function startBot() {
  try {
    const authLoaded = await baixarAuthDoSupabase();
    if (!authLoaded) console.warn('⚠️ Continuando sem arquivos de autenticação');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      getMessage: async () => ({}),
      syncFullHistory: false,
      shouldIgnoreJid: () => false,
      connectTimeoutMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
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
            startBot().then(() => reconectando = false);
          }, 10000);
        }
      } else if (connection === 'open') {
        console.log('✅ Conectado ao WhatsApp!');
        iniciarPollingCobrancas();
      }
    });

    return sock;
  } catch (error) {
    console.error('🚨 Erro ao iniciar bot:', error);
    setTimeout(startBot, 15000);
    throw error;
  }
}

// ==============================================
// SISTEMA DE POLLING ATUALIZADO PARA USAR TXID
// ==============================================

function iniciarPollingCobrancas() {
  if (pollingInterval) clearInterval(pollingInterval);
  
  console.log('🔄 Iniciando sistema de polling para cobranças...');
  verificarCobrancasPendentes();
  pollingInterval = setInterval(verificarCobrancasPendentes, 20000);
}

async function verificarCobrancasPendentes() {
  contadorPolling++;
  console.log(`\n🔍 Verificação ${contadorPolling} iniciada em ${new Date().toISOString()}`);

  try {
    // 1. Primeiro verifica se consegue acessar a tabela
    const { data: testeConexao, error: erroConexao } = await supabase
      .from('cobrancas')
      .select('*')
      .limit(1);

    if (erroConexao) {
      console.error('❌ Falha ao acessar tabela cobrancas:', {
        message: erroConexao.message,
        details: erroConexao.details,
        hint: erroConexao.hint,
        code: erroConexao.code
      });
      return;
    }

    // 2. Consulta diagnóstica - mostra o estado real dos dados
    const { data: diagnostico } = await supabase
      .from('cobrancas')
      .select('txid, status, mensagem_enviada, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    console.log('📋 Últimas 5 cobranças no banco:', diagnostico);

    // 3. Consulta principal com tratamento para NULL e verificação de case sensitive
    const { data: cobrancas, error, count } = await supabase
      .from('cobrancas')
      .select('*', { count: 'exact' })
      .or('status.eq.concluido,status.eq.Concluído,status.eq.CONCLUIDO') // várias formas de escrita
      .or('mensagem_enviada.eq.false,mensagem_enviada.is.null') // trata NULL como não enviado
      .order('created_at', { ascending: false }); // mais recentes primeiro

    console.log('🔍 Resultado da consulta:', {
      total_encontrado: count,
      parametros: {
        status: ['concluido', 'Concluído', 'CONCLUIDO'],
        mensagem_enviada: ['false', 'null']
      },
      erro: error?.message
    });

    if (error) throw error;

    if (cobrancas?.length > 0) {
      console.log(`📦 ${cobrancas.length} cobrança(s) para processar`);
      
      // Processa apenas as 10 mais recentes para evitar sobrecarga
      const paraProcessar = cobrancas.slice(0, 10);
      for (const cobranca of paraProcessar) {
        console.log(`⚙️ Processando TXID: ${cobranca.txid}`, {
          status: cobranca.status,
          mensagem_enviada: cobranca.mensagem_enviada,
          created_at: cobranca.created_at
        });
        await processarCobranca(cobranca);
      }
    } else {
      console.log('⏭️ Nenhuma cobrança pendente encontrada com os critérios atuais');
      
      // Verificação adicional para ajudar no diagnóstico
      const { data: concluidas } = await supabase
        .from('cobrancas')
        .select('txid, status, mensagem_enviada')
        .order('created_at', { ascending: false })
        .limit(3);

      console.log('🔍 Exemplos de cobranças existentes:', concluidas);
    }

  } catch (error) {
    console.error('❌ Erro no polling:', {
      message: error.message,
      stack: error.stack,
      details: error.details
    });
  }
}
async function processarCobranca(cobranca) {
  try {
    console.log(`\n🔄 Processando cobrança TXID: ${cobranca.txid}...`);
    
    const numero = `55${String(cobranca.telefone_cliente).replace(/\D/g, '')}@s.whatsapp.net`;
    
    const mensagem = cobranca.mensagem_confirmação || 
                    `✅ Cobrança #${cobranca.txid} confirmada!\n` +
                    `💵 Valor: R$${cobranca.valor || '0,00'}\n` +
                    `📅 Data: ${new Date().toLocaleDateString()}`;

    console.log(`📞 Enviando para: ${numero}`);
    console.log(`✉️ Mensagem: ${mensagem}`);

    await sock.sendMessage(numero, { text: mensagem });
    console.log(`📤 Mensagem enviada com sucesso`);

    const { error } = await supabase
      .from('cobrancas')
      .update({ 
        mensagem_enviada: true,
        data_envio: new Date() 
      })
      .eq('txid', cobranca.txid);

    if (error) throw error;
    console.log(`✔️ Cobrança ${cobranca.txid} marcada como notificada`);

  } catch (error) {
    console.error(`⚠️ Falha ao processar cobrança ${cobranca.txid}:`, error.message);
    
    try {
      await supabase
        .from('cobrancas')
        .update({ 
          mensagem_erro: error.message.substring(0, 255) 
        })
        .eq('txid', cobranca.txid);
    } catch (dbError) {
      console.error('❌ Não foi possível registrar o erro no banco:', dbError.message);
    }
  }
}

// ==============================================
// ROTAS PARA CONTROLE E DIAGNÓSTICO
// ==============================================

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/qr', (req, res) => {
  res.json({ qr: ultimoQR });
});

app.get('/', async (req, res) => {
  try {
    if (!ultimoQR) return res.status(404).send('QR Code ainda não disponível');
    
    const qrImage = await QRCode.toDataURL(ultimoQR); 
    res.send(`
      <html>
        <head>
          <title>WhatsApp Bot - Conexão</title>
          <meta http-equiv="refresh" content="10">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 20px; }
            .container { max-width: 500px; margin: 0 auto; }
            .info { margin-top: 20px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📲 Conecte o WhatsApp</h1>
            <img src="${qrImage}" style="max-width: 300px;"/>
            <p class="info">Escaneie este QR Code com o aplicativo do WhatsApp</p>
            <p class="info">Status: ${sock?.user ? '✅ Conectado' : '❌ Aguardando conexão'}</p>
            <p class="info">Última cobrança processada: ${ultimoTxidProcessado || 'Nenhuma'}</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao gerar página');
  }
});

app.get('/verificar-agora', async (req, res) => {
  try {
    await verificarCobrancasPendentes();
    res.json({ 
      status: 'Verificação concluída',
      contador: contadorPolling,
      ultimoTxidProcessado,
      memoria: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/testar-envio/:telefone', async (req, res) => {
  const { telefone } = req.params;
  
  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }

  try {
    const numero = `55${telefone.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(numero, { 
      text: '✅ Esta é uma mensagem de teste do seu bot de cobranças!' 
    });
    
    res.json({ 
      success: true,
      message: `Mensagem enviada para ${numero}` 
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Falha no envio',
      details: error.message 
    });
  }
});

app.get('/diagnostico-cobranca/:txid', async (req, res) => {
  try {
    const { txid } = req.params;
    const { data: cobranca, error } = await supabase
      .from('cobrancas')
      .select('*')
      .eq('txid', txid)
      .single();

    if (error) throw error;
    
    res.json({
      cobranca,
      criterios: {
        statusConcluido: cobranca.status === 'concluido',
        mensagemNaoEnviada: cobranca.mensagem_enviada === false,
        deveSerProcessada: cobranca.status === 'concluido' && cobranca.mensagem_enviada === false
      },
      sistema: {
        ultimoTxidProcessado,
        sockConectado: !!sock?.user
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==============================================
// INICIALIZAÇÃO DO SERVIDOR
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
  console.log('\n🛑 Desligando o servidor...');
  if (pollingInterval) clearInterval(pollingInterval);
  if (sock) await sock.end();
  console.log('✅ Servidor desligado com sucesso');
  process.exit(0);
});
