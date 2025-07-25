import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const authFolder = path.join(__dirname, 'auth');
const bucket = 'auth-session';

async function syncAuthFiles() {
  try {
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

    // Limpar arquivos antigos para evitar acúmulo
    fs.readdirSync(authFolder).forEach(file => {
      fs.unlinkSync(path.join(authFolder, file));
    });

    const { data: files, error } = await supabase.storage
      .from(bucket)
      .list('', { limit: 2 }); // Apenas creds.json e outros essenciais

    if (error) throw error;

    for (const file of files) {
      const { data: signedUrl } = await supabase.storage
        .from(bucket)
        .createSignedUrl(file.name, 60); // URL válida por 1 minuto

      const res = await fetch(signedUrl.signedUrl);
      fs.writeFileSync(path.join(authFolder, file.name), await res.buffer());
    }
    
    console.log('Auth files synced at', new Date().toISOString());
  } catch (err) {
    console.error('Sync error:', err.message);
  } finally {
    setTimeout(syncAuthFiles, 300000); // Sincronizar a cada 5 minutos
  }
}

syncAuthFiles();
