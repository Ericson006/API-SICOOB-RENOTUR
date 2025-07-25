import baileys from '@whiskeysockets/baileys';
const { 
  makeWASocket, 
  useSingleFileAuthState, 
  fetchLatestBaileysVersion, 
  DisconnectReason 
} = baileys;

// Configuração básica
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFolder = path.join(__dirname, 'auth');
const authFile = path.join(authFolder, 'creds.json');

// Inicializa o Express
const app = express();
const PORT = process.env.PORT || 3000;

// Controles de conexão
let supabase = null;
let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Health Check Endpoint - ADICIONE ESTA PARTE
app.get('/health', (req, res) => {
  const services = {
    whatsapp: !!sock,
    supabase: !!supabase,
    last_reconnect: reconnectAttempts
  };
  
  const healthy = services.whatsapp && services.supabase;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    services
  });
});

// Inicialização otimizada
async function init() {
  try {
    await setupSupabase();
    await syncAuthFiles();
    await connectWhatsApp();
    setupPaymentListener();
    startHealthChecks();
    
    // Inicia o servidor Express
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check available at http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('Initialization error:', err.message);
    setTimeout(init, 5000);
  }
}

// 1. Conexão com Supabase (com reconexão)
async function setupSupabase() {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    db: { schema: 'public' },
    auth: { persistSession: false }
  });

  // Teste inicial de conexão
  const { error } = await supabase.from('pagamentos').select('*').limit(1);
  if (error) throw error;
}

// 2. Sincronização de arquivos de auth (otimizada)
async function syncAuthFiles() {
  try {
    await fs.mkdir(authFolder, { recursive: true });
    
    const { data: signedUrl } = await supabase.storage
      .from('auth-session')
      .createSignedUrl('creds.json', 60);

    const response = await fetch(signedUrl.signedUrl);
    await fs.writeFile(authFile, Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.warn('Auth sync warning:', err.message);
  }
}

// 3. Conexão WhatsApp (com controle robusto)
async function connectWhatsApp() {
  try {
    const { state, saveState } = useSingleFileAuthState(authFile);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
      browser: ['Bot Pagamentos', 'Linux', '1.0.0'],
      logger: { level: 'warn' } // Reduz logs para economizar memória
    });

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'close') {
        const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          setTimeout(connectWhatsApp, Math.min(5000 * reconnectAttempts, 30000));
        }
      } else if (update.connection === 'open') {
        reconnectAttempts = 0;
        console.log('WhatsApp connected');
      }
    });
  } catch (err) {
    console.error('WhatsApp connection error:', err.message);
    throw err;
  }
}

// 4. Listener de pagamentos (com tratamento de erro)
function setupPaymentListener() {
  const channel = supabase.channel('payments')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'pagamentos',
      filter: 'status=eq.concluido'
    }, async (payload) => {
      const payment = payload.new;
      if (!payment.mensagem_enviada && sock) {
        try {
          await sock.sendMessage(
            `${payment.telefone_cliente.replace(/\D/g, '')}@s.whatsapp.net`,
            { text: payment.mensagem_confirmação || '✅ Pagamento confirmado!' }
          );
          
          await supabase
            .from('pagamentos')
            .update({ mensagem_enviada: true })
            .eq('txid', payment.txid);
        } catch (err) {
          console.error('Payment processing error:', err.message);
        }
      }
    })
    .subscribe(status => {
      if (status === 'CHANNEL_ERROR') {
        setTimeout(setupPaymentListener, 5000);
      }
    });
}

// 5. Sistema de health checks
function startHealthChecks() {
  setInterval(async () => {
    try {
      // Verifica Supabase
      await supabase.from('pagamentos').select('*').limit(1);
      
      // Verifica WhatsApp
      if (sock) {
        await sock.fetchBlocklist();
      }
    } catch (err) {
      console.warn('Health check failed:', err.message);
    }
  }, 30000); // A cada 30 segundos
}

// Inicialização com tratamento de erros
init().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});

// Gerenciamento de memória
setInterval(() => {
  if (global.gc) {
    global.gc(); // Força coleta de lixo se disponível
  }
}, 3600000); // A cada 1 hora
