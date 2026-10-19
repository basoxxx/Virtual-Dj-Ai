// Aggiornamenti automatici da GitHub Releases, senza firma del codice:
// controlla l'ultima versione, scarica l'installer giusto per sistema e architettura,
// ne verifica l'impronta SHA-256 pubblicata da GitHub, lo installa e riavvia l'app.
//
// Perché non electron-updater: su macOS richiede un'app firmata da Apple e su Windows
// non supporta gli installer MSI che distribuiamo.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fsErrorText } = require('./errors');

const REPO = 'basoxxx/Virtual-Dj-Ai';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_DIR = path.join(os.tmpdir(), 'segueo-update');
// accanto all'installer: cosa si stava installando e l'esito scritto dallo script (letti al riavvio)
const PENDING_FILE = 'install-pending.json';
const RESULT_FILE = 'install-result.txt';
// senza dati per questo tempo la connessione è appesa: si interrompe invece di aspettare per sempre
const STALL_MS = 30000;

/** Confronta due versioni "1.4.10" e "v1.5.0": >0 se a è più recente di b. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Sceglie l'installer della release adatto a questo computer. */
function pickAsset(assets, platform, arch) {
  const versioned = (a) => /-\d+\.\d+\.\d+-/.test(a.name);
  const byPattern = (re) => assets.filter((a) => re.test(a.name)).sort((x, y) => Number(versioned(y)) - Number(versioned(x)))[0] || null;
  if (platform === 'win32') return byPattern(/-win-x64\.msi$/);
  if (platform === 'darwin') return byPattern(arch === 'arm64' ? /-mac-arm64\.dmg$/ : /-mac-x64\.dmg$/);
  if (platform === 'linux') {
    const names = { x64: 'x86_64|x64|amd64', arm64: 'arm64|aarch64' }[arch];
    return names ? byPattern(new RegExp(`-(${names})\\.AppImage$`)) : null;
  }
  return null;
}

/** Riassume le note di rilascio in poche righe leggibili. */
function releaseSummary(body = '') {
  return String(body)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('* ') || l.startsWith('- '))
    .filter((l) => !/Installazione|scarica|xattr|chmod|clic destro|\.dmg|\.msi|AppImage/i.test(l))
    .map((l) => l.replace(/^[*-]\s+/, '').replace(/\s+by @\S+ in https:\/\/\S+$/, '').replace(/\*\*|`/g, ''))
    .slice(0, 8);
}

async function checkForUpdates(currentVersion, { platform = process.platform, arch = process.arch, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API_LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Segueo-Updater' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ha risposto ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = pickAsset(rel.assets || [], platform, arch);
  const newer = Boolean(latest) && compareVersions(latest, currentVersion) > 0;
  return {
    current: currentVersion,
    latest,
    available: newer && Boolean(asset),
    // newer senza available: versione nuova ma senza installer per questo sistema o architettura
    newer,
    notes: releaseSummary(rel.body),
    page: rel.html_url,
    publishedAt: rel.published_at,
    asset: asset && {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      sha256: asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null,
    },
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Scarica l'installer (o un modello) mostrando l'avanzamento. Verifica il file scritto sul disco: dimensione e
 * impronta SHA-256. Ogni errore (rete, disco pieno, connessione appesa) rifiuta la promessa e non lascia file a metà.
 */
async function download(asset, { dir = UPDATE_DIR, onProgress = () => {}, fetchImpl = fetch, stallMs = STALL_MS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  if (fs.existsSync(file) && asset.sha256 && (await sha256File(file)) === asset.sha256) {
    onProgress(asset.size, asset.size);
    return file;
  }
  const tmp = `${file}.part`;
  const ctrl = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };
  try {
    arm();
    const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'Segueo-Updater' }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`Download non riuscito (${res.status})`);
    const length = Number(res.headers.get('content-length')) || 0;
    const total = length || asset.size || 0;
    let done = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        arm();
        done += chunk.length;
        if (Date.now() - lastReport > 150) {
          lastReport = Date.now();
          onProgress(done, total);
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp), { signal: ctrl.signal });
    clearTimeout(timer);
    const expected = asset.size || length;
    const written = fs.statSync(tmp).size;
    if (expected && written !== expected) throw new Error(`Download incompleto: ${mb(written)} di ${mb(expected)}. Riprova`);
    if (asset.sha256 && (await sha256File(tmp)) !== asset.sha256) {
      throw new Error('Il file scaricato non corrisponde all\'impronta pubblicata: aggiornamento annullato');
    }
    fs.renameSync(tmp, file);
    onProgress(written, written);
    return file;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // resta un .part: si riscrive al prossimo tentativo
    }
    if (stalled) throw new Error(`Download bloccato: nessun dato da ${Math.round(stallMs / 1000)} s. Controlla la connessione e riprova`);
    if (err.syscall) throw new Error(`Download non riuscito: ${fsErrorText(err)} (${dir})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Percorso del bundle .app in esecuzione (macOS). */
function macAppBundle(execPath) {
  return path.resolve(execPath, '..', '..', '..');
}

/**
 * Script di installazione per piattaforma: aspetta la chiusura dell'app, installa e la riapre. L'esito (0 = riuscito)
 * finisce in resultFile: al riavvio l'app lo legge e, se la versione non è cambiata, dice cosa è andato storto.
 */
function installScript(platform, { pid, installer, execPath, appImage, resultFile }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const result = resultFile || p.join(p.dirname(installer), RESULT_FILE);
  if (platform === 'darwin') {
    const app = macAppBundle(execPath);
    // codici: 10 DMG non montato, 11 nessuna app nel DMG, 12 copia non riuscita, 13 vecchia app non spostabile
    return {
      file: 'install-update.sh',
      content: `#!/bin/sh
PID=${pid}
DMG=${JSON.stringify(installer)}
APP=${JSON.stringify(app)}
RESULT=${JSON.stringify(result)}
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d)
if ! hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG"; then echo 10 > "$RESULT"; open "$DMG"; exit 1; fi
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -n 1)
STATUS=0
DEST="$APP"
if [ -z "$SRC" ]; then
  STATUS=11
else
  DEST="$(dirname "$APP")/$(basename "$SRC")"
  rm -rf "$APP.old"
  if mv "$APP" "$APP.old"; then
    if ditto "$SRC" "$DEST"; then
      rm -rf "$APP.old"
    else
      STATUS=12; rm -rf "$DEST"; mv "$APP.old" "$APP"; DEST="$APP"
    fi
  else
    STATUS=13; DEST="$APP"
  fi
fi
hdiutil detach "$MNT" -quiet
echo "$STATUS" > "$RESULT"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
open "$DEST"
`,
    };
  }
  if (platform === 'win32') {
    // l'esito di msiexec (0 riuscito, 3010 riuscito con riavvio, 1602 annullato, 1603 errore) si scrive prima di riaprire.
    // I percorsi arrivano come variabili d'ambiente: cmd.exe legge il file con la codepage OEM (850 in italiano) e un
    // nome utente con lettere accentate (C:\Users\Niccolò) scritto nel file diventerebbe un percorso che non esiste
    return {
      file: 'install-update.cmd',
      env: { SEGUEO_MSI: installer, SEGUEO_RESULT: result, SEGUEO_EXE: execPath },
      content: `@echo off\r
:wait\r
tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)\r
msiexec /i "%SEGUEO_MSI%" /passive /norestart\r
set CODE=%ERRORLEVEL%\r
> "%SEGUEO_RESULT%" echo %CODE%\r
start "" "%SEGUEO_EXE%"\r
`,
    };
  }
  if (platform === 'linux' && appImage) {
    const next = JSON.stringify(`${appImage}.new`);
    return {
      file: 'install-update.sh',
      content: `#!/bin/sh
PID=${pid}
RESULT=${JSON.stringify(result)}
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
if cp ${JSON.stringify(installer)} ${next} && chmod 755 ${next} && mv ${next} ${JSON.stringify(appImage)}; then
  echo 0 > "$RESULT"
else
  echo 1 > "$RESULT"; rm -f ${next}
fi
${JSON.stringify(appImage)} >/dev/null 2>&1 &
`,
    };
  }
  return null;
}

/** Apre l'installer con il programma di sistema; se non si apre lo si dice (con il percorso per farlo a mano). */
async function openInstaller(shell, installer) {
  if (!shell) return;
  const err = await shell.openPath(installer);
  if (err) throw new Error(`Non riesco ad aprire l'installer (${err}): aprilo a mano da ${installer}`);
}

/**
 * Avvia l'installazione. Restituisce 'restart' se l'app deve chiudersi per completarla (solo dopo che lo script è
 * partito davvero), 'manual' se si è aperto l'installer o la sua cartella per un'installazione manuale.
 * version e latest servono a capire al riavvio se l'aggiornamento è riuscito (checkInstallResult).
 */
async function install(installer, { platform = process.platform, execPath = process.execPath, pid = process.pid, appImage = process.env.APPIMAGE, shell = null, version = null, latest = null } = {}) {
  if (platform === 'darwin') {
    const app = macAppBundle(execPath);
    let writable = app.endsWith('.app');
    try {
      fs.accessSync(path.dirname(app), fs.constants.W_OK);
      fs.accessSync(app, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    if (!writable) {
      await openInstaller(shell, installer);
      return 'manual';
    }
  }
  if (platform === 'linux' && !appImage) {
    if (shell) shell.showItemInFolder(installer);
    return 'manual';
  }
  const dir = path.dirname(installer);
  const script = installScript(platform, { pid, installer, execPath, appImage, resultFile: path.join(dir, RESULT_FILE) });
  if (!script) {
    if (shell) shell.showItemInFolder(installer);
    return 'manual';
  }
  const file = path.join(dir, script.file);
  const pending = path.join(dir, PENDING_FILE);
  fs.writeFileSync(file, script.content, { mode: 0o755 });
  fs.rmSync(path.join(dir, RESULT_FILE), { force: true });
  fs.writeFileSync(pending, JSON.stringify({ from: version, to: latest, installer, at: Date.now() }));
  const child = platform === 'win32'
    ? spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...script.env } })
    : spawn('/bin/sh', [file], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => {
      fs.rmSync(pending, { force: true });
      reject(new Error(`Non riesco ad avviare l'installazione (${err.message}): installa a mano da ${installer}`));
    });
  });
  child.unref();
  return 'restart';
}

/**
 * All'avvio: c'era un'installazione in corso? ok = la versione è cambiata; code = esito scritto dallo script
 * (null se lo script non è arrivato in fondo). Si legge una volta sola.
 */
function checkInstallResult(dir, currentVersion) {
  const pendingFile = path.join(dir, PENDING_FILE);
  const resultFile = path.join(dir, RESULT_FILE);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return null; // nessuna installazione in corso
  }
  let code = null;
  try {
    code = fs.readFileSync(resultFile, 'utf8').trim() || null;
  } catch {
    // lo script non ha scritto l'esito
  }
  fs.rmSync(pendingFile, { force: true });
  fs.rmSync(resultFile, { force: true });
  return {
    ok: Boolean(pending.from) && compareVersions(currentVersion, pending.from) > 0,
    code,
    from: pending.from,
    to: pending.to,
    installer: pending.installer,
  };
}

module.exports = {
  compareVersions, pickAsset, releaseSummary, checkForUpdates, download, install, installScript, checkInstallResult, sha256File, macAppBundle,
  API_LATEST, UPDATE_DIR,
};
