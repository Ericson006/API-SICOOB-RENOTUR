import requests
import time
import logging
import os
from datetime import datetime

# Configuração básica de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Serviços para monitorar (configure via environment variables)
SERVICES = {
    "payment": os.getenv("PAYMENT_SERVICE_URL", "https://seu-payment.onrender.com"),
    "whatsapp": os.getenv("WHATSAPP_SERVICE_URL", "https://seu-whatsapp-bot.onrender.com")
}

INTERVAL = 150  # 2.5 minutos (menos que o timeout do Render)

def check_service(url):
    """Verifica um serviço com tratamento básico de erros"""
    try:
        start = time.time()
        r = requests.get(f"{url}/health" if not url.endswith('health') else url, 
                        timeout=5)
        return {
            "status": r.status_code == 200,
            "code": r.status_code,
            "response_time": round(time.time() - start, 2)
        }
    except Exception as e:
        return {
            "status": False,
            "error": str(e)
        }

def run_keepalive():
    """Loop principal de monitoramento"""
    logging.info("🚀 Keepalive iniciado")
    
    while True:
        status = {}
        for name, url in SERVICES.items():
            result = check_service(url)
            status[name] = result
            
            if result.get('status'):
                logging.info(f"✅ {name.upper()} OK ({result['response_time']}s)")
            else:
                logging.warning(f"⚠️ {name.upper()} OFFLINE - {result.get('error', result.get('code', 'Erro desconhecido'))}")
        
        time.sleep(INTERVAL)

if __name__ == '__main__':
    try:
        run_keepalive()
    except KeyboardInterrupt:
        logging.info("👋 Keepalive encerrado")
    except Exception as e:
        logging.error(f"💥 Erro fatal: {str(e)}")
