// Prova d'integrazione dei "tagli a raffica (stile LUM!X)": l'AI DJ dell'app vera suona una coda di 3 brani e fa due
// cambi da solo (senza "Mixa ora"). Registra per ogni brano quanto resta in onda, il piano (misure, entrata sul drop)
// e il crossfader intorno ai tagli (volume master a zero). Uso: npx electron ml/eval/electron/autodj-rapid.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const OUT = path.join(REPO, 'ml', 'data', 'reference', 'autodj-rapid.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-rapid-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: false } }));
require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix && dj.library)'))) await new Promise((r) => setTimeout(r, 200));
  const files = ['Realizer.mp3', 'Miami Viceroy.mp3', 'Electro Cabello.mp3'].map((f) => path.join(AUDIO, f));
  const result = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    dj.engine.masterGain.gain.value = 0;
    const res = await dj.api.addFiles(${JSON.stringify(files)});
    dj.library.setLibrary(res.snapshot);
    const t = dj.library.lib.tracks;
    const byName = (n) => t.find((x) => x.path.endsWith(n));
    const a = dj.automix;
    a.setOptions({ mode: 'queue', style: 'rapid' });
    a.setQueue([byName('Realizer.mp3'), byName('Miami Viceroy.mp3'), byName('Electro Cabello.mp3')]);
    a.setEnabled(true);
    const plans = [];
    const onAir = [];
    const trace = [];
    let lastTitle = null;
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) {
      const cur = a.current && a.current();
      const title = cur && cur.track ? cur.track.title : null;
      if (title !== lastTitle) {
        onAir.push({ title, t: (performance.now() - t0) / 1000, position: cur ? cur.position : null });
        lastTitle = title;
      }
      if (a.plan && a.plan.type && !plans.some((p) => p.from === a.plan.fromTrack.title)) {
        plans.push({ from: a.plan.fromTrack.title, to: a.plan.toTrack.title, type: a.plan.type, startAt: a.plan.startAt, mixIn: a.plan.mixIn, why: a.plan.why });
      }
      if (a.transition) trace.push({ t: Math.round(performance.now() - t0), xf: Math.round(dj.engine.crossfader * 100) / 100 });
      if (onAir.length >= 3 && !a.transition) break;
      await sleep(50);
    }
    a.setEnabled(false);
    return { plans, onAir, trace, diary: a.log.map((l) => l.text || l) };
  })()`);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  // tempo in onda di ogni brano (dal momento in cui diventa il deck in onda al taglio successivo)
  const air = result.onAir.filter((x) => x.title);
  const durations = air.slice(0, -1).map((x, i) => ({ title: x.title, secondi: Math.round((air[i + 1].t - x.t) * 10) / 10 }));
  const flips = [];
  for (let i = 1; i < result.trace.length; i++) {
    if (Math.abs(result.trace[i].xf - result.trace[i - 1].xf) > 0.5) flips.push({ ms: result.trace[i].t, da: result.trace[i - 1].xf, a: result.trace[i].xf });
  }
  console.log(JSON.stringify({ plans: result.plans, inOnda: durations, saltiDelCrossfader: flips }, null, 1));
  result.diary.filter((l) => /Transizione|In onda|raffica/.test(l)).forEach((l) => console.log('  diario:', l));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
