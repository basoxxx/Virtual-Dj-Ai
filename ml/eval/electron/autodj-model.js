// Prova d'integrazione: l'AI DJ dell'app vera esegue una transizione con il modello C.
// Avvia src/main/main.js con una cartella dati temporanea, mette in coda due brani (Realizer → Miami Viceroy),
// sceglie "Modello AI (sperimentale)" con 8 battute, anticipa il mix e registra crossfader, EQ e filtri
// durante la transizione (volume master a zero). Uso: npx electron ml/eval/electron/autodj-model.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const OUT = path.join(REPO, 'ml', 'data', 'reference', 'autodj-model.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdjai-autodj-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: false } }));
require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix && dj.library)'))) await new Promise((r) => setTimeout(r, 200));
  const files = ['Realizer.mp3', 'Miami Viceroy.mp3'].map((f) => path.join(AUDIO, f));
  const result = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    dj.engine.masterGain.gain.value = 0;
    const res = await dj.api.addFiles(${JSON.stringify(files)});
    dj.library.setLibrary(res.snapshot);
    const t = dj.library.lib.tracks;
    const a = dj.automix;
    a.setOptions({ mode: 'queue', style: 'model', bars: 8 });
    a.setQueue([t.find((x) => x.path.endsWith('Realizer.mp3')), t.find((x) => x.path.endsWith('Miami Viceroy.mp3'))]);
    a.setEnabled(true);
    // si aspetta il piano completo: con il modello le curve arrivano dopo l'analisi di entrambi i brani
    for (let i = 0; i < 900 && !(a.plan && a.plan.curves) && !a.log.some((l) => /uso le regole/.test(l.text || l)); i++) await sleep(100);
    const plan = a.plan ? { type: a.plan.type, bars: a.plan.bars, hasCurves: Boolean(a.plan.curves), why: a.plan.why } : null;
    a.mixNow();
    const samples = [];
    const ctl = () => dj.mixerUI.controls;
    let started = false;
    for (let i = 0; i < 800; i++) {
      if (a.transition) started = true;
      if (started) {
        const c = ctl();
        samples.push({ xf: dj.engine.crossfader, A: ['low', 'mid', 'high'].map((b) => c.A.eq[b].getValue()), B: ['low', 'mid', 'high'].map((b) => c.B.eq[b].getValue()), fA: c.A.filter.getValue(), fB: c.B.filter.getValue() });
        if (!a.transition) break;
      }
      await sleep(50);
    }
    a.setEnabled(false);
    return { plan, samples, diary: a.log.map((l) => l.text || l) };
  })()`);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  const s = result.samples;
  const range = (f) => (s.length ? [Math.min(...s.map(f)), Math.max(...s.map(f))].map((v) => Math.round(v * 100) / 100) : null);
  console.log(JSON.stringify({
    plan: result.plan, campioni: s.length, crossfader: range((x) => x.xf),
    eqA: [0, 1, 2].map((i) => range((x) => x.A[i])), eqB: [0, 1, 2].map((i) => range((x) => x.B[i])),
    filtroA: range((x) => x.fA), filtroB: range((x) => x.fB),
  }));
  for (const line of result.diary.slice(-8)) console.log('  diario:', typeof line === 'string' ? line : JSON.stringify(line));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
