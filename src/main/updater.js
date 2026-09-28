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

const REPO = 'basoxxx/Virtual-Dj-Ai';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

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
  if (platform === 'linux') return byPattern(/\.AppImage$/);
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
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Virtual-DJ-AI-Updater' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ha risposto ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = pickAsset(rel.assets || [], platform, arch);
  return {
    current: currentVersion,
    latest,
    available: Boolean(latest) && compareVersions(latest, currentVersion) > 0 && Boolean(asset),
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

/** Scarica l'installer mostrando l'avanzamento e ne verifica l'impronta. */
async function download(asset, { dir = path.join(os.tmpdir(), 'virtual-dj-ai-update'), onProgress = () => {}, fetchImpl = fetch } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  if (fs.existsSync(file) && asset.sha256 && (await sha256File(file)) === asset.sha256) {
    onProgress(asset.size, asset.size);
    return file;
  }
  const res = await fetchImpl(asset.url, { headers: { 'User-Agent': 'Virtual-DJ-AI-Updater' } });
  if (!res.ok || !res.body) throw new Error(`Download non riuscito (${res.status})`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let done = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      hash.update(value);
      done += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - lastReport > 150) {
        lastReport = Date.now();
        onProgress(done, total);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const digest = hash.digest('hex');
  if (asset.sha256 && digest !== asset.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('Il file scaricato non corrisponde all\'impronta pubblicata: aggiornamento annullato');
  }
  fs.renameSync(tmp, file);
  onProgress(done, total);
  return file;
}

/** Percorso del bundle .app in esecuzione (macOS). */
function macAppBundle(execPath) {
  return path.resolve(execPath, '..', '..', '..');
}

/** Script di installazione per piattaforma: aspetta la chiusura dell'app, installa e la riapre. */
function installScript(platform, { pid, installer, execPath, appImage }) {
  if (platform === 'darwin') {
    const app = macAppBundle(execPath);
    return {
      file: 'install-update.sh',
      content: `#!/bin/sh
PID=${pid}
DMG=${JSON.stringify(installer)}
APP=${JSON.stringify(app)}
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" || { open "$DMG"; exit 1; }
SRC=$(ls -d "$MNT"/*.app | head -n 1)
rm -rf "$APP.old"
if mv "$APP" "$APP.old" && ditto "$SRC" "$APP"; then
  rm -rf "$APP.old"
else
  rm -rf "$APP"; mv "$APP.old" "$APP"
fi
hdiutil detach "$MNT" -quiet
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
open "$APP"
`,
    };
  }
  if (platform === 'win32') {
    return {
      file: 'install-update.cmd',
      content: `@echo off\r
:wait\r
tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)\r
msiexec /i "${installer}" /passive /norestart\r
start "" "${execPath}"\r
`,
    };
  }
  if (platform === 'linux' && appImage) {
    return {
      file: 'install-update.sh',
      content: `#!/bin/sh
PID=${pid}
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
cp ${JSON.stringify(installer)} ${JSON.stringify(`${appImage}.new`)} && chmod 755 ${JSON.stringify(`${appImage}.new`)} && mv ${JSON.stringify(`${appImage}.new`)} ${JSON.stringify(appImage)}
${JSON.stringify(appImage)} >/dev/null 2>&1 &
`,
    };
  }
  return null;
}

/**
 * Avvia l'installazione. Restituisce 'restart' se l'app deve chiudersi per completarla,
 * 'manual' se si è aperto l'installer per un'installazione manuale.
 */
function install(installer, { platform = process.platform, execPath = process.execPath, pid = process.pid, appImage = process.env.APPIMAGE, shell = null } = {}) {
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
      if (shell) shell.openPath(installer);
      return 'manual';
    }
  }
  if (platform === 'linux' && !appImage) {
    if (shell) shell.showItemInFolder(installer);
    return 'manual';
  }
  const script = installScript(platform, { pid, installer, execPath, appImage });
  if (!script) return 'manual';
  const file = path.join(path.dirname(installer), script.file);
  fs.writeFileSync(file, script.content, { mode: 0o755 });
  const child = platform === 'win32'
    ? spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [file], { detached: true, stdio: 'ignore' });
  child.unref();
  return 'restart';
}

module.exports = { compareVersions, pickAsset, releaseSummary, checkForUpdates, download, install, installScript, sha256File, macAppBundle, API_LATEST };
