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
    // 1. Limpeza inicial
    await fs.rm(authFolder, { recursive: true, force: true });
    await fs.mkdir(authFolder, { recursive: true });

    // 2. Configuração robusta do Baileys
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { default: baileys } = await import('@whiskeysockets/baileys');

    const sock = baileys.makeWASocket({
      auth: state,
      logger: baileys.defaultLogger({ level: 'debug' }),
      printQRInTerminal: false, // Removido o deprecated
      getMessage: async () => ({}),
      browser: ["Ubuntu", "Chrome", "20.0.0"] // Fixo para evitar problemas
    });

    // 3. Gerenciamento de QR Code manual
    let qrGenerated = false;
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Geração do QR Code
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

      // Tratamento de conexão
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`🔌 Conexão fechada, ${shouldReconnect ? 'reconectando...' : 'faça login novamente'}`);
        
        if (shouldReconnect) {
          setTimeout(startBot, 10000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com SUCESSO!');
        iniciarServicos(sock); // Função que inicia todos os serviços
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', () => {});

    return sock;
  } catch (error) {
    console.error('🚨 ERRO CRÍTICO no bot:', error);
    setTimeout(startBot, 20000); // Reconexão mais robusta
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
  console.log('🔔 Configurando listener do Supabase...');

  // 1. Criação do canal com reconexão automática
  const channel = supabase
    .channel('pagamentos-realtime-v2', {
      config: { 
        presence: { key: 'pagamentos-listener' },
        broadcast: { self: true }
      }
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'pagamentos'
    }, async (payload) => {
      console.log('📦 Evento recebido:', JSON.stringify(payload, null, 2));
      
      // 2. Validação rigorosa dos dados
      if (!payload.new || payload.new.status !== 'concluido' || payload.new.mensagem_enviada) {
        return console.log('⏭️ Evento ignorado (não é um pagamento concluído)');
      }

      try {
        // 3. Formatação garantida do número
        const numero = String(payload.new.telefone_cliente).replace(/\D/g, '');
        if (numero.length < 11) {
          throw new Error(`Número inválido: ${payload.new.telefone_cliente}`);
        }
        const jid = `${numero}@s.whatsapp.net`;
        
        // 4. Envio da mensagem
        console.log(`📤 Enviando para ${jid}...`);
        await sock.sendMessage(jid, { 
          text: payload.new.mensagem_confirmação || '✅ Pagamento confirmado com sucesso!' 
        });
        
        // 5. Atualização no banco
        const { error } = await supabase
          .from('pagamentos')
          .update({ mensagem_enviada: true })
          .eq('txid', payload.new.txid);
        
        if (error) throw error;
        console.log('✔️ Pagamento marcado como notificado');
        
      } catch (error) {
        console.error('❌ Falha no processamento:', {
          error: error.message,
          payload,
          stack: error.stack
        });
      }
    })
    .subscribe((status, err) => {
      if (err) {
        console.error('❌ Falha na conexão com Supabase Realtime:', err);
        setTimeout(() => escutarSupabase(sock), 5000);
      } else {
        console.log('🔔 Conexão com Supabase Realtime estabelecida!');
      }
    });

  return channel;
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

// Adicione esta rota para testes manuais
app.get('/enviar-manual', async (req, res) => {
  try {
    await sock.sendMessage('553384063915@s.whatsapp.net', {
      text: 'Mensagem de teste manual enviada com sucesso!'
    });
    res.send('Verifique seu WhatsApp!');
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
