// npm run models: scarica i modelli ONNX dalla GitHub Release indicata in scripts/models.json
// dentro src/renderer/models/ (esclusa da git) e ne verifica lo SHA-256.
// Senza argomenti scarica i modelli inclusi nell'app ("bundle": true); con --all anche gli altri.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const manifest = require('./models.json');
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'models');
const all = process.argv.includes('--all');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(model) {
  const dest = path.join(OUT, model.file);
  if (fs.existsSync(dest) && sha256(dest) === model.sha256) {
    console.log(`✓ ${model.file} già presente`);
    return;
  }
  const url = `https://github.com/${manifest.repo}/releases/download/${manifest.release}/${model.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${model.file}: HTTP ${res.status} da ${url}`);
  const tmp = `${dest}.download`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const got = sha256(tmp);
  if (got !== model.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${model.file}: SHA-256 non valido (${got})`);
  }
  fs.renameSync(tmp, dest);
  console.log(`✓ ${model.file} (${(model.bytes / 1e6).toFixed(1)} MB)`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const m of manifest.models.filter((x) => all || x.bundle)) await download(m);
})().catch((err) => {
  console.error(`Download dei modelli non riuscito: ${err.message}`);
  process.exit(1);
});
