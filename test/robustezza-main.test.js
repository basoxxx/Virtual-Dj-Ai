// Robustezza del processo principale: nessun errore deve passare in silenzio o distruggere i dati dell'utente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JsonStore } = require('../src/main/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir(prefix = 'segueo-rob-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- A1: libreria e impostazioni ---------------------------------------------------

test('store: un file danneggiato si copia da parte prima di tutto e non si sovrascrive in silenzio', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'library.json');
    fs.writeFileSync(file, '{"tracks":{"a":{"hotcues":[1,2'); // scritto a metà (blackout)
    const store = new JsonStore(file, { tracks: {} }, { label: 'Libreria' });
    assert.deepEqual(store.data, { tracks: {} });
    assert.ok(store.loadError, 'l\'errore deve arrivare all\'utente');
    const copies = fs.readdirSync(dir).filter((f) => f.startsWith('library.json.corrotto-'));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{"tracks":{"a":{"hotcues":[1,2');
    assert.match(store.loadError, /Libreria/);
    assert.ok(store.loadError.includes(path.join(dir, copies[0])), 'il messaggio dice dove sta la copia');
    store.data.tracks.b = { id: 'b' };
    store.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tracks: { b: { id: 'b' } } });
    assert.ok(fs.existsSync(path.join(dir, copies[0])), 'la copia del file danneggiato resta');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: con il file danneggiato si recupera l\'ultima copia buona (.bak), che il primo salvataggio non tocca', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'settings.json');
    const first = new JsonStore(file, {});
    first.data.midi = { mapping: { play: 'note:0:1' } };
    first.flush();
    first.data.volume = 0.5;
    first.flush(); // ora .bak = versione con la sola mappatura
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { midi: { mapping: { play: 'note:0:1' } } });
    fs.writeFileSync(file, '\0\0\0\0'); // danneggiato
    const store = new JsonStore(file, {}, { label: 'Impostazioni' });
    assert.deepEqual(store.data, { midi: { mapping: { play: 'note:0:1' } } });
    assert.match(store.loadError, /copia buona/);
    store.data.volume = 0.7;
    store.flush();
    // il file danneggiato non diventa la copia di riserva
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { midi: { mapping: { play: 'note:0:1' } } });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).volume, 0.7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: file assente = valori predefiniti, senza errori', () => {
  const dir = tmpDir();
  try {
    const store = new JsonStore(path.join(dir, 'nuovo.json'), { a: 1 });
    assert.deepEqual(store.data, { a: 1 });
    assert.equal(store.loadError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: un file che c\'è ma non si legge (permessi, disco) non viene mai sovrascritto', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'library.json');
    fs.mkdirSync(file); // EISDIR: come un EACCES/EIO, il file c'è ma non si legge
    const store = new JsonStore(file, { tracks: {} }, { label: 'Libreria' });
    assert.deepEqual(store.data, { tracks: {} });
    assert.match(store.loadError, /Libreria/);
    assert.match(store.loadError, /non verranno salvate/);
    store.data.tracks.x = {};
    store.flush();
    assert.ok(fs.statSync(file).isDirectory(), 'niente scritture sopra il file illeggibile');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: un salvataggio che fallisce si segnala una volta sola, poi di nuovo solo dopo un salvataggio riuscito', async () => {
  const dir = tmpDir();
  try {
    const errors = [];
    const store = new JsonStore(path.join(dir, 'x.json'), { n: 0 }, { delay: 5, onError: (err) => errors.push(err) });
    const flush = store.flush.bind(store);
    let fail = true;
    store.flush = () => {
      if (fail) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      flush();
    };
    store.save();
    await sleep(30);
    store.save();
    await sleep(30);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'ENOSPC');
    fail = false;
    store.save();
    await sleep(30);
    fail = true;
    store.save();
    await sleep(30);
    assert.equal(errors.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: la rinomina bloccata per un attimo (antivirus su Windows, EPERM) si riprova', () => {
  const dir = tmpDir();
  const rename = fs.renameSync;
  try {
    const file = path.join(dir, 'x.json');
    const store = new JsonStore(file, { n: 0 });
    store.data.n = 3;
    let fails = 2;
    fs.renameSync = (...args) => {
      if (fails-- > 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return rename(...args);
    };
    store.flush();
    fs.renameSync = rename;
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A2, A3, A17: libreria ------------------------------------------------------------

const { Library, readMetadata, trackId } = require('../src/main/library.js');
const canChmod = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);

function wavBytes(samples = 2000) {
  const b = Buffer.alloc(44 + samples * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 4, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(44100 * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 4, 40);
  return b;
}

function libraryIn(dir) {
  const lib = new Library(path.join(dir, 'userData'));
  return { lib, done: () => clearTimeout(lib.store.timer) };
}

test('rescan: un disco scollegato non cancella cue, griglie e analisi dei suoi brani', async () => {
  const dir = tmpDir();
  const { lib, done } = libraryIn(dir);
  try {
    const music = path.join(dir, 'Musica');
    const usb = path.join(dir, 'USB'); // cartella della libreria su un disco ora scollegato
    const loose = path.join(dir, 'Sciolti');
    fs.mkdirSync(music);
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(music, 'c\'è.wav'), wavBytes());
    const track = (file, extra = {}) => ({ id: trackId(file), path: file, title: path.basename(file), hotcues: [{ time: 12 }], ...extra });
    lib.data.folders.push(music, usb);
    for (const t of [
      track(path.join(music, 'c\'è.wav')),
      track(path.join(music, 'cancellato.wav')),
      track(path.join(usb, 'set', 'brano.wav'), { bpmEngine: 'manual' }),
      track(path.join(dir, 'Altro disco', 'singolo.wav')), // fuori dalle cartelle, cartella sparita: disco scollegato
      track(path.join(loose, 'tolto.wav')), // fuori dalle cartelle, cartella presente: file cancellato davvero
    ]) lib.data.tracks[t.id] = t;
    const res = await lib.rescan();
    assert.deepEqual(res.offline, [usb]);
    assert.equal(res.removed, 2);
    const left = Object.values(lib.data.tracks).map((t) => path.relative(dir, t.path)).sort();
    assert.deepEqual(left, [path.join('Altro disco', 'singolo.wav'), path.join('Musica', 'c\'è.wav'), path.join('USB', 'set', 'brano.wav')].sort());
    assert.equal(lib.data.tracks[trackId(path.join(usb, 'set', 'brano.wav'))].bpmEngine, 'manual');
  } finally {
    done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rescan: una cartella della libreria vuota ma con brani registrati (punto di mount senza disco) è scollegata', async () => {
  const dir = tmpDir();
  const { lib, done } = libraryIn(dir);
  try {
    const nas = path.join(dir, 'NAS');
    fs.mkdirSync(nas);
    lib.data.folders.push(nas);
    const file = path.join(nas, 'brano.wav');
    lib.data.tracks.x = { id: 'x', path: file, hotcues: [] };
    const res = await lib.rescan();
    assert.deepEqual(res.offline, [nas]);
    assert.equal(res.removed, 0);
    assert.ok(lib.data.tracks.x);
  } finally {
    done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addFolder: cartella inesistente o non leggibile = errore chiaro, e non entra in libreria', async () => {
  const dir = tmpDir();
  const { lib, done } = libraryIn(dir);
  try {
    await assert.rejects(lib.addFolder(path.join(dir, 'non-esiste')), /non trovata/);
    assert.deepEqual(lib.data.folders, []);
    if (canChmod) {
      const locked = path.join(dir, 'Bloccata');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      try {
        await assert.rejects(lib.addFolder(locked), (err) => /permesso/.test(err.message) && (process.platform !== 'darwin' || /Privacy e sicurezza/.test(err.message)));
        assert.deepEqual(lib.data.folders, []);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  } finally {
    done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addFolder: conta i brani aggiunti e le sottocartelle che non si leggono', async () => {
  const dir = tmpDir();
  const { lib, done } = libraryIn(dir);
  try {
    const music = path.join(dir, 'Musica');
    fs.mkdirSync(path.join(music, 'Album'), { recursive: true });
    fs.writeFileSync(path.join(music, 'uno.wav'), wavBytes());
    fs.writeFileSync(path.join(music, 'Album', 'due.wav'), wavBytes());
    fs.writeFileSync(path.join(music, 'note.txt'), 'x');
    const locked = path.join(music, 'Privata');
    fs.mkdirSync(locked);
    if (canChmod) fs.chmodSync(locked, 0o000);
    try {
      const res = await lib.addFolder(music);
      assert.equal(res.added.length, 2);
      assert.equal(res.found, 2);
      assert.deepEqual(res.skipped, canChmod ? [locked] : []);
      assert.deepEqual(lib.data.folders, [music]);
      const again = await lib.addFolder(music);
      assert.equal(again.added.length, 0);
      assert.equal(again.found, 2);
      assert.deepEqual(lib.data.folders, [music]);
    } finally {
      if (canChmod) fs.chmodSync(locked, 0o755);
    }
  } finally {
    done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readMetadata: file non audio con estensione audio o non leggibile = metadataError (non più nascosto)', async () => {
  const dir = tmpDir();
  try {
    const html = path.join(dir, 'Artista - Brano.mp3');
    fs.writeFileSync(html, '<!doctype html><html><body>Accesso negato</body></html>');
    const fake = await readMetadata(html);
    assert.ok(fake.metadataError);
    assert.equal(fake.duration, 0);
    assert.equal(fake.title, 'Brano');
    const ok = path.join(dir, 'vero.wav');
    fs.writeFileSync(ok, wavBytes());
    const real = await readMetadata(ok);
    assert.equal(real.metadataError, undefined);
    assert.ok(real.duration > 0);
    if (canChmod) {
      const locked = path.join(dir, 'bloccato.mp3');
      fs.writeFileSync(locked, 'x');
      fs.chmodSync(locked, 0o000);
      assert.match((await readMetadata(locked)).metadataError, /permesso/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A4-A7: registrazione del mix ------------------------------------------------------

const recorder = require('../src/main/recorder.js');

test('wavHeader: WAV normale con spazio riservato (JUNK) per l\'intestazione RF64', () => {
  const h = recorder.wavHeader(1000, 48000, 2);
  assert.equal(h.length, recorder.HEADER_BYTES);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), recorder.HEADER_BYTES - 8 + 1000);
  assert.equal(h.toString('ascii', 8, 12), 'WAVE');
  assert.equal(h.toString('ascii', 12, 16), 'JUNK');
  assert.equal(h.readUInt32LE(16), 28);
  assert.ok(h.subarray(20, 48).every((b) => b === 0));
  assert.equal(h.toString('ascii', 48, 52), 'fmt ');
  assert.equal(h.readUInt32LE(52), 16);
  assert.equal(h.readUInt16LE(56), 1);
  assert.equal(h.readUInt16LE(58), 2);
  assert.equal(h.readUInt32LE(60), 48000);
  assert.equal(h.readUInt32LE(64), 48000 * 4);
  assert.equal(h.readUInt16LE(68), 4);
  assert.equal(h.readUInt16LE(70), 16);
  assert.equal(h.toString('ascii', 72, 76), 'data');
  assert.equal(h.readUInt32LE(76), 1000);
});

test('wavHeader: oltre 4 GiB (set di più di 6 ore) diventa RF64 con ds64, senza troncare', () => {
  const data = 5 * 2 ** 30;
  const h = recorder.wavHeader(data, 48000, 2);
  assert.equal(h.length, recorder.HEADER_BYTES);
  assert.equal(h.toString('ascii', 0, 4), 'RF64');
  assert.equal(h.readUInt32LE(4), 0xffffffff);
  assert.equal(h.toString('ascii', 8, 12), 'WAVE');
  assert.equal(h.toString('ascii', 12, 16), 'ds64');
  assert.equal(h.readUInt32LE(16), 28);
  assert.equal(h.readBigUInt64LE(20), BigInt(recorder.HEADER_BYTES - 8 + data));
  assert.equal(h.readBigUInt64LE(28), BigInt(data));
  assert.equal(h.readBigUInt64LE(36), BigInt(data / 4));
  assert.equal(h.readUInt32LE(44), 0);
  assert.equal(h.toString('ascii', 48, 52), 'fmt ');
  assert.equal(h.toString('ascii', 72, 76), 'data');
  assert.equal(h.readUInt32LE(76), 0xffffffff);
  // al limite esatto resta un WAV normale
  const max = 0xffffffff - (recorder.HEADER_BYTES - 8);
  assert.equal(recorder.wavHeader(max, 48000, 2).toString('ascii', 0, 4), 'RIFF');
  assert.equal(recorder.wavHeader(max + 4, 48000, 2).toString('ascii', 0, 4), 'RF64');
});

test('registrazione: il file finale è un WAV che i lettori aprono (con JUNK) e la durata è giusta', async () => {
  const dir = tmpDir();
  try {
    const rec = recorder.startRecording(dir, { sampleRate: 48000, channels: 2 });
    assert.equal(path.dirname(rec.file), dir);
    for (let i = 0; i < 10; i++) assert.equal(recorder.writeChunk(rec, Buffer.alloc(4800 * 4, i)), null);
    recorder.finalizeRecording(rec);
    recorder.finalizeRecording(rec); // due volte (stop + uscita) non fa danni
    assert.equal(fs.statSync(rec.file).size, recorder.HEADER_BYTES + 48000 * 4);
    const mm = require('music-metadata');
    const meta = await mm.parseFile(rec.file);
    assert.equal(meta.format.container, 'WAVE');
    assert.equal(meta.format.sampleRate, 48000);
    assert.ok(Math.abs(meta.format.duration - 1) < 1e-6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registrazione: un errore di scrittura (disco pieno) si segnala una volta e non lancia eccezioni a ogni blocco', () => {
  const dir = tmpDir();
  try {
    const rec = recorder.startRecording(dir, { sampleRate: 44100, channels: 2 });
    recorder.writeChunk(rec, Buffer.alloc(400));
    const write = fs.writeSync;
    fs.writeSync = () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    let first;
    let second;
    try {
      first = recorder.writeChunk(rec, Buffer.alloc(400));
      second = recorder.writeChunk(rec, Buffer.alloc(400));
    } finally {
      fs.writeSync = write;
    }
    assert.match(first, /[Dd]isco pieno/);
    assert.equal(second, null);
    assert.equal(rec.error.code, 'ENOSPC');
    recorder.finalizeRecording(rec);
    // l'intestazione dice quanto è stato scritto davvero
    const h = fs.readFileSync(rec.file).subarray(0, recorder.HEADER_BYTES);
    assert.equal(h.readUInt32LE(76), 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registrazione: dopo un\'uscita o un crash si sistema l\'intestazione e si avvisa una volta sola', () => {
  const dir = tmpDir();
  try {
    const rec = recorder.startRecording(dir, { sampleRate: 44100, channels: 2 });
    recorder.writeChunk(rec, Buffer.alloc(4410 * 4, 1));
    recorder.writeChunk(rec, Buffer.alloc(3)); // blocco a metà (crash durante la scrittura)
    fs.closeSync(rec.fd); // crash: niente intestazione finale
    const saved = recorder.startRecording(dir, { sampleRate: 44100, channels: 2 });
    recorder.finalizeRecording(saved);
    recorder.clearMarker(saved); // fermata e passata all'utente: non è da recuperare
    const found = recorder.recoverInterrupted(dir);
    assert.deepEqual(found, [rec.file]);
    const buf = fs.readFileSync(rec.file);
    assert.equal(buf.length, recorder.HEADER_BYTES + 4410 * 4);
    assert.equal(buf.readUInt32LE(76), 4410 * 4);
    assert.equal(buf.readUInt32LE(4), buf.length - 8);
    assert.deepEqual(recorder.recoverInterrupted(dir), []);
    assert.deepEqual(recorder.recoverInterrupted(path.join(dir, 'non-esiste')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registrazione: se il salvataggio non riesce il file resta dov\'è e l\'errore dice dove', () => {
  const dir = tmpDir();
  try {
    const rec = recorder.startRecording(dir, { sampleRate: 44100, channels: 2 });
    recorder.writeChunk(rec, Buffer.alloc(40));
    recorder.finalizeRecording(rec);
    const bad = path.join(dir, 'cartella-che-non-esiste', 'Mix.wav');
    assert.throws(() => recorder.saveRecording(rec.file, bad), (err) => err.message.includes(rec.file));
    assert.ok(fs.existsSync(rec.file));
    const good = path.join(dir, 'Salvato.wav');
    assert.equal(recorder.saveRecording(rec.file, good), good);
    assert.ok(fs.existsSync(good));
    assert.equal(fs.existsSync(rec.file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A8-A10: aggiornamenti -----------------------------------------------------------

const updater = require('../src/main/updater.js');
const cryptoNode = require('node:crypto');

function bodyFetch(body, headers = {}) {
  return async () => ({ ok: true, status: 200, headers: new Headers(headers), body });
}

test('download: connessione appesa = errore chiaro dopo il tempo di attesa, niente file a metà', async () => {
  const dir = tmpDir();
  try {
    // un primo blocco, poi più niente: senza controllo si aspetterebbe per sempre
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1000)); } });
    const asset = { name: 'appeso.dmg', url: 'https://example.test/x', size: 5000, sha256: null };
    const t0 = Date.now();
    await assert.rejects(updater.download(asset, { dir, fetchImpl: bodyFetch(body), stallMs: 150 }), /bloccato.*connessione/);
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download: file più corto del previsto = errore, niente file a metà', async () => {
  const dir = tmpDir();
  try {
    const data = cryptoNode.randomBytes(1000);
    const asset = { name: 'corto.onnx', url: 'https://example.test/x', size: 4000, sha256: null };
    await assert.rejects(updater.download(asset, { dir, fetchImpl: bodyFetch(new Blob([data]).stream()) }), /incompleto/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download: un errore di scrittura su disco diventa un errore della promessa (non un\'eccezione non gestita)', { skip: !canChmod }, async () => {
  const dir = tmpDir();
  try {
    fs.chmodSync(dir, 0o555);
    const data = cryptoNode.randomBytes(1000);
    const asset = { name: 'x.dmg', url: 'https://example.test/x', size: 1000, sha256: null };
    await assert.rejects(updater.download(asset, { dir, fetchImpl: bodyFetch(new Blob([data]).stream()) }), /permesso/);
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkForUpdates: versione nuova senza installer per questo computer = lo si dice (non "hai l\'ultima")', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v9.0.0', html_url: 'https://example.test/r', assets: [{ name: 'Segueo-9.0.0-win-x64.msi', browser_download_url: 'x', size: 1 }] }),
  });
  const info = await updater.checkForUpdates('1.6.0', { platform: 'darwin', arch: 'arm64', fetchImpl });
  assert.equal(info.available, false);
  assert.equal(info.newer, true);
  assert.equal(info.page, 'https://example.test/r');
  const same = await updater.checkForUpdates('9.0.0', { platform: 'win32', arch: 'x64', fetchImpl });
  assert.equal(same.newer, false);
});

test('pickAsset: su Linux conta anche l\'architettura', () => {
  const assets = ['Segueo-2.0.0-linux-x86_64.AppImage', 'Segueo-2.0.0-linux-arm64.AppImage'].map((name) => ({ name }));
  assert.equal(updater.pickAsset(assets, 'linux', 'x64').name, 'Segueo-2.0.0-linux-x86_64.AppImage');
  assert.equal(updater.pickAsset(assets, 'linux', 'arm64').name, 'Segueo-2.0.0-linux-arm64.AppImage');
  assert.equal(updater.pickAsset([assets[0]], 'linux', 'arm64'), null);
  assert.equal(updater.pickAsset(assets, 'linux', 'ia32'), null);
});

test('installScript: ogni script scrive l\'esito accanto all\'installer', () => {
  const mac = updater.installScript('darwin', { pid: 42, installer: '/tmp/u/a.dmg', execPath: '/Applications/Segueo.app/Contents/MacOS/Segueo' });
  assert.match(mac.content, /RESULT="\/tmp\/u\/install-result\.txt"/);
  assert.match(mac.content, /echo "\$STATUS" > "\$RESULT"/);
  assert.match(mac.content, /STATUS=11/); // nessuna app nel DMG
  // se non si riesce a spostare la vecchia app non si cancella niente
  assert.doesNotMatch(mac.content, /if mv "\$APP" "\$APP\.old" && ditto/);
  const win = updater.installScript('win32', { pid: 7, installer: 'C:\\T\\a.msi', execPath: 'C:\\P\\Segueo.exe' });
  assert.match(win.content, /set CODE=%ERRORLEVEL%/);
  assert.match(win.content, /> "%SEGUEO_RESULT%" echo %CODE%/);
  assert.equal(win.env.SEGUEO_RESULT, 'C:\\T\\install-result.txt');
  const lin = updater.installScript('linux', { pid: 1, installer: '/tmp/a.AppImage', appImage: '/home/u/VDJ.AppImage' });
  assert.match(lin.content, /echo 1 > "\$RESULT"/);
});

test('install: l\'esito dell\'installazione si legge al riavvio (aggiornamento fallito = avviso con il percorso)', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir();
  try {
    const installer = path.join(dir, 'nuova.AppImage');
    const appImage = path.join(dir, 'Segueo.AppImage');
    fs.writeFileSync(installer, '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(appImage, '#!/bin/sh\nexit 0\n');
    const r = await updater.install(installer, { platform: 'linux', appImage, pid: 999999, version: '1.6.0', latest: '1.7.0' });
    assert.equal(r, 'restart');
    const result = path.join(dir, 'install-result.txt');
    for (let i = 0; i < 50 && !fs.existsSync(result); i++) await sleep(100);
    assert.equal(fs.readFileSync(result, 'utf8').trim(), '0');
    assert.equal(fs.readFileSync(appImage, 'utf8'), '#!/bin/sh\nexit 0\n');
    // riavvio con la versione nuova: tutto a posto
    assert.deepEqual(updater.checkInstallResult(dir, '1.7.0'), { ok: true, code: '0', from: '1.6.0', to: '1.7.0', installer });
    assert.equal(updater.checkInstallResult(dir, '1.7.0'), null); // si dice una volta sola
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInstallResult: versione rimasta la stessa = aggiornamento non riuscito, con il codice', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'install-pending.json'), JSON.stringify({ from: '1.6.0', to: '1.7.0', installer: 'C:\\T\\a.msi' }));
    fs.writeFileSync(path.join(dir, 'install-result.txt'), '1603\r\n');
    assert.deepEqual(updater.checkInstallResult(dir, '1.6.0'), { ok: false, code: '1603', from: '1.6.0', to: '1.7.0', installer: 'C:\\T\\a.msi' });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(updater.checkInstallResult(path.join(dir, 'non-esiste'), '1.6.0'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install: se l\'installer non si apre lo si dice (non "si è aperto l\'installer")', async () => {
  const shell = { openPath: async () => 'Nessuna applicazione associata' };
  await assert.rejects(updater.install('/tmp/x.dmg', { platform: 'darwin', execPath: '/tmp/non-app/Segueo', shell }), /installer.*\/tmp\/x\.dmg/);
});

// --- A11: migrazione dal vecchio nome --------------------------------------------------

const migrate = require('../src/main/migrate.js');

test('migrateUserData: una copia interrotta non sembra finita, si riprova e i dati nati nel frattempo restano da parte', { skip: !canChmod }, () => {
  const root = tmpDir();
  const oldDir = path.join(root, migrate.LEGACY_NAME);
  const newDir = path.join(root, 'Segueo');
  const locked = path.join(oldDir, 'Preferences');
  try {
    fs.mkdirSync(path.join(oldDir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"midi":{"mapping":{"play":"note:0:1"}}}');
    fs.writeFileSync(path.join(oldDir, 'library.json'), '{"tracks":{}}');
    fs.writeFileSync(path.join(oldDir, 'Local Storage', 'leveldb', '000003.log'), 'vecchio');
    fs.writeFileSync(locked, '{}');
    fs.chmodSync(locked, 0o000); // EACCES a metà copia
    assert.throws(() => migrate.migrateUserData(oldDir, newDir));
    assert.equal(fs.existsSync(path.join(newDir, 'settings.json')), false, 'niente mezza migrazione che blocca i tentativi successivi');
    assert.equal(fs.existsSync(path.join(newDir, 'library.json')), false);
    assert.equal(fs.existsSync(`${newDir}.migrazione`), false);
    // la sessione dopo l'errore scrive le sue impostazioni e il suo localStorage
    fs.writeFileSync(path.join(newDir, 'settings.json'), '{"maximized":true}');
    fs.mkdirSync(path.join(newDir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'Local Storage', 'leveldb', '000009.log'), 'nuovo');
    fs.chmodSync(locked, 0o644);
    const res = migrate.migrateUserData(oldDir, newDir);
    assert.ok(res && res.aside, 'dove sono i dati della sessione messi da parte');
    assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"midi":{"mapping":{"play":"note:0:1"}}}');
    assert.ok(fs.existsSync(path.join(newDir, 'Preferences')));
    // il localStorage non si mescola (file di due database diversi lo rovinerebbero): si prende quello vecchio intero
    assert.deepEqual(fs.readdirSync(path.join(newDir, 'Local Storage', 'leveldb')), ['000003.log']);
    assert.ok(path.basename(res.aside).startsWith('Segueo.prima-della-migrazione-'));
    assert.equal(fs.readFileSync(path.join(res.aside, 'settings.json'), 'utf8'), '{"maximized":true}');
    assert.equal(migrate.migrateUserData(oldDir, newDir), false); // fatta: non si ripete
  } finally {
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- A12: modelli su richiesta -----------------------------------------------------------

const aiAssets = require('../src/main/ai-assets.js');

test('downloadModel: un modello incompleto è un errore esplicito (non un "fatto" silenzioso)', async () => {
  const root = tmpDir();
  try {
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), body: new Blob([Buffer.alloc(1000)]).stream() });
    await assert.rejects(aiAssets.downloadModel(root, 'segueo-separazione-voce-v2.onnx', { fetchImpl }), /incompleto/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'models')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- A13-A15: richieste dal pubblico ---------------------------------------------------

const { DownloadWatcher, searchUrl } = require('../src/main/downloads.js');
const { isAudioFile } = require('../src/main/library.js');

test('richieste: quando smette da sola di guardare i download dice perché', async () => {
  const dir = tmpDir();
  try {
    const stops = [];
    const w = new DownloadWatcher({ accept: isAudioFile, onFile: () => {}, timeoutMs: 60, onStop: (info) => stops.push(info) });
    w.start(dir);
    await sleep(150);
    assert.equal(w.active, false);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].reason, 'timeout');
    assert.match(stops[0].message, /Cerca online/);
    w.start(dir);
    w.watcher.emit('error', Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    assert.equal(w.active, false);
    assert.equal(stops[1].reason, 'error');
    assert.match(stops[1].message, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    w.start(dir);
    w.stop(false); // fermata dall'utente: niente avviso
    assert.equal(stops.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('richieste: un file completo che non è audio (es. .zip da Bandcamp) si segnala invece di sparire', async () => {
  const dir = tmpDir();
  try {
    const ignored = [];
    const got = [];
    const w = new DownloadWatcher({ accept: isAudioFile, onFile: (f) => got.push(f), onIgnored: (f) => ignored.push(path.basename(f)), settleMs: 60 });
    w.start(dir);
    fs.writeFileSync(path.join(dir, 'Album.zip.crdownload'), 'in corso');
    fs.writeFileSync(path.join(dir, 'Album.zip'), 'PK');
    for (let i = 0; i < 30 && !ignored.length; i++) await sleep(50);
    w.stop(false);
    assert.deepEqual(ignored, ['Album.zip']);
    assert.deepEqual(got, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('richieste: sito personalizzato vuoto o senza {q} = errore chiaro (niente Google al suo posto)', () => {
  assert.throws(() => searchUrl('', 'despacito'), /Impostazioni/);
  assert.throws(() => searchUrl('https://pool.example/search', 'despacito'), /\{q\}/);
  assert.throws(() => searchUrl('https://', 'x'), /non valido/);
  assert.equal(searchUrl('https://pool.example/search?term={q}', 'a b'), 'https://pool.example/search?term=a%20b');
});

// --- A20: pacchetto senza AI ----------------------------------------------------------------

const { distProblems } = require('../scripts/check-dist.js');

test('check-dist: niente installer senza modelli inclusi, con modelli incompleti o senza onnxruntime-web', () => {
  const root = tmpDir();
  try {
    const put = (rel, data) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), data);
    };
    put('src/main/models.json', JSON.stringify({ models: [
      { file: 'a.onnx', bundle: true, bytes: 4 },
      { file: 'b.onnx', bundle: true, bytes: 4 },
      { file: 'grande.onnx', bundle: false, bytes: 999 },
    ] }));
    put('electron-builder.yml', 'files:\n  - src/renderer/models/a.onnx\n');
    put('src/renderer/models/a.onnx', 'abc');
    const problems = distProblems(root);
    assert.equal(problems.length, 5);
    assert.match(problems.join('\n'), /a\.onnx è incompleto/);
    assert.match(problems.join('\n'), /manca il modello src\/renderer\/models\/b\.onnx/);
    assert.match(problems.join('\n'), /b\.onnx.*electron-builder\.yml/);
    assert.match(problems.join('\n'), /ort-wasm-simd-threaded\.wasm/);
    put('src/renderer/models/a.onnx', 'abcd');
    put('src/renderer/models/b.onnx', 'abcd');
    put('electron-builder.yml', 'files:\n  - src/renderer/models/a.onnx\n  - src/renderer/models/b.onnx\n');
    put('src/renderer/vendor/onnxruntime-web/ort.wasm.bundle.min.mjs', 'x');
    put('src/renderer/vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm', 'x');
    assert.deepEqual(distProblems(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check-dist: il repository ha in electron-builder.yml tutti i modelli con "bundle": true', () => {
  const builder = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  const manifest = require('../src/main/models.json');
  for (const m of manifest.models.filter((x) => x.bundle)) assert.ok(builder.includes(`src/renderer/models/${m.file}`), m.file);
  assert.match(builder, /beforePack: scripts\/check-dist\.js/);
});

test('richieste: un solo controllo dell\'indirizzo, nel processo principale, chiesto anche dalle impostazioni', () => {
  const { searchTemplateProblem } = require('../src/main/downloads.js');
  assert.match(searchTemplateProblem(''), /indirizzo/);
  assert.match(searchTemplateProblem('pool.example/search?q={q}'), /https/);
  assert.match(searchTemplateProblem('https://pool.example/search'), /\{q\}/);
  assert.equal(searchTemplateProblem('https://pool.example/search?q={q}'), null);
  // la pagina Richieste lo chiede via IPC: niente seconda copia nel renderer
  const preload = fs.readFileSync(new URL('../src/main/preload.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  assert.match(preload, /checkSearchSite: invoke\('requests:checkSite'\)/);
  assert.match(main, /ipcMain\.handle\('requests:checkSite', \(_e, template\) => searchTemplateProblem\(template\)\)/);
  const renderer = fs.readFileSync(new URL('../src/renderer/js/ui/requests-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /searchSiteProblem/);
});

// --- A4 (interfaccia): fermare la registrazione -------------------------------------------

test('stopRecording: un errore di record:stop arriva a chi chiama; senza risposta dal worklet si chiude dopo 3 s', async () => {
  const { AudioEngine } = await import('../src/renderer/js/audio/engine.js');
  const fake = (recordStop) => Object.assign(Object.create(AudioEngine.prototype), {
    recording: true,
    recApi: { recordStop },
    recorder: { port: { postMessage: () => {} } },
    dispatchEvent: () => true,
  });
  // il worklet risponde: l'errore del salvataggio non resta appeso
  const a = fake(async () => {
    throw new Error('disco pieno');
  });
  const p = a.stopRecording();
  assert.equal(a.stopRecording(), p, 'due richieste di stop = la stessa');
  a.onRecorderMessage({ type: 'stopped' });
  await assert.rejects(p, /disco pieno/);
  assert.equal(a.recording, false);
  // il worklet non risponde (contesto audio sospeso): si chiude il file lo stesso
  let closed = false;
  const b = fake(async () => {
    closed = true;
    return { file: '/m/Mix.wav' };
  });
  const t0 = Date.now();
  assert.deepEqual(await b.stopRecording(), { file: '/m/Mix.wav' });
  assert.ok(closed);
  assert.ok(Date.now() - t0 >= 2900);
});

// --- revisione: migrazione, avvisi, registrazione, metadati ------------------------------------

test('migrateUserData: se la sostituzione si interrompe i dati della sessione tornano al loro posto e non si cancellano mai', () => {
  const root = tmpDir();
  const oldDir = path.join(root, migrate.LEGACY_NAME);
  const newDir = path.join(root, 'Segueo');
  const rename = fs.renameSync;
  try {
    fs.mkdirSync(oldDir);
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'library.json'), '{"vecchia":true}');
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"vecchie":true}');
    // tentativo precedente non riuscito, poi la sessione ha scritto i suoi dati
    fs.writeFileSync(path.join(newDir, 'migrazione-da-virtual-dj-ai.json'), '{"ok":false}');
    fs.writeFileSync(path.join(newDir, 'library.json'), '{"sessione":1}');
    fs.writeFileSync(path.join(newDir, 'settings.json'), '{"sessione":2}');
    // Windows: la libreria nuova non entra (file bloccato da antivirus) neanche riprovando
    const blocked = path.join(newDir, 'library.json');
    let tries = 0;
    fs.renameSync = (from, to) => {
      if (to === blocked && from.includes('.migrazione')) {
        tries++;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return rename(from, to);
    };
    assert.throws(() => migrate.migrateUserData(oldDir, newDir), /not permitted/);
    fs.renameSync = rename;
    assert.ok(tries > 1, 'la rinomina bloccata si riprova');
    assert.equal(fs.readFileSync(blocked, 'utf8'), '{"sessione":1}', 'la libreria della sessione è tornata al suo posto');
    assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"sessione":2}');
    const firstAside = fs.readdirSync(root).filter((n) => n.startsWith('Segueo.prima-della-migrazione-'));
    // nuovo tentativo: riesce, con una cartella da parte nuova (quella di prima non si tocca)
    const res = migrate.migrateUserData(oldDir, newDir);
    assert.equal(fs.readFileSync(blocked, 'utf8'), '{"vecchia":true}');
    assert.equal(fs.readFileSync(path.join(res.aside, 'library.json'), 'utf8'), '{"sessione":1}');
    assert.equal(fs.readFileSync(path.join(res.aside, 'settings.json'), 'utf8'), '{"sessione":2}');
    assert.ok(!firstAside.includes(path.basename(res.aside)));
    for (const n of firstAside) assert.ok(fs.existsSync(path.join(root, n)));
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { Notices } = require('../src/main/notices.js');

test('avvisi: in attesa finché l\'interfaccia li chiede, consegnati una volta sola, poi in diretta', () => {
  const sent = [];
  let window = false;
  const n = new Notices((x) => window && sent.push(x));
  const delivered = [];
  n.add('Libreria danneggiata', 'error', 20000, () => delivered.push('libreria'));
  n.add('Libreria danneggiata'); // stesso avviso subito dopo: uno solo
  assert.deepEqual(sent, []);
  assert.deepEqual(delivered, []);
  window = true;
  assert.deepEqual(n.take(), [{ message: 'Libreria danneggiata', type: 'error', ms: 20000 }]);
  assert.deepEqual(delivered, ['libreria']);
  assert.deepEqual(n.take(), []);
  n.add('Disco pieno', 'error', 9000, () => delivered.push('disco'));
  assert.deepEqual(sent, [{ message: 'Disco pieno', type: 'error', ms: 9000 }]);
  assert.deepEqual(delivered, ['libreria', 'disco']);
  // interfaccia che si ricarica: si torna ad aspettare; se non riparte, quelli in attesa si mostrano altrove
  n.reset();
  n.add('Registrazione salvata in /x.wav', 'error', 20000, () => delivered.push('registrazione'));
  assert.equal(sent.length, 1);
  assert.deepEqual(n.drain().map((x) => x.message), ['Registrazione salvata in /x.wav']);
  assert.deepEqual(delivered, ['libreria', 'disco', 'registrazione']);
  // finestra chiusa: non si perde, aspetta
  window = false;
  n.take();
  n.add('Errore interno');
  assert.equal(sent.length, 1);
  window = true;
  assert.deepEqual(n.take().map((x) => x.message), ['Errore interno']);
});

test('registrazione: se non si riesce a creare il file (disco pieno) non restano file orfani né descrittori aperti', () => {
  const dir = tmpDir();
  const writeFile = fs.writeFileSync;
  const close = fs.closeSync;
  const closed = [];
  try {
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).endsWith('.incorso')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return writeFile(file, ...rest);
    };
    fs.closeSync = (fd) => {
      closed.push(fd);
      return close(fd);
    };
    assert.throws(() => recorder.startRecording(dir, { sampleRate: 48000, channels: 2 }), /[Dd]isco pieno/);
    assert.equal(closed.length, 1);
  } finally {
    fs.writeFileSync = writeFile;
    fs.closeSync = close;
  }
  try {
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('libreria: il motivo dei metadati illeggibili arriva a chi importa ma non si salva in library.json', async () => {
  const dir = tmpDir();
  const { lib, done } = libraryIn(dir);
  try {
    const html = path.join(dir, 'pagina.mp3');
    fs.writeFileSync(html, '<!doctype html><html></html>');
    const [added] = await lib.addFiles([html]);
    assert.ok(added.metadataError);
    assert.equal(lib.track(added.id).metadataError, undefined);
    lib.flush();
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'userData', 'library.json'), 'utf8'), /metadataError/);
  } finally {
    done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
