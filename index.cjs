const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(cors());
app.use(express.json());

let whatsappReady = false;
let qrCodeDataURL = null;
let client;
let autenticado = false;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 🔄 Carrega sessão do Supabase
async function carregarSessaoDoSupabase() {
  const { data, error } = await supabase
    .storage
    .from('auth-session')
    .download('session.json');

  if (error || !data) {
    console.log('⚠️ Nenhuma sessão anterior encontrada. Será necessário escanear o QR.');
    return null;
  }

  try {
    const buffer = await data.arrayBuffer();
    const texto = Buffer.from(buffer).toString();
    if (!texto || texto.trim().length < 10) throw new Error('Sessão JSON vazia ou incompleta.');
    const json = JSON.parse(texto);
    console.log('✅ Sessão restaurada do Supabase');
    return json;
  } catch (err) {
    console.error('❌ Erro ao ler sessão do Supabase:', err);
    return null;
  }
}

// 💾 Salva sessão no Supabase
async function salvarSessaoNoSupabase(sessao) {
  if (!sessao || Object.keys(sessao).length < 3) {
    console.log('⚠️ Sessão não foi salva — objeto inválido.');
    return;
  }

  try {
    const { error } = await supabase
      .storage
      .from('auth-session')
      .upload('session.json', JSON.stringify(sessao), {
        contentType: 'application/json',
        upsert: true
      });

    if (error) throw error;
    console.log('💾 Sessão salva no Supabase');
  } catch (err) {
    console.error('❌ Falha ao salvar sessão no Supabase:', err.message);
  }
}

// 🔍 Verifica cobranças e envia mensagens
async function verificarCobrancasEEnviar() {
  if (!whatsappReady) {
    console.log('⏳ Bot ainda não conectado, aguardando...');
    return;
  }

  console.log('🔎 Buscando cobranças concluídas no Supabase...');
  const { data: cobrancas, error } = await supabase
    .from('cobrancas')
    .select('txid, status, telefone_cliente, mensagem_confirmação, mensagem_enviada')
    .eq('status', 'concluido')
    .eq('mensagem_enviada', false);

  if (error) {
    console.error('❌ Erro ao buscar cobranças:', error);
    return;
  }

  if (!cobrancas || cobrancas.length === 0) {
    console.log('ℹ️ Nenhuma cobrança nova para enviar mensagem.');
    return;
  }

  for (const cobranca of cobrancas) {
    try {
      let chatId = cobranca.telefone_cliente;
      if (!chatId.endsWith('@c.us')) chatId += '@c.us';

      const contato = await client.getNumberId(chatId);
      if (!contato) {
        console.log(`⚠️ Número não encontrado no WhatsApp: ${cobranca.telefone_cliente}`);
        continue;
      }

      await client.sendMessage(contato._serialized, cobranca['mensagem_confirmação']);
      console.log(`✅ Mensagem enviada para ${cobranca.telefone_cliente} (txid: ${cobranca.txid})`);

      const { error: updateError } = await supabase
        .from('cobrancas')
        .update({ mensagem_enviada: true })
        .eq('txid', cobranca.txid);

      if (updateError) {
        console.error('❌ Erro ao marcar mensagem como enviada:', updateError);
      }
    } catch (err) {
      console.error(`❌ Erro ao enviar mensagem da cobrança ${cobranca.txid}:`, err);
    }
  }
}

// 🚀 Inicialização
(async () => {
  const sessionData = await carregarSessaoDoSupabase();

  client = new Client({
    session: sessionData || undefined,
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    if (autenticado) return;

    console.log('📲 Escaneie o QR Code com o WhatsApp abaixo:');
    qrcode.generate(qr, { small: true });

    try {
      qrCodeDataURL = await QRCode.toDataURL(qr);
      console.log('🖼️ QR Code gerado em base64 para frontend');
    } catch (err) {
      console.error('❌ Erro ao gerar QR Code base64:', err);
    }
  });

  client.on('authenticated', async (session) => {
    autenticado = true;
    console.log('🔐 Sessão autenticada com sucesso.');
    await salvarSessaoNoSupabase(session);
  });

  client.on('ready', () => {
    whatsappReady = true;
    qrCodeDataURL = null;
    console.log('✅ Cliente WhatsApp pronto para uso!');
    setInterval(verificarCobrancasEEnviar, 60 * 1000);
  });

  client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`🔄 Sincronizando WhatsApp: ${percent}% - ${message}`);
  });

  client.initialize();
})();

// 🌐 Página de status
app.get('/', (req, res) => {
  let html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>WhatsApp Bot</title>
    <style>
      body {
        font-family: Arial;
        text-align: center;
        padding: 40px;
        background-color: #f7f7f7;
      }
      #status {
        font-size: 20px;
        margin-bottom: 20px;
        color: ${whatsappReady ? 'green' : 'red'};
      }
    </style>
  </head>
  <body>
    <h1>WhatsApp Bot - Autenticação</h1>
    <div id="status">${whatsappReady ? '✅ Bot conectado ao WhatsApp!' : '⌛ Aguardando autenticação via QR Code...'}</div>
  `;

  if (!whatsappReady && qrCodeDataURL) {
    html += `<img src="${qrCodeDataURL}" width="300" height="300" alt="QR Code" /><p>Escaneie com o WhatsApp</p>`;
  }

  html += `
    <script>
      setTimeout(() => location.reload(), 10000);
    </script>
  </body>
  </html>`;

  res.send(html);
});

// 📤 Rota manual para enviar mensagem
app.all('/enviar', async (req, res) => {
  if (!whatsappReady) return res.status(503).send('❌ Bot ainda não está pronto.');

  const numero = req.method === 'POST' ? req.body.numero : req.query.numero;
  const mensagem = req.method === 'POST' ? req.body.mensagem : req.query.mensagem;

  if (!numero || !mensagem) {
    return res.status(400).send('❌ Parâmetros "numero" e "mensagem" são obrigatórios.');
  }

  try {
    let chatId = numero;
    if (!chatId.endsWith('@c.us')) chatId += '@c.us';

    const contato = await client.getNumberId(chatId);
    if (!contato) return res.status(404).send('❌ Número não encontrado no WhatsApp.');

    await client.sendMessage(contato._serialized, mensagem);
    console.log(`📤 Mensagem manual enviada para ${numero}: "${mensagem}"`);
    res.send(`✅ Mensagem enviada para ${numero}`);
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem manual:', err);
    res.status(500).send('❌ Erro interno ao enviar mensagem.');
  }
});

// 🔥 Inicia servidor HTTP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor disponível em http://localhost:${PORT}`);
});
