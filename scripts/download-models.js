// npm run models: scarica i modelli ONNX dalla GitHub Release indicata in src/main/models.json
// dentro src/renderer/models/ (esclusa da git) e ne verifica lo SHA-256.
// Senza argomenti scarica i modelli inclusi nell'app ("bundle": true); con --all anche gli altri.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { download } = require('../src/main/updater');

const manifest = require('../src/main/models.json');
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'models');
const all = process.argv.includes('--all');
// senza dati per un minuto la connessione è appesa: in CI un download senza limiti resterebbe fermo per ore
const STALL_MS = 60000;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchModel(model) {
  const dest = path.join(OUT, model.file);
  if (fs.existsSync(dest) && sha256(dest) === model.sha256) {
    console.log(`✓ ${model.file} già presente`);
    return;
  }
  const url = `https://github.com/${manifest.repo}/releases/download/${manifest.release}/${model.file}`;
  // lo stesso download dell'app: dimensione e SHA-256 controllati sul file scritto, niente file a metà
  try {
    await download({ name: model.file, url, size: model.bytes, sha256: model.sha256 }, { dir: OUT, stallMs: STALL_MS });
  } catch (err) {
    throw new Error(`${model.file}: ${err.message} (${url})`);
  }
  console.log(`✓ ${model.file} (${(model.bytes / 1e6).toFixed(1)} MB)`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const m of manifest.models.filter((x) => all || x.bundle)) await fetchModel(m);
})().catch((err) => {
  console.error(`Download dei modelli non riuscito: ${err.message}`);
  process.exit(1);
});
