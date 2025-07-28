import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import makeWASocket from '@whiskeysockets/baileys/lib/Socket';  // Caminho específico da v5
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
      version: [2, 2413, 1],
      browser: ["Renotur", "Bot", "1.0"],
      markOnlineOnConnect: true,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 10_000, // 👈 Adicionada essa linha
      logger: { level: 'warn' }
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

// Adicione esta função no início do seu arquivo (antes de processarCobranca)
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
    // 1. Diagnóstico completo da tabela
    console.log('\n🔍 Analisando estado atual das cobranças...');
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

    // 2. Consulta principal OTIMIZADA para pegar as mais recentes primeiro
    const { data: cobrancas, error, count } = await supabase
      .from('cobrancas')
      .select('*', { count: 'exact' })
      // Filtro por status concluído (inclua outros status se necessário)
      .or('status.eq.concluido,status.eq.Concluído,status.eq.CONCLUIDO,status.eq.PAGO')
      // Filtro por mensagem não enviada
      .or('mensagem_enviada.eq.false,mensagem_enviada.is.null')
      // Ordenação por data DESCENDENTE (mais recentes primeiro)
      .order('created_at', { ascending: false })
      // Filtro para garantir que tem telefone
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
      console.log(`\n📦 Processando ${cobrancas.length} cobrança(s) das mais recentes:`);
      
      for (const cobranca of cobrancas) {
        console.log('\n⚙️ ========== INÍCIO PROCESSAMENTO ==========');
        console.log('📄 Dados completos:', {
          txid: cobranca.txid,
          status: cobranca.status,
          valor: cobranca.valor,
          telefone: cobranca.telefone_cliente,
          data: cobranca.created_at || 'SEM DATA',
          mensagem_enviada: cobranca.mensagem_enviada
        });

        await processarCobranca(cobranca);
        console.log('✅ ========= FIM PROCESSAMENTO ==========\n');
      }
    } else {
      console.log('\n⏭️ Nenhuma cobrança elegível encontrada');
    }

  } catch (error) {
    console.error('\n❌ ERRO CRÍTICO:', {
      mensagem: error.message,
      stack: error.stack,
      hora: new Date().toISOString()
    });
  } finally {
    console.log(`\n⏱️ Tempo total da verificação: ${(new Date() - horaInicio)}ms`);
  }
}

// ... (mantenha todas as importações e configurações iniciais originais até a linha 58)

// ==============================================
// FUNÇÕES AUXILIARES ATUALIZADAS
// ==============================================

async function processarCobranca(cobranca) {
  const inicioProcessamento = new Date();
  
  try {
    // 1. Validação EXTRA do telefone
    console.log('\n📱 Validando telefone...');
    let telefoneLimpo = String(cobranca.telefone_cliente)
      .replace(/\D/g, '')
      .replace(/[\u202A-\u202E]/g, '');

    // Correção para DDD 11 sem nono dígito
    if (telefoneLimpo.length === 10 && telefoneLimpo.startsWith('11')) {
      telefoneLimpo = telefoneLimpo.substring(0, 2) + '9' + telefoneLimpo.substring(2);
    }

    if (telefoneLimpo.length < 11) {
      throw new Error(`Telefone inválido: ${telefoneLimpo}`);
    }
    
    const numeroWhatsapp = `55${telefoneLimpo}@s.whatsapp.net`;

    // 2. Verificação REAL no WhatsApp (com timeout)
    console.log('\n🔍 Verificando existência do número...');
    const [resultado] = await Promise.race([
      sock.onWhatsApp(numeroWhatsapp),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout na verificação')), 5000))
    ]);
    
    if (!resultado?.exists) {
      throw new Error(`Número não registrado no WhatsApp: ${telefoneLimpo}`);
    }

    // 3. Formatação da mensagem
    console.log('\n✉️ Formatando mensagem...');
    const valorFormatado = cobranca.valor.toFixed(2).replace('.', ',');
    const mensagem = cobranca.mensagem_confirmação || 
      `✅ Pagamento confirmado! Obrigado por confiar na Renotur ✨🚌\n` +
      `💵 Valor: R$${valorFormatado}\n` +
      `📅 Data: ${new Date(cobranca.created_at || new Date()).toLocaleString('pt-BR')}`;

    // 5. Envio com confirmação de entrega
    console.log('\n✈️ Enviando mensagem com confirmação...');
    const messageSent = await sock.sendMessage(numeroWhatsapp, { 
      text: mensagem,
      footer: ' ', // Importante para contornar restrições
      buttons: [{
        buttonId: 'ack',
        buttonText: { displayText: ' ' }, // Botão invisível
        type: 1
      }]
    });

    // 6. Verificação de entrega
    console.log('\n🔎 Confirmando entrega...');
    const status = await sock.fetchStatus(numeroWhatsapp).catch(() => null);
    if (!status) {
      throw new Error('Mensagem não confirmada no dispositivo destino');
    }

    // 7. Atualização no banco
    console.log('\n💾 Atualizando status...');
    const { error } = await supabase
      .from('cobrancas')
      .update({ 
        mensagem_enviada: true,
        data_envio: new Date().toISOString()
      })
      .eq('txid', cobranca.txid);

    if (error) throw error;
    console.log('✅ Processamento completo');

  } catch (error) {
    console.error('\n❌ FALHA CRÍTICA:', error.message);
    
    // Tentativa de fallback manual
    try {
      await sock.sendMessage(numeroWhatsapp, {
        text: `⚠️ Mensagem automática falhou: ${error.message.substring(0, 100)}`
      });
    } catch (e) {
      console.log('Fallback também falhou:', e.message);
    }

    // Atualização de erro no banco
    await supabase
      .from('cobrancas')
      .update({ 
        mensagem_enviada: false
      })
      .eq('txid', cobranca.txid)
      .catch(e => console.error('Falha ao registrar erro:', e));
  } finally {
    console.log(`⏱️ Tempo total: ${(new Date() - inicioProcessamento)}ms`);
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
