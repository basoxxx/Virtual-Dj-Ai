// Prova d'integrazione del mashup nell'app vera: separazione di voce e base (Demucs in onnxruntime-web)
// e transizione mashup dell'AI DJ. Coda: Miami Viceroy (124 BPM) → Electro Cabello (117 BPM), tonalità fissata a Am.
// Il primo brano si separa prima di partire (in una sessione vera lo si fa quando è ancora "il prossimo"),
// il secondo mentre il primo suona: la RAM di quella fase è quella che conta per il limite durante il mix.
// Misura tempo di separazione per brano e RAM di tutti i processi (volume master a zero).
// Uso: npx electron ml/eval/electron/mashup.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const OUT = path.join(REPO, 'ml', 'data', 'reference', 'mashup.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdjai-mashup-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'classic', autoAnalyze: false } }));
// il modello si copia invece di riscaricarlo (il download è provato a parte)
fs.mkdirSync(path.join(tmp, 'models'));
fs.copyFileSync(path.join(REPO, 'ml', 'data', 'onnx', 'htdemucs.onnx'), path.join(tmp, 'models', 'segueo-separazione-voce.onnx'));
require(path.join(REPO, 'src', 'main', 'main.js'));

const MB = (b) => Math.round(b / 1048576);
const samples = [];
let phase = 'avvio';
function sample() {
  let total = 0;
  let renderer = 0;
  for (const m of app.getAppMetrics()) {
    const ws = m.memory.workingSetSize * 1024;
    total += ws;
    if (m.type === 'Tab') renderer += ws;
  }
  samples.push({ phase, total, renderer });
}

app.whenReady().then(async () => {
  const timer = setInterval(sample, 200);
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix && dj.stems)'))) await new Promise((r) => setTimeout(r, 200));
  const files = ['Miami Viceroy.mp3', 'Electro Cabello.mp3'].map((f) => path.join(AUDIO, f));
  await js(`(async () => {
    dj.engine.masterGain.gain.value = 0;
    window.__stemLog = [];
    dj.stems.addEventListener('change', (e) => {
      const r = e.detail.running;
      const last = window.__stemLog[window.__stemLog.length - 1];
      const title = r ? r.track.title : null;
      if (!last || last.title !== title) window.__stemLog.push({ title, t: performance.now() });
    });
    const res = await dj.api.addFiles(${JSON.stringify(files)});
    dj.library.setLibrary(res.snapshot);
    const t = dj.library.lib.tracks;
    // tonalità fissata (stessa scala): la prova riguarda il flusso del mashup, non la stima della tonalità
    for (const x of t) {
      x.key = 'Am';
      await dj.api.updateTrack(x.id, { key: 'Am' });
    }
    window.__tracks = [t.find((x) => x.path.endsWith('Miami Viceroy.mp3')), t.find((x) => x.path.endsWith('Electro Cabello.mp3'))];
  })()`);
  phase = 'separazione senza mix';
  await js('dj.stems.ensure(window.__tracks[0])');
  await js(`(() => {
    const a = dj.automix;
    a.setOptions({ mode: 'queue', style: 'auto', bars: 8, mashup: true });
    a.setQueue(window.__tracks);
    a.setEnabled(true);
  })()`);
  phase = 'mix + separazione';
  // attesa del mashup pronto (o fallito)
  for (let i = 0; i < 1800; i++) {
    const st = await js('dj.automix.plan && dj.automix.plan.mashup ? dj.automix.plan.mashup.status : null');
    if (st === 'ready' || st === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  phase = 'mashup';
  const result = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const a = dj.automix;
    const plan = a.plan ? { type: a.plan.type, mashup: a.plan.mashup } : null;
    a.mixNow();
    const trace = [];
    let started = false;
    for (let i = 0; i < 2400; i++) {
      if (a.transition) started = true;
      if (started) {
        trace.push({ t: Math.round(performance.now()), xf: Math.round(dj.engine.crossfader * 100) / 100, A: dj.decks[0].stem, B: dj.decks[1].stem, playingB: dj.decks[1].playing });
        if (!a.transition) break;
      }
      await sleep(100);
    }
    a.setEnabled(false);
    return { plan, trace, stemLog: window.__stemLog, diary: a.log.map((l) => l.text || l) };
  })()`);
  phase = 'fine';
  await new Promise((r) => setTimeout(r, 2000));
  clearInterval(timer);
  const peak = (ph) => {
    const s = samples.filter((x) => x.phase === ph);
    return s.length ? { totalMB: MB(Math.max(...s.map((x) => x.total))), rendererMB: MB(Math.max(...s.map((x) => x.renderer))) } : null;
  };
  const sep = [];
  for (let i = 0; i < result.stemLog.length - 1; i++) {
    if (result.stemLog[i].title) sep.push({ title: result.stemLog[i].title, seconds: Math.round((result.stemLog[i + 1].t - result.stemLog[i].t) / 100) / 10 });
  }
  const trace = result.trace;
  const phases = [...new Set(trace.map((x) => `${x.A}/${x.B}`))];
  const out = { plan: result.plan, separazione: sep, ram: { separazioneSenzaMix: peak('separazione senza mix'), mixPiuSeparazione: peak('mix + separazione'), mashup: peak('mashup') }, statiDeck: phases, campioni: trace.length, diary: result.diary };
  fs.writeFileSync(OUT, JSON.stringify({ ...out, trace }, null, 1));
  console.log(JSON.stringify(out, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
