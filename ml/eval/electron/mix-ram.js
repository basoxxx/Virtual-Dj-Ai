// RAM dell'app completa durante un mix: si avvia il vero src/main/main.js (con una cartella dati
// temporanea, la libreria dell'utente non viene toccata), si caricano due brani sui deck, si mettono
// in riproduzione (volume master a zero) e si analizza in background il resto della libreria.
// Campiona ogni 100 ms il working set di tutti i processi dell'app, anche dopo la chiusura del worker.
//
// Uso: npx electron ml/eval/electron/mix-ram.js --engine ai|classic [--model beat_this-small0-int8.onnx]
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const engine = arg('engine', 'ai');
const out = path.join(REPO, 'ml', 'data', 'reference', `mix-ram-${engine}.json`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdjai-mixram-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: engine, autoAnalyze: false } }));

const MB = (b) => Math.round(b / 1048576);
const samples = [];
function sample(phase) {
  let total = 0;
  const byType = {};
  for (const m of app.getAppMetrics()) {
    const ws = m.memory.workingSetSize * 1024;
    total += ws;
    byType[m.type] = (byType[m.type] || 0) + ws;
  }
  samples.push({ t: Date.now(), phase, total, renderer: byType.Tab || 0 });
}

require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let phase = 'avvio';
  const timer = setInterval(() => sample(phase), 100);
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.library && dj.analyzer && dj.decks.length === 2)'))) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 2000));
  phase = 'app pronta';
  await new Promise((r) => setTimeout(r, 2000));
  const files = JSON.parse(fs.readFileSync(path.join(AUDIO, 'manifest.json'), 'utf8')).map((m) => path.join(AUDIO, m.file));
  const t0 = Date.now();
  phase = 'mix + analisi';
  const n = await js(`(async () => {
    dj.engine.masterGain.gain.value = 0;
    const res = await dj.api.addFiles(${JSON.stringify(files)});
    dj.library.setLibrary(res.snapshot);
    const tracks = dj.library.lib.tracks;
    const find = (name) => tracks.find((t) => t.path.endsWith(name));
    await dj.loadTrack(find('Realizer.mp3'), 'A');
    await dj.loadTrack(find('Miami Viceroy.mp3'), 'B');
    dj.decks[0].play();
    dj.decks[1].play();
    await dj.analyzer.run(tracks);
    return tracks.length;
  })()`);
  const analysisMs = Date.now() - t0;
  const report = await js(`dj.library.lib.tracks.map((t) => ({ file: t.path.split('/').pop(), bpm: t.bpm, engine: t.bpmEngine, confidence: t.bpmConfidence }))`);
  phase = 'solo mix';
  await new Promise((r) => setTimeout(r, 5000));
  // il worker di analisi si chiude dopo 20 s senza richieste: la memoria WASM deve tornare libera
  phase = 'attesa';
  await new Promise((r) => setTimeout(r, 20000));
  phase = 'mix, worker chiuso';
  await new Promise((r) => setTimeout(r, 5000));
  clearInterval(timer);
  const peak = (ph) => {
    const s = samples.filter((x) => !ph || x.phase === ph);
    return { totalMB: MB(Math.max(...s.map((x) => x.total))), rendererMB: MB(Math.max(...s.map((x) => x.renderer))) };
  };
  const result = {
    engine, tracks: n, analysisSeconds: Math.round(analysisMs / 100) / 10,
    ready: peak('app pronta'), mixAndAnalysis: peak('mix + analisi'), mixOnly: peak('solo mix'), mixWorkerClosed: peak('mix, worker chiuso'),
    fallbacks: report.filter((r) => engine === 'ai' && r.engine !== 'ai').length, report,
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ ...result, report: undefined }));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
