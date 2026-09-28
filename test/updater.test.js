import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const updater = require('../src/main/updater.js');

const ASSETS = [
  'Virtual-DJ-AI-1.5.3-win-x64.msi',
  'Virtual-DJ-AI-win-x64.msi',
  'Virtual-DJ-AI-mac-arm64.dmg',
  'Virtual-DJ-AI-1.5.3-mac-arm64.dmg',
  'Virtual-DJ-AI-1.5.3-mac-x64.dmg',
  'Virtual-DJ-AI-linux-x86_64.AppImage',
].map((name) => ({ name, browser_download_url: `https://example.test/${name}`, size: 10 }));

test('compareVersions', () => {
  assert.ok(updater.compareVersions('1.5.10', '1.5.9') > 0);
  assert.ok(updater.compareVersions('v1.4.5', '1.5.0') < 0);
  assert.equal(updater.compareVersions('1.5.0', 'v1.5.0'), 0);
  assert.ok(updater.compareVersions('2.0', '1.99.99') > 0);
});

test('pickAsset: installer giusto per sistema e architettura', () => {
  assert.equal(updater.pickAsset(ASSETS, 'win32', 'x64').name, 'Virtual-DJ-AI-1.5.3-win-x64.msi');
  assert.equal(updater.pickAsset(ASSETS, 'darwin', 'arm64').name, 'Virtual-DJ-AI-1.5.3-mac-arm64.dmg');
  assert.equal(updater.pickAsset(ASSETS, 'darwin', 'x64').name, 'Virtual-DJ-AI-1.5.3-mac-x64.dmg');
  assert.equal(updater.pickAsset(ASSETS, 'linux', 'x64').name, 'Virtual-DJ-AI-linux-x86_64.AppImage');
  assert.equal(updater.pickAsset(ASSETS, 'freebsd', 'x64'), null);
});

test('releaseSummary: solo le novità, senza istruzioni di installazione', () => {
  const body = '## Novità\n* **Aggiornamenti automatici** by @bot in https://github.com/x/pull/6\n- Layout adattivo\n- **macOS Intel**: `…-mac-x64.dmg`\n* Installazione: scarica il file\nTesto libero';
  assert.deepEqual(updater.releaseSummary(body), ['Aggiornamenti automatici', 'Layout adattivo']);
});

test('checkForUpdates: confronta con l\'ultima release e legge il digest', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v1.5.3', body: '* Novità', html_url: 'https://example.test/r', assets: ASSETS.map((a) => ({ ...a, digest: 'sha256:abc' })) }),
  });
  const newer = await updater.checkForUpdates('1.4.5', { platform: 'darwin', arch: 'x64', fetchImpl });
  assert.equal(newer.available, true);
  assert.equal(newer.latest, '1.5.3');
  assert.equal(newer.asset.name, 'Virtual-DJ-AI-1.5.3-mac-x64.dmg');
  assert.equal(newer.asset.sha256, 'abc');
  const same = await updater.checkForUpdates('1.5.3', { platform: 'darwin', arch: 'x64', fetchImpl });
  assert.equal(same.available, false);
  await assert.rejects(updater.checkForUpdates('1.0.0', { fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/);
});

function fakeFetch(data) {
  return async () => ({
    ok: true,
    headers: new Headers({ 'content-length': String(data.length) }),
    body: new Blob([data]).stream(),
  });
}

test('download: verifica SHA-256 e rifiuta file alterati', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdj-upd-'));
  const data = crypto.randomBytes(200000);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const asset = { name: 'pkg.dmg', url: 'https://example.test/pkg.dmg', size: data.length, sha256 };
  const seen = [];
  const file = await updater.download(asset, { dir, fetchImpl: fakeFetch(data), onProgress: (d, t) => seen.push([d, t]) });
  assert.deepEqual(fs.readFileSync(file), data);
  assert.deepEqual(seen.at(-1), [data.length, data.length]);
  // secondo download: riusa il file già verificato
  let fetched = false;
  await updater.download(asset, { dir, fetchImpl: async () => { fetched = true; throw new Error('no'); } });
  assert.equal(fetched, false);
  // impronta sbagliata: annullato e nessun file lasciato
  const bad = { ...asset, name: 'bad.dmg', sha256: '0'.repeat(64) };
  await assert.rejects(updater.download(bad, { dir, fetchImpl: fakeFetch(data) }), /impronta/);
  assert.equal(fs.existsSync(path.join(dir, 'bad.dmg')), false);
  assert.equal(fs.existsSync(path.join(dir, 'bad.dmg.part')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installScript: aspetta la chiusura, installa e riapre', () => {
  const mac = updater.installScript('darwin', { pid: 42, installer: '/tmp/u/a.dmg', execPath: '/Applications/Virtual DJ AI.app/Contents/MacOS/Virtual DJ AI' });
  assert.match(mac.content, /kill -0 "\$PID"/);
  assert.match(mac.content, /APP="\/Applications\/Virtual DJ AI\.app"/);
  assert.match(mac.content, /hdiutil attach/);
  assert.match(mac.content, /ditto/);
  assert.match(mac.content, /open "\$APP"/);
  const win = updater.installScript('win32', { pid: 7, installer: 'C:\\T\\a.msi', execPath: 'C:\\P\\Virtual DJ AI.exe' });
  assert.match(win.content, /msiexec \/i "C:\\T\\a\.msi" \/passive/);
  assert.match(win.content, /start "" "C:\\P\\Virtual DJ AI\.exe"/);
  const lin = updater.installScript('linux', { pid: 1, installer: '/tmp/a.AppImage', appImage: '/home/u/VDJ.AppImage' });
  assert.match(lin.content, /mv "\/home\/u\/VDJ\.AppImage\.new" "\/home\/u\/VDJ\.AppImage"/);
  assert.equal(updater.installScript('linux', { pid: 1, installer: '/tmp/a' }), null);
});

test('install: su Linux senza AppImage apre la cartella (manuale)', () => {
  let shown = null;
  const r = updater.install('/tmp/x.AppImage', { platform: 'linux', appImage: undefined, shell: { showItemInFolder: (f) => { shown = f; } } });
  assert.equal(r, 'manual');
  assert.equal(shown, '/tmp/x.AppImage');
});
