const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos da pasta static
app.use('/static', express.static(path.join(__dirname, 'static')));

let whatsappReady = false;

// Inicializa cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Gera QR Code no terminal e salva como imagem PNG na pasta static/qrlogin/
client.on('qr', async (qr) => {
    console.log('📲 Escaneie o QR Code com o WhatsApp:');
    qrcode.generate(qr, { small: true });

    try {
        const dir = path.join(__dirname, 'static/qrlogin');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, 'qrlogin.png');
        await QRCode.toFile(filePath, qr, {
            width: 300,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });
        console.log('🖼️ QR Code salvo em:', filePath);
    } catch (err) {
        console.error('❌ Erro ao salvar QR Code:', err);
    }
});

// Confirma que cliente está pronto
client.on('ready', () => {
    whatsappReady = true;
    console.log('✅ Cliente WhatsApp pronto!');
});

client.initialize();

// Rota simples para testar se o bot está rodando
app.get('/', (req, res) => {
    res.send('✅ Bot WhatsApp está rodando!');
});

// Rota para exibir a imagem do QR code no navegador
app.get('/qrlogin', (req, res) => {
    const qrPath = path.join(__dirname, 'static/qrlogin/qrlogin.png');
    if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
    } else {
        res.status(404).send('QR Code ainda não gerado. Por favor, aguarde o código aparecer no terminal e gere o PNG.');
    }
});

// Enviar mensagem via GET ou POST
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

// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
