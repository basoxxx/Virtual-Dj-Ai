// Foto delle impostazioni dell'AI per il sito (site/img/settings-ai.jpg) dall'app vera: Impostazioni → AI locale,
// motore di analisi AI con il modello installato. Stessa inquadratura della foto precedente (finestra modale a 2x).
// Uso: npx electron ml/eval/electron/site-settings-ai.js
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const OUT = path.join(REPO, 'site', 'img', 'settings-ai.jpg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-site-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: true }, updates: { auto: false } }));
require(path.join(REPO, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix)'))) await new Promise((r) => setTimeout(r, 200));
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await js("dj.openSettings('ai')");
  // stato del modello (controllo asincrono) e animazione della finestra
  for (let i = 0; i < 50 && !(await js("Boolean(document.querySelector('.settings .ai-test.ok'))")); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 800));
  const rect = await js(`(() => { const b = document.querySelector('.modal.settings').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip: { ...rect, scale: 1 } });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify(rect));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
