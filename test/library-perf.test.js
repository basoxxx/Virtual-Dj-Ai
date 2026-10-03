import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compatibleCodes, suggestPartners } from '../src/renderer/js/ai/mashup-plan.js';

const require = createRequire(import.meta.url);
const { Library } = require('../src/main/library.js');
const { JsonStore } = require('../src/main/store.js');

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-lib-'));
  const lib = new Library(dir);
  lib.data.tracks.a = { id: 'a', title: 'A', analyzed: true, bpm: 124 };
  return { dir, lib, done: () => {
    clearTimeout(lib.store.timer);
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('libreria: chi ha fatto la griglia (bpmEngine) resta salvato, così l\'analisi AI non riparte a ogni avvio', () => {
  const { dir, lib, done } = tempLibrary();
  lib.updateTrack('a', { bpmEngine: 'ai', bpmConfidence: 0.93, barEnergy: [0.5, 0.7] });
  lib.flush();
  const again = new Library(dir);
  assert.equal(again.track('a').bpmEngine, 'ai');
  assert.equal(again.track('a').bpmConfidence, 0.93);
  lib.updateTrack('a', { bpmEngine: 'manual' });
  assert.equal(lib.track('a').bpmEngine, 'manual');
  clearTimeout(again.store.timer);
  done();
});

test('libreria: la copia per l\'interfaccia non porta l\'energia per battuta, che resta sul disco', () => {
  const { lib, done } = tempLibrary();
  lib.updateTrack('a', { barEnergy: [0.1, 0.9], energy: 7 });
  const snap = lib.snapshot();
  assert.equal(snap.tracks[0].barEnergy, undefined);
  assert.equal(snap.tracks[0].energy, 7);
  assert.deepEqual(lib.track('a').barEnergy, [0.1, 0.9]); // il deck la chiede quando carica il brano
  assert.equal(lib.track('zzz'), null);
  done();
});

test('libreria: con molti aggiornamenti di fila il file si scrive una volta sola, dopo l\'attesa', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-store-'));
  const store = new JsonStore(path.join(dir, 'x.json'), { n: 0 }, { delay: 30 });
  let writes = 0;
  const flush = store.flush.bind(store);
  store.flush = () => {
    writes++;
    flush();
  };
  for (let i = 0; i < 50; i++) {
    store.data.n = i;
    store.save();
  }
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(writes, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'x.json'), 'utf8')).n, 49);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('analisi della libreria: prima i brani con priorità, in pausa finché c\'è da separare voce e base', async () => {
  globalThis.window = globalThis.window || {};
  globalThis.window.api = globalThis.window.api || {};
  const { BatchAnalyzer } = await import('../src/renderer/js/ai/batch-analyzer.js');
  const tracks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, path: `/m/${id}.mp3` }));
  let urgent = new Set(['d']);
  let busy = true;
  const an = new BatchAnalyzer(null, { priority: () => (t) => (urgent.has(t.id) ? 0 : t.id === 'b' ? 1 : 2), shouldYield: () => busy });
  const order = [];
  an.step = async (t) => {
    order.push(t.id);
    if (t.id === 'd') urgent = new Set(['e']); // brano messo in coda durante l'analisi: passa davanti
  };
  const running = an.run(tracks);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(an.paused, true);
  assert.deepEqual(order, []); // separazione in corso: l'analisi aspetta
  busy = false;
  await running;
  assert.deepEqual(order, ['d', 'e', 'b', 'a', 'c']);
  assert.equal(an.paused, false);
});

test('analisi della libreria: più brani insieme senza superare il limite, e stima del tempo che manca', async () => {
  globalThis.window = globalThis.window || {};
  globalThis.window.api = globalThis.window.api || {};
  const { BatchAnalyzer } = await import('../src/renderer/js/ai/batch-analyzer.js');
  const { remaining } = await import('../src/renderer/js/ui/side-ui.js').catch(() => ({}));
  const an = new BatchAnalyzer(null);
  const list = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
  let now = 0;
  let peak = 0;
  const started = [];
  await an.pass(list, 3, 'first', async (t) => {
    started.push(t.id);
    now++;
    peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    now--;
    return null;
  }, () => {});
  assert.equal(peak, 3);
  assert.equal(started.length, 10);
  assert.deepEqual(started.slice(0, 3), ['0', '1', '2']);
  // tempo rimanente: media dei tempi per brano, per la prima passata e per la rifinitura (4 volte più lenta finché non è misurata)
  an.running = true;
  an.left = { first: 100, refine: 100 };
  an.timing = { first: null, refine: null };
  assert.equal(an.eta(), null);
  an.measure('first', 2);
  assert.equal(an.eta(), 100 * 2 + 100 * 8);
  an.measure('refine', 10);
  assert.equal(an.eta(), 100 * 2 + 100 * 10);
  an.measure('first', 4);
  assert.ok(Math.abs(an.timing.first - 2.3) < 1e-9); // media mobile
  if (remaining) {
    assert.equal(remaining(null), '');
    assert.equal(remaining(30), ' · meno di 2 min');
    assert.equal(remaining(25 * 60), ' · circa 25 min');
    assert.equal(remaining(2 * 3600 + 12 * 60), ' · circa 2 h 10 min');
  }
});

test('mashup: gruppi Camelot compatibili (stessa tonalità, relativa, ±1 sulla ruota)', () => {
  assert.deepEqual([...compatibleCodes('8A')].sort(), ['7A', '8A', '8B', '9A']);
  assert.deepEqual([...compatibleCodes('12B')].sort(), ['11B', '12A', '12B', '1B']);
  assert.deepEqual([...compatibleCodes('1A')].sort(), ['12A', '1A', '1B', '2A']);
  assert.equal(compatibleCodes(''), null);
  // stesso risultato di prima: il filtro per gruppi non toglie brani compatibili
  const T = (id, bpm, key) => ({ id, bpm, key });
  const pool = [T(1, 124, 'Am'), T(2, 124, 'C'), T(3, 124, 'Em'), T(4, 124, 'Dm'), T(5, 124, 'F#'), T(6, 124, 'Bm')];
  assert.deepEqual(suggestPartners(pool[0], pool).map((c) => c.track.id), [2, 3, 4]);
});
