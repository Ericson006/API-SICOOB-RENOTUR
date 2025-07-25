import { createClient } from '@supabase/supabase-js';
import { sendMessage } from './whatsapp-bot.mjs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function setupRealtimeListener() {
  supabase
    .channel('payments-channel')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'pagamentos',
      filter: 'status=eq.concluido'
    }, async (payload) => {
      const payment = payload.new;
      if (payment.mensagem_enviada) return;

      try {
        await sendMessage(payment.telefone_cliente, 
          payment.mensagem_confirmação || '✅ Pagamento confirmado! Obrigada 🙏');
        
        await supabase
          .from('pagamentos')
          .update({ mensagem_enviada: true })
          .eq('txid', payment.txid);
      } catch (err) {
        console.error('Payment processing error:', err.message);
      }
    })
    .subscribe();
}

// Verificação inicial de conexão
supabase.from('pagamentos').select('*').limit(1)
  .then(() => setupRealtimeListener())
  .catch(err => {
    console.error('Supabase connection error:', err.message);
    setTimeout(setupRealtimeListener, 10000);
  });
