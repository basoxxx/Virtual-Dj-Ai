// Foto del pannello AI DJ con una scaletta caricata per la pagina del sito (site/img/setlist.jpg): libreria di
// brani Creative Commons analizzata, risposta in stile Claude negli appunti, "Incolla scaletta", AI DJ avviato
// (volume master a zero). Uso: npx electron ml/eval/electron/site-setlist.js
const { app, BrowserWindow, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..', '..', '..');
const AUDIO = path.join(REPO, 'ml', 'data', 'audio', 'cc');
const OUT = path.join(REPO, 'site', 'img', 'setlist.jpg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-site-'));
app.setPath('userData', tmp);
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ai: { analysisEngine: 'ai', autoAnalyze: false }, updates: { auto: false }, ui: { view: 'console' } }));
require(path.join(REPO, 'src', 'main', 'main.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY = `Ecco la scaletta:
\`\`\`json
{
  "scaletta": "Aperitivo in crescendo",
  "dopo": "fine",
  "impostazioni": { "transizioni": "bass swap", "battute": 16, "energia": "crescente" },
  "brani": [
    { "artista": "Kevin MacLeod", "titolo": "Ether Disco", "entrata": "0:16" },
    { "artista": "Kevin MacLeod", "titolo": "Overcast", "nota": "si entra nel vivo" },
    { "artista": "Kevin MacLeod", "titolo": "Enter the Party", "transizioni": "raffica" },
    { "artista": "Kevin MacLeod", "titolo": "Bummin on Tremelo" },
    { "artista": "Kevin MacLeod", "titolo": "Electro Cabello", "transizioni": "filtro", "battute": 8, "uscita": "2:40" },
    { "artista": "Kevin MacLeod", "titolo": "C-Funk", "transizioni": "dance", "battute": 32 }
  ]
}
\`\`\``;

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  while (!(await js('Boolean(window.dj && dj.automix && dj.library)'))) await sleep(200);
  const names = ['Ether Disco.mp3', 'Overcast.mp3', 'Enter the Party.mp3', 'Bummin on Tremelo.mp3', 'Electro Cabello.mp3', 'C-Funk.mp3'];
  await js(`(async () => {
    dj.engine.masterGain.gain.value = 0;
    const res = await dj.api.addFiles(${JSON.stringify(names.map((f) => path.join(AUDIO, f)))});
    dj.library.setLibrary(res.snapshot);
    await dj.analyzer.run(dj.library.lib.tracks);
  })()`);
  while (await js('dj.analyzer.running')) await sleep(500);
  clipboard.writeText(REPLY);
  await js(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Incolla scaletta').click()`);
  await sleep(500);
  await js(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Avvia AI DJ').click()`);
  for (let i = 0; i < 600 && !(await js('Boolean(dj.automix.plan && Number.isFinite(dj.automix.plan.startAt))')); i++) await sleep(100);
  await sleep(1500);
  await js(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  for (let h = 1100; h <= 2600; h += 50) {
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(250);
    const fits = await js(`(() => { const p = [...document.querySelectorAll('.side .tab-pane')].find((e) => getComputedStyle(e).display !== 'none'); return p.scrollHeight <= p.clientHeight + 1; })()`);
    if (fits) {
      // spazio in più per la coda: si vedono tutti i brani con le loro indicazioni
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: h + 260, deviceScaleFactor: 2, mobile: false });
      break;
    }
  }
  await sleep(900);
  const rect = await js(`(() => { const b = document.querySelector('.side').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ rect, queue: await js('dj.automix.queue.map((t) => t.title)') }));
  await js('dj.automix.setEnabled(false)');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
