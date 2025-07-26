import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

let ultimoQR = null;

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

// Variável para controlar reconexões
let reconectando = false;

async function baixarAuthDoSupabase() {
  console.log('🔄 Baixando arquivos de autenticação...');
  try {
    await fs.mkdir(authFolder, { recursive: true });
    
    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 100 });

    if (error) throw error;

    for (const file of files) {
      // Pula arquivos temporários
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

    const sock = baileys.makeWASocket({
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
        escutarSupabase(sock); // AQUI estava o erro, se sock não estivesse definido antes
      }
    });

    return sock;
  } catch (error) {
    console.error('🚨 Erro ao iniciar bot:', error);
    throw error;
  }
}

function escutarSupabase(sock) {
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
        // Envio otimizado sem armazenar mensagens em memória
        await sock.sendMessage(numero, { text: mensagem });
        console.log(`📤 Mensagem enviada para ${numero}`);
        
        // Atualização seletiva para economizar recursos
        await supabase
          .from('pagamentos')
          .update({ mensagem_enviada: true })
          .eq('txid', pagamento.txid)
          .select('txid'); // Seleciona apenas o campo necessário
      } catch (error) {
        console.error('⚠️ Erro ao enviar mensagem:', error.message);
      }
    })
    .subscribe();
}

// Health check endpoint
const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Rota para retornar o QR em JSON (se estiver guardando em variável)
app.get('/qr', (req, res) => {
  res.json({ qr: latestQR });
});

// Rota raiz serve o QR gerado como imagem (modo simples direto no navegador)
app.get('/', async (req, res) => {
  try {
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

// Inicialização segura com monitoramento de memória
app.listen(PORT, async () => {
  console.log(`🩺 Health check ativo na porta ${PORT}`);
  
  // Monitoramento de memória
  setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`🚀 Uso de memória: ${Math.round(used * 100) / 100} MB`);
  }, 30000); // A cada 30 segundos

  try {
    await startBot();
    console.log('🤖 Bot iniciado com sucesso!');
  } catch (error) {
    console.error('💥 Erro fatal ao iniciar bot:', error);
    process.exit(1);
  }
});

// Limpeza ao sair
process.on('SIGINT', async () => {
  console.log('🛑 Desconectando...');
  supabase.removeAllChannels();
  process.exit(0);
});

// listener.mjs
import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL, // ex: postgres://user:pass@host:port/dbname
});

await client.connect();

// Escuta o canal 'pagamento_confirmado'
await client.query('LISTEN pagamento_confirmado');

console.log('🟢 Aguardando confirmações de pagamento...');

client.on('notification', async (msg) => {
  if (msg.channel === 'pagamento_confirmado') {
    const payload = JSON.parse(msg.payload);
    console.log('✅ Pagamento confirmado:', payload);

    // Aqui você pode chamar sua função do WhatsApp:
    // await enviarMensagemWhatsApp(payload);
  }
});


const app = express();
app.use(express.json()); // Para receber JSON no body

// Endpoint para receber webhook do Supabase
app.post('/webhook', async (req, res) => {
  const payload = req.body;

  console.log('Recebi webhook:', JSON.stringify(payload, null, 2));

  const oldRow = payload.old; // Dados antes da alteração
  const newRow = payload.new; // Dados depois da alteração

  // Verifica se status mudou de PENDENTE para CONCLUIDO
  if (oldRow?.status === 'PENDENTE' && newRow?.status === 'CONCLUIDO') {
    const telefone = newRow.telefone_cliente;
    const mensagem = 'Seu pagamento foi confirmado. Muito obrigado por escolher a Renotur!';

    try {
      await enviarMensagemWhatsApp(telefone, mensagem);
      console.log('Mensagem enviada para', telefone);

      // Se quiser, pode atualizar a flag no Supabase aqui, para evitar envio duplicado
      // Exemplo (supondo que você tem client supabase configurado):
      // await supabase.from('cobrancas').update({ mensagem_enviada: true }).eq('txid', newRow.txid);
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err);
    }
  }

  res.status(200).send('Webhook recebido');
});

// Sua função para enviar mensagem no WhatsApp
async function enviarMensagemWhatsApp(telefone, texto) {
  // Aqui é sua instância do Baileys conectada (ex: sock)
  // Formate o telefone: deve ser algo tipo "5531999999999@s.whatsapp.net"
  const jid = telefone.replace(/\D/g, '') + '@s.whatsapp.net'; 

  // Exemplo simples:
  await sock.sendMessage(jid, { text: texto });
}

// Porta padrão 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook rodando na porta ${PORT}`));
