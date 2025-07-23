const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // libera CORS, útil se o Flask fizer requisições
app.use(express.json());

let whatsappReady = false;

// Inicializa cliente WhatsApp com autenticação local
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// QR Code no terminal para login
client.on('qr', (qr) => {
    console.log('📲 Escaneie o QR Code com o WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Cliente pronto
client.on('ready', () => {
    whatsappReady = true;
    console.log('✅ Cliente WhatsApp pronto!');
});

// Inicializa cliente
client.initialize();

// Rota teste simples
app.get('/', (req, res) => {
    res.send('✅ Bot WhatsApp está rodando!');
});

// Endpoint para enviar mensagem via GET ou POST
app.all('/enviar', async (req, res) => {
    if (!whatsappReady) {
        return res.status(503).send('❌ WhatsApp ainda não está pronto.');
    }

    // Suporta GET (query) ou POST (json)
    const numero = req.method === 'POST' ? req.body.numero : req.query.numero;
    const mensagem = req.method === 'POST' ? req.body.mensagem : req.query.mensagem;

    if (!numero || !mensagem) {
        return res.status(400).send('❌ Informe os parâmetros "numero" e "mensagem".');
    }

    try {
        // Ajusta o número para formato WhatsApp (ex: adiciona @c.us se faltar)
        let chatId = numero;
        if (!chatId.endsWith('@c.us')) {
            chatId = chatId + '@c.us';
        }

        // Verifica se número existe no WhatsApp
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

// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
