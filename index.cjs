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
let client; // cliente será inicializado depois

// Supabase config
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Função para carregar sessão do Supabase
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
    const json = JSON.parse(Buffer.from(buffer).toString());
    console.log('✅ Sessão restaurada do Supabase');
    return json;
  } catch (err) {
    console.error('❌ Erro ao ler sessão do Supabase:', err);
    return null;
  }
}

// Função para salvar sessão no Supabase
async function salvarSessaoNoSupabase(sessao) {
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

// Inicialização do cliente com a sessão carregada
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
    console.log('📲 Escaneie o QR Code com o WhatsApp:');
    qrcode.generate(qr, { small: true });

    try {
      qrCodeDataURL = await QRCode.toDataURL(qr, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
      console.log('🖼️ QR Code gerado para frontend (base64)');
    } catch (err) {
      console.error('❌ Erro ao gerar QR Code base64:', err);
    }
  });

  client.on('authenticated', async (session) => {
    console.log('🔐 Sessão autenticada. Salvando...');
    await salvarSessaoNoSupabase(session);
  });

  client.on('ready', () => {
    whatsappReady = true;
    qrCodeDataURL = null;
    console.log('✅ Cliente WhatsApp pronto!');
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`🔄 Sincronizando: ${percent}% - ${message}`);
  });

  client.initialize();
})();

// Página com QR Code
app.get('/', (req, res) => {
  let html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Login WhatsApp Bot</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        background: #f5f5f5;
      }
      h1 { color: #2e7d32; }
      #qr {
        margin-top: 20px;
        border: 2px solid #2e7d32;
        padding: 10px;
        background: white;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
      }
      #status {
        margin-top: 15px;
        font-size: 1.1rem;
        color: ${whatsappReady ? '#2e7d32' : '#c62828'};
      }
      #instructions {
        margin-top: 10px;
        font-size: 0.9rem;
        color: #555;
      }
    </style>
  </head>
  <body>
    <h1>WhatsApp Bot - Autenticação</h1>
    <div id="status">${whatsappReady ? '✅ Bot pronto e conectado!' : '⌛ Aguardando QR Code para autenticação...'}</div>
  `;

  if (!whatsappReady && qrCodeDataURL) {
    html += `<img id="qr" src="${qrCodeDataURL}" alt="QR Code para login" width="300" height="300" />`;
    html += `<div id="instructions">Escaneie o QR Code acima com o WhatsApp para conectar o bot.</div>`;
  } else if (!whatsappReady && !qrCodeDataURL) {
    html += `<div id="instructions">QR Code ainda não gerado.<br>Por favor, aguarde no terminal até aparecer o QR Code.</div>`;
  }

  html += `
  <script>
    setTimeout(() => location.reload(), 15000);
  </script>
  </body>
  </html>
  `;

  res.send(html);
});

// Endpoint para enviar mensagem
app.all('/enviar', async (req, res) => {
  if (!whatsappReady) {
    return res.status(503).send('❌ WhatsApp ainda não está pronto.');
  }

  const numero = req.method === 'POST' ? req.body.numero : req.query.numero;
  const mensagem = req.method === 'POST' ? req.body.mensagem : req.query.mensagem;

  if (!numero || !mensagem) {
    return res.status(400).send('❌ Informe os parâmetros "numero" e "mensagem".');
  }

  try {
    let chatId = numero;
    if (!chatId.endsWith('@c.us')) {
      chatId += '@c.us';
    }

    const contato = await client.getNumberId(chatId);
    if (!contato) {
      return res.status(404).send('❌ Número não encontrado no WhatsApp.');
    }

    await client.sendMessage(contato._serialized, mensagem);
    console.log(`📤 Mensagem enviada para ${numero}: ${mensagem}`);
    res.send(`✅ Mensagem enviada para ${numero}`);
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem:', err);
    res.status(500).send('❌ Erro ao enviar mensagem.');
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
