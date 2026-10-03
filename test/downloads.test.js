import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DownloadWatcher, isPartialDownload, searchUrl } = require('../src/main/downloads.js');
const { isAudioFile } = require('../src/main/library.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('richieste: file ancora in scaricamento e indirizzo di ricerca', () => {
  for (const n of ['Brano.mp3.crdownload', 'Unconfirmed 123.crdownload', 'x.mp3.part', 'x.download', '.DS_Store', '~$tmp']) assert.ok(isPartialDownload(n), n);
  assert.ok(!isPartialDownload('Artista - Brano.mp3'));
  assert.equal(searchUrl('https://www.beatport.com/search?q={q}', 'Tanti auguri & co'), 'https://www.beatport.com/search?q=Tanti%20auguri%20%26%20co');
  assert.equal(searchUrl('', 'despacito'), 'https://www.google.com/search?q=despacito');
  assert.equal(searchUrl('https://bandcamp.com/search?q={q}', ''), 'https://bandcamp.com');
  assert.throws(() => searchUrl('file:///etc/passwd?q={q}', 'x'), /non valido/);
});

test('richieste: si importano solo i file audio nuovi, quando il browser ha finito di scriverli', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-dl-'));
  try {
    fs.writeFileSync(path.join(dir, 'vecchio.mp3'), 'c\'era già');
    const got = [];
    let stopped = false;
    const w = new DownloadWatcher({ accept: isAudioFile, onFile: (f) => got.push(path.basename(f)), settleMs: 120, onStop: () => { stopped = true; } });
    w.start(dir);
    // come Chrome: prima il file temporaneo che cresce, poi la rinomina
    const tmp = path.join(dir, 'Brano richiesto.mp3.crdownload');
    fs.writeFileSync(tmp, 'a');
    await sleep(150);
    fs.appendFileSync(tmp, 'bbbb');
    await sleep(150);
    assert.deepEqual(got, []); // ancora in scaricamento
    fs.renameSync(tmp, path.join(dir, 'Brano richiesto.mp3'));
    fs.writeFileSync(path.join(dir, 'documento.pdf'), 'no'); // non audio
    // file che cresce a scatti (es. download lento senza file temporaneo): si aspetta che la dimensione si fermi
    const slow = path.join(dir, 'lento.flac');
    fs.writeFileSync(slow, 'x');
    for (let i = 0; i < 3; i++) {
      await sleep(80);
      fs.appendFileSync(slow, 'yyyy');
    }
    for (let i = 0; i < 40 && got.length < 2; i++) await sleep(100);
    assert.deepEqual(got.sort(), ['Brano richiesto.mp3', 'lento.flac']);
    // lo stesso file non arriva due volte
    await sleep(2300);
    assert.equal(got.length, 2);
    w.stop();
    assert.equal(stopped, true);
    assert.equal(w.active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('richieste: cartella inesistente', () => {
  const w = new DownloadWatcher({ accept: () => true, onFile: () => {} });
  assert.throws(() => w.start(path.join(os.tmpdir(), 'non-esiste-segueo-xyz')), /non trovata/);
});
