// Prima di creare l'installer (beforePack di electron-builder: npm run dist e anche la CI): l'app non deve
// uscire senza i modelli AI inclusi ("bundle": true in src/main/models.json) né senza onnxruntime-web, altrimenti
// l'analisi AI manca e nessuno se ne accorge.
const fs = require('node:fs');
const path = require('node:path');
const { FILES: ORT_FILES } = require('./vendor-ort');

const ROOT = path.join(__dirname, '..');

/** Cosa manca per un pacchetto completo (lista vuota = tutto a posto). */
function distProblems(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'main', 'models.json'), 'utf8'));
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const problems = [];
  for (const m of manifest.models.filter((x) => x.bundle)) {
    const rel = `src/renderer/models/${m.file}`;
    let size = -1;
    try {
      size = fs.statSync(path.join(root, rel)).size;
    } catch {
      // manca
    }
    if (size < 0) problems.push(`manca il modello ${rel} (npm run models)`);
    else if (size !== m.bytes) problems.push(`il modello ${rel} è incompleto: ${size} byte invece di ${m.bytes} (npm run models)`);
    if (!builder.includes(rel)) problems.push(`il modello ${rel} ha "bundle": true ma non è tra i file di electron-builder.yml`);
  }
  for (const f of ORT_FILES) {
    const rel = `src/renderer/vendor/onnxruntime-web/${f}`;
    if (!fs.existsSync(path.join(root, rel))) problems.push(`manca ${rel} (npm install copia onnxruntime-web)`);
  }
  return problems;
}

function check(root) {
  const problems = distProblems(root);
  if (problems.length) throw new Error(`Pacchetto senza AI: non lo creo.\n- ${problems.join('\n- ')}`);
}

// electron-builder (beforePack)
exports.default = async function beforePack() {
  check();
};
exports.distProblems = distProblems;

if (require.main === module) {
  try {
    check();
    console.log('Modelli AI e onnxruntime-web presenti');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
