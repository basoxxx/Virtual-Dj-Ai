// Analisi ibrida nell'app vera: si carica un brano mai analizzato sul deck A (motore AI) e si misura
// quando arriva il risultato classico e quando la rifinitura AI. Uso: npx electron ml/eval/electron/hybrid.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const FILE = path.join(REPO, 'ml', 'data', 'audio', 'cc', 'Realizer.mp3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdjai-hybrid-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: false } }));
require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.library)'))) await new Promise((r) => setTimeout(r, 200));
  const out = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const res = await dj.api.addFiles(${JSON.stringify([FILE])});
    dj.library.setLibrary(res.snapshot);
    const t = dj.library.lib.tracks[0];
    const d = dj.decks[0];
    const t0 = performance.now();
    await dj.loadTrack(t, 'A');
    const loaded = performance.now() - t0;
    let classic = null, ai = null, firstBpm = null, firstOffset = null;
    for (let i = 0; i < 600 && !ai; i++) {
      if (!classic && d.bpm && t.bpmEngine === 'classic') { classic = performance.now() - t0; firstBpm = d.bpm; firstOffset = d.gridOffset; }
      if (t.bpmEngine === 'ai') ai = performance.now() - t0;
      await sleep(50);
    }
    return { loadedMs: Math.round(loaded), classicMs: Math.round(classic), aiMs: Math.round(ai), classic: { bpm: firstBpm, offset: firstOffset },
             ai: { bpm: d.bpm, offset: d.gridOffset, confidence: t.bpmConfidence, mixOut: t.mixOut }, engine: t.bpmEngine };
  })()`);
  console.log(JSON.stringify(out));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
