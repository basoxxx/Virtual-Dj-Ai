// Banco di prova dell'analisi nell'ambiente reale dell'app (Electron, worker, onnxruntime-web WASM
// con thread e isolamento cross-origin, decodifica a 22050 Hz del renderer).
// Misura per ogni brano: tempo, BPM, offset, confidenza e picco di memoria dei processi.
//
// Uso: npx electron ml/eval/electron/main.js --engine ai|classic [--model beat_this-small0-int8.onnx]
//                                           [--files "Realizer.mp3,..."] [--out risultati.json]
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..', '..', '..');
const RENDERER = path.join(REPO, 'src', 'renderer');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const engine = arg('engine', 'ai');
const model = arg('model', 'beat_this-small0-int8.onnx');
const manifest = JSON.parse(fs.readFileSync(path.join(AUDIO, 'manifest.json'), 'utf8'));
const files = arg('files', '') ? arg('files').split(',') : manifest.map((m) => m.file);
const out = arg('out', path.join(REPO, 'ml', 'data', 'reference', `electron-${engine}${engine === 'ai' ? '-' + model.replace('.onnx', '') : ''}.json`));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serve(root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString()).then((res) => {
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return new Response(res.body, { status: res.status, headers });
  });
}

// memoria: somma del working set di tutti i processi (principale, renderer con i worker, GPU…)
let peakTotal = 0;
let peakRenderer = 0;
function sampleMemory() {
  let total = 0;
  let renderer = 0;
  for (const m of app.getAppMetrics()) {
    const ws = m.memory.workingSetSize * 1024;
    total += ws;
    if (m.type === 'Tab') renderer += ws;
  }
  peakTotal = Math.max(peakTotal, total);
  peakRenderer = Math.max(peakRenderer, renderer);
  return { total, renderer };
}
const MB = (b) => Math.round(b / 1048576);

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel.startsWith('__audio/')) return serve(AUDIO, rel.slice(8));
    if (rel.startsWith('__bench/')) return serve(__dirname, rel.slice(8));
    return serve(RENDERER, rel);
  });
  const results = [];
  let baseline = null;
  ipcMain.handle('bench:start', () => {
    baseline = sampleMemory();
    peakTotal = 0;
    peakRenderer = 0;
    return { engine, model, files };
  });
  ipcMain.handle('bench:resetPeak', () => {
    peakTotal = 0;
    peakRenderer = 0;
  });
  ipcMain.handle('bench:track', (_e, r) => {
    const row = { ...r, peakTotalMB: MB(peakTotal), peakRendererMB: MB(peakRenderer) };
    const m = manifest.find((x) => x.file === r.file);
    if (m) row.trueBpm = m.bpm;
    results.push(row);
    console.log(JSON.stringify(row));
  });
  ipcMain.handle('bench:done', (_e, info) => {
    const summary = { engine, model: engine === 'ai' ? model : null, ...info, baselineTotalMB: MB(baseline.total), baselineRendererMB: MB(baseline.renderer), results };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(summary, null, 1));
    console.log(`salvato ${out}`);
    app.quit();
  });
  setInterval(sampleMemory, 50);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadURL('app://dj/__bench/bench.html');
});
