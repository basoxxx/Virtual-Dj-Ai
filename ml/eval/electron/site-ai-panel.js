// Foto del pannello AI DJ per il sito (site/img/ai-panel.jpg) dall'app vera: libreria analizzata, coda di 5 brani
// Creative Commons (stessa tonalità, così il piano tiene le 16 battute scelte), stile "Modello AI · dance",
// transizione fotografata a metà (volume master a zero). L'altezza della finestra (Emulation.setDeviceMetricsOverride,
// densità 2x) è la più piccola in cui il pannello si vede tutto senza scorrere.
// Uso: npx electron ml/eval/electron/site-ai-panel.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const OUT = path.join(REPO, 'site', 'img', 'ai-panel.jpg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-site-'));
app.setPath('userData', tmp);
// niente proposta di aggiornamento sopra la foto
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: false }, updates: { auto: false } }));
require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix && dj.library)'))) await new Promise((r) => setTimeout(r, 200));
  const names = ['Realizer.mp3', 'Miami Viceroy.mp3', 'Electro Cabello.mp3', 'Android Sock Hop.mp3', 'Boogie Party.mp3'];
  const files = names.map((f) => path.join(AUDIO, f));
  const state = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    dj.engine.masterGain.gain.value = 0;
    const res = await dj.api.addFiles(${JSON.stringify(files)});
    dj.library.setLibrary(res.snapshot);
    const t = dj.library.lib.tracks;
    for (const x of t) { x.key = 'Am'; await dj.api.updateTrack(x.id, { key: 'Am' }); }
    await dj.analyzer.run(t);
    for (let i = 0; i < 1200 && dj.analyzer.running; i++) await sleep(100);
    const byName = (n) => t.find((x) => x.path.endsWith(n));
    const a = dj.automix;
    a.setOptions({ mode: 'queue', style: 'model', bars: 16 });
    a.setQueue(${JSON.stringify(names)}.map(byName));
    a.setEnabled(true);
    for (let i = 0; i < 900 && !(a.plan && a.plan.curves); i++) await sleep(100);
    a.mixNow();
    for (let i = 0; i < 600 && !a.transition; i++) await sleep(50);
    // a metà della transizione
    for (let i = 0; i < 1200; i++) {
      const tr = a.transition;
      if (tr && (performance.now() - tr.start) / tr.duration >= 0.5) break;
      await sleep(50);
    }
    return { plan: a.plan && a.plan.type, inTransition: Boolean(a.transition) };
  })()`);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  // l'altezza più piccola in cui il contenuto del pannello non deve scorrere
  for (let h = 1100; h <= 2400; h += 50) {
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 2, mobile: false });
    await new Promise((r) => setTimeout(r, 250));
    // il riquadro della scheda AI DJ è l'unico che scorre (il diario ha un suo limite di altezza)
    const fits = await js(`(() => { const p = [...document.querySelectorAll('.side .tab-pane')].find((e) => getComputedStyle(e).display !== 'none'); return p.scrollHeight <= p.clientHeight + 1; })()`);
    if (fits) {
      // un po' di respiro: all'altezza minima la casella della scaletta e la coda si schiacciano
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: h + 180, deviceScaleFactor: 2, mobile: false });
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 900));
  // il diario si ferma all'inizio di una riga intera, con le ultime righe visibili
  await js(`(() => { const log = document.querySelector('.ai-log'); const rows = [...log.children]; let top = log.scrollHeight;
    for (let i = rows.length - 1; i >= 0; i--) { if (log.scrollHeight - rows[i].offsetTop > log.clientHeight) break; top = rows[i].offsetTop; }
    log.scrollTop = Math.max(0, top - 6); return log.scrollTop; })()`);
  await new Promise((r) => setTimeout(r, 300));
  const rect = await js(`(() => { const b = document.querySelector('.side').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ ...state, rect }));
  await js('dj.automix.setEnabled(false)');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
