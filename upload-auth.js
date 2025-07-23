const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const folderPath = path.join(__dirname, 'auth'); // pasta local de autenticação
const bucket = 'auth-session';

async function uploadFolder(folder, prefix = '') {
  const files = fs.readdirSync(folder);

  for (const file of files) {
    const filePath = path.join(folder, file);
    const storagePath = prefix ? `${prefix}/${file}` : file;

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      await uploadFolder(filePath, storagePath);
    } else {
      const fileBuffer = fs.readFileSync(filePath);

      const { data, error } = await supabase.storage
        .from(bucket)
        .upload(storagePath, fileBuffer, {
          upsert: true,
          contentType: 'application/octet-stream',
        });

      if (error) {
        console.error(`Erro ao enviar ${storagePath}:`, error.message);
      } else {
        console.log(`✅ Enviado: ${storagePath}`);
      }
    }
  }
}

uploadFolder(folderPath).then(() => {
  console.log('✨ Upload completo.');
});
