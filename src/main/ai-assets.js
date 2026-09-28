// Modelli AI scaricati su richiesta (es. Demucs per i mashup, troppo grande per l'installer) e parti
// separate dei brani (voce e base), nella cartella dati dell'utente.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('./models.json');
const { download } = require('./updater');

const STEM_KINDS = new Set(['vocals', 'instrumental']);

function entry(name) {
  const m = manifest.models.find((x) => x.file === name && x.onDemand);
  if (!m) throw new Error(`Modello sconosciuto: ${name}`);
  return m;
}

function modelsDir(userData) {
  return path.join(userData, 'models');
}

/** Percorso di un modello scaricato su richiesta, se c'è. */
function downloadedModel(userData, name) {
  if (!/^[\w.-]+\.onnx$/.test(name)) return null;
  const file = path.join(modelsDir(userData), name);
  return fs.existsSync(file) ? file : null;
}

function modelStatus(userData, name, bundledDir = null) {
  const m = entry(name);
  // incluso nell'installer ("bundle": true) oppure scaricato su richiesta
  const bundled = bundledDir && path.join(bundledDir, name);
  const file = bundled && fs.existsSync(bundled) ? bundled : downloadedModel(userData, name);
  const size = file ? fs.statSync(file).size : 0;
  return { name, installed: size === m.bytes, bytes: m.bytes };
}

/** Scarica un modello dalla GitHub Release del manifest, verificandone lo SHA-256. */
async function downloadModel(userData, name, { fetchImpl, onProgress } = {}) {
  const m = entry(name);
  const asset = {
    name: m.file,
    size: m.bytes,
    sha256: m.sha256,
    url: `https://github.com/${manifest.repo}/releases/download/${manifest.release}/${m.file}`,
  };
  await download(asset, { dir: modelsDir(userData), fetchImpl, onProgress });
  return modelStatus(userData, name);
}

// nome di file sicuro per l'id del brano
function stemFile(userData, trackId, kind) {
  if (!STEM_KINDS.has(kind)) throw new Error(`Parte sconosciuta: ${kind}`);
  const id = crypto.createHash('sha1').update(String(trackId)).digest('hex');
  return path.join(userData, 'stems', `${id}.${kind}.wav`);
}

function stemsStatus(userData, trackId) {
  const out = {};
  for (const kind of STEM_KINDS) out[kind] = fs.existsSync(stemFile(userData, trackId, kind));
  return out;
}

async function saveStem(userData, trackId, kind, bytes) {
  const file = stemFile(userData, trackId, kind);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  await fs.promises.rename(tmp, file);
  return true;
}

async function readStem(userData, trackId, kind) {
  const buf = await fs.promises.readFile(stemFile(userData, trackId, kind));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

module.exports = { downloadedModel, modelStatus, downloadModel, stemsStatus, saveStem, readStem, stemFile };
