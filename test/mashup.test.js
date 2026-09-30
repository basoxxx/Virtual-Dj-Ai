import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  mashupCompatibility, suggestPartners, pickPartner, pickPair, vocalEntryFrom, autoBaseStart, barNumber, stepPoint, savedStartAt, FADE_BARS,
} from '../src/renderer/js/ai/mashup-plan.js';
import { AutoDJ } from '../src/renderer/js/ai/autodj.js';

const require = createRequire(import.meta.url);
const { Library } = require('../src/main/library.js');

// 120 BPM: una battuta dura 2 s
const T = (id, bpm, key, extra = {}) => ({ id, title: `T${id}`, artist: `A${id}`, path: `/m/${id}.mp3`, bpm, key, gridOffset: 0.5, duration: 300, ...extra });

test('mashup: compatibilità di tonalità e tempo della voce sulla base', () => {
  const ok = mashupCompatibility(T(1, 124, 'Am'), T(2, 126, 'C'));
  assert.equal(ok.known, true);
  assert.equal(ok.keyOk, true); // relativa maggiore
  assert.equal(ok.tempoOk, true);
  assert.ok(Math.abs(ok.pitch - (124 / 126 - 1) * 100) < 1e-9); // la voce rallenta per stare sulla base
  const far = mashupCompatibility(T(1, 124, 'Am'), T(3, 100, 'F#'));
  assert.equal(far.keyOk, false);
  assert.equal(far.tempoOk, false);
  // metà tempo: 87 e 174 BPM stanno insieme senza cambiare velocità
  assert.ok(Math.abs(mashupCompatibility(T(1, 174, 'Am'), T(4, 87, 'Am')).pitch) < 1e-9);
  assert.equal(mashupCompatibility(T(1, 124, 'Am'), T(5, 0, '')).known, false);
});

test('mashup: proposte ordinate, senza il brano stesso né brani non analizzati o incompatibili', () => {
  const base = T(1, 124, 'Am');
  const pool = [base, T(2, 124, 'Am'), T(3, 128, 'Em'), T(4, 124, 'F#'), T(5, 0, ''), T(6, 140, 'Am'), T(7, 125, 'C')];
  assert.deepEqual(suggestPartners(base, pool).map((c) => c.track.id), [2, 7, 3]);
  assert.equal(suggestPartners(base, pool, { limit: 1 }).length, 1);
  assert.deepEqual(suggestPartners(T(9, 0, ''), pool), []);
});

test('mashup: l\'AI sceglie il brano che manca, una proposta nuova a ogni pressione, mai un mashup già salvato', () => {
  const base = T(1, 124, 'Am');
  const pool = [base, T(2, 124, 'Am'), T(3, 128, 'Em'), T(4, 124, 'F#'), T(7, 125, 'C')];
  assert.equal(pickPartner(base, pool).id, 2);
  assert.equal(pickPartner(base, pool, { tried: new Set([2]) }).id, 7);
  assert.equal(pickPartner(base, pool, { tried: new Set([2, 7]) }).id, 3);
  assert.equal(pickPartner(base, pool, { tried: new Set([2, 7, 3]) }), null); // 4 non è compatibile
  assert.equal(pickPartner(base, pool, { isSaved: (id) => id === 2 }).id, 7);
});

test('mashup: l\'AI sceglie base e voce, la coppia più compatibile tra quelle non ancora proposte o salvate', () => {
  const pool = [T(1, 124, 'Am'), T(2, 124, 'Am'), T(3, 100, 'F#'), T(4, 0, '')];
  const first = pickPair(pool, { random: () => 0 });
  assert.deepEqual([first.base.id, first.vocal.id].sort(), [1, 2]);
  // provate entrambe le direzioni della coppia (o salvate): non resta nulla di compatibile
  assert.equal(pickPair(pool, { tried: new Set(['1:2', '2:1']) }), null);
  assert.equal(pickPair(pool, { isSaved: () => true }), null);
  const other = pickPair(pool, { tried: new Set([`${first.base.id}:${first.vocal.id}`]) });
  assert.deepEqual([other.base.id, other.vocal.id], [first.vocal.id, first.base.id]);
  assert.equal(pickPair([T(3, 100, 'F#')]), null);
});

test('mashup: la voce entra all\'inizio della frase di 4 battute in cui si sente', () => {
  const sr = 1000;
  const x = new Float32Array(300 * sr);
  // voce forte dalla battuta 10 (da 0,5 s: 0,5 + 10·2 = 20,5 s), prima solo un filo
  for (let i = 0; i < x.length; i++) x[i] = i / sr >= 20.5 ? 0.5 : 0.01;
  assert.equal(vocalEntryFrom(x, sr, 120, 0.5), 0.5 + 8 * 2); // frase che inizia alla battuta 8
  assert.equal(vocalEntryFrom(new Float32Array(10 * sr), sr, 120, 0), 0); // silenzio: dall'inizio
});

test('mashup: punto automatico della base sulla griglia, con spazio per voce e dissolvenza', () => {
  const t = T(1, 120, 'Am', { mixOut: 240.7 });
  assert.equal(autoBaseStart(t, 16), 240.5);
  // con 32 battute di voce il punto di mix è troppo tardi: si anticipa
  const at = autoBaseStart(t, 32);
  assert.ok(at + (32 + FADE_BARS) * 2 <= 300, `${at}`);
  assert.equal((at - 0.5) % 2, 0);
  // senza punto di mix: prima della fine
  assert.ok(autoBaseStart(T(2, 120, 'Am'), 16) < 300 - 24 * 2);
});

test('mashup: frecce di 4 battute sulla griglia, dentro il brano', () => {
  const t = T(1, 120, 'Am');
  assert.equal(stepPoint(40.5, 4, t), 48.5);
  assert.equal(stepPoint(40.4, -1, t), 38.5); // si riallinea alla griglia
  assert.equal(stepPoint(2.5, -8, t), 0.5);
  assert.equal(stepPoint(296.5, 4, t), 0.5 + 148 * 2);
  assert.equal(barNumber(0.5, t), 1);
  assert.equal(barNumber(48.5, t), 25);
});

test('mashup salvato: il punto scelto vale se è ancora davanti', () => {
  const deck = { bpm: 120, gridOffset: 0.5, duration: 300, position: 30, track: { mixOut: 240.5 } };
  assert.equal(savedStartAt({ baseStart: 100.5, bars: 16 }, deck), 100.5);
  assert.equal(savedStartAt({ baseStart: null, bars: 16 }, deck), 240.5);
  assert.equal(savedStartAt({ baseStart: 20.5, bars: 16 }, { ...deck }), null); // già passato
  assert.equal(savedStartAt({ baseStart: 299, bars: 16 }, deck), null); // troppo vicino alla fine
});

test('libreria: i mashup si salvano, si aggiornano e spariscono con i loro brani', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segueo-mashup-'));
  const lib = new Library(dir);
  lib.data.tracks.a = { id: 'a' };
  lib.data.tracks.b = { id: 'b' };
  lib.data.tracks.c = { id: 'c' };
  assert.throws(() => lib.saveMashup({ baseId: 'a', vocalId: 'a' }));
  assert.throws(() => lib.saveMashup({ baseId: 'a', vocalId: 'zzz' }));
  const m = lib.saveMashup({ baseId: 'a', vocalId: 'b', bars: 32, baseStart: -1, vocalStart: 12.5, extra: 'x' });
  assert.equal(m.bars, 32);
  assert.equal(m.baseStart, null);
  assert.equal(m.vocalStart, 12.5);
  assert.equal(m.extra, undefined);
  assert.equal(lib.saveMashup({ ...m, bars: 100 }).bars, 16);
  assert.equal(lib.snapshot().mashups.length, 1);
  lib.saveMashup({ baseId: 'c', vocalId: 'a' });
  lib.saveMashup({ baseId: 'b', vocalId: 'c' });
  lib.removeTrack('a');
  assert.deepEqual(lib.snapshot().mashups.map((x) => [x.baseId, x.vocalId]), [['b', 'c']]);
  lib.deleteMashup(lib.snapshot().mashups[0].id);
  assert.equal(lib.snapshot().mashups.length, 0);
  lib.flush();
  // una libreria salvata prima dei mashup si apre con l'elenco vuoto
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, folders: [], tracks: {}, playlists: [], history: [] }));
  assert.deepEqual(new Library(dir).snapshot().mashups, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// AI DJ con due deck finti fermi: il brano in onda (base) e il successivo (voce)
function setup({ mashups = [], options = {}, pool = [] } = {}) {
  const deck = (id, track, position = 30) => ({ id, track, position, bpm: track.bpm, beatLength: 60 / track.bpm, gridOffset: track.gridOffset, duration: track.duration, tempo: 1 });
  const base = T('base', 120, 'Am', { mixOut: 240.5 });
  const vocal = T('vocal', 120, 'F#'); // tonalità lontane: il mashup automatico non partirebbe
  const cur = deck('A', base);
  const next = deck('B', vocal, 0);
  const log = [];
  const stems = { ensure: async () => true, checkModel: async () => true, vocalEntry: async () => 64.5 };
  const dj = new AutoDJ({ engine: {}, decks: [cur, next], getControls: () => ({}), getPool: () => pool, stems, getMashups: () => mashups, random: () => 0 });
  dj.say = (t) => log.push(t);
  dj.setOptions({ style: 'bassswap', ...options });
  return { dj, cur, next, base, vocal, log };
}

test('AI DJ: un mashup salvato decide il punto di mix e si fa anche con tonalità lontane', async () => {
  const saved = { id: 'm1', baseId: 'base', vocalId: 'vocal', bars: 32, baseStart: 100.5, vocalStart: 40.5 };
  const { dj, cur, next, log } = setup({ mashups: [saved] });
  const plan = dj.makePlan(cur, next);
  assert.equal(plan.saved, saved);
  assert.equal(plan.startAt, 100.5);
  dj.plan = plan;
  await dj.prepareSavedMashup(plan);
  assert.deepEqual(plan.mashup, { status: 'ready', saved: true, vocalStart: 40.5, bars: 32 });
  assert.match(log.at(-1), /Mashup salvato pronto/);
  // senza mashup salvato per questa coppia il piano resta quello normale
  const { dj: dj2, cur: c2, next: n2 } = setup({ mashups: [{ ...saved, baseId: 'vocal', vocalId: 'base' }] });
  const normal = dj2.makePlan(c2, n2);
  assert.equal(normal.saved, undefined);
  assert.equal(normal.startAt, 240.5);
});

test('AI DJ: mashup salvato con entrata automatica della voce e punto già passato', async () => {
  const saved = { id: 'm1', baseId: 'base', vocalId: 'vocal', bars: 16, baseStart: 10.5, vocalStart: null };
  const { dj, cur, next } = setup({ mashups: [saved] });
  const plan = dj.makePlan(cur, next);
  assert.equal(plan.startAt, 240.5); // 10,5 s è già passato: vale il punto di mix
  dj.plan = plan;
  await dj.prepareSavedMashup(plan);
  assert.equal(plan.mashup.vocalStart, 64.5);
  // se la separazione non riesce resta la transizione normale
  dj.stems.ensure = async () => {
    throw new Error('modello mancante');
  };
  await dj.prepareSavedMashup(plan);
  assert.equal(plan.mashup.status, 'failed');
});

test('AI DJ: con l\'opzione mashup, dopo la base di un mashup salvato sceglie la sua voce', async () => {
  const base = T('base', 120, 'Am');
  const pool = [base, T('x', 120, 'Am'), T('vocal', 120, 'F#')];
  const mashups = [{ id: 'm1', baseId: 'base', vocalId: 'vocal', bars: 16 }];
  const on = setup({ mashups, pool, options: { mashup: true } });
  on.dj.decks = [];
  const pick = await on.dj.pickNext(base);
  assert.equal(pick.track.id, 'vocal');
  assert.match(pick.reason, /mashup salvato/);
  const off = setup({ mashups, pool, options: { mashup: false } });
  off.dj.decks = [];
  assert.equal((await off.dj.pickNext(base)).track.id, 'x');
  // voce già suonata: non si ripete
  on.dj.history = [pool[2]];
  assert.equal((await on.dj.pickNext(base)).track.id, 'x');
});

test('gestore dei mashup: prepara voce e base, trova l\'entrata della voce e la salva', async () => {
  const store = [];
  globalThis.window = globalThis.window || {};
  globalThis.window.api = {
    saveMashup: async (m) => {
      const saved = { bars: 16, baseStart: null, vocalStart: null, ...m, id: m.id || `m${store.length + 1}` };
      store.push(saved);
      return saved;
    },
    deleteMashup: async () => {},
  };
  const { MashupManager } = await import('../src/renderer/js/ai/mashups.js');
  const tracks = { a: T('a', 120, 'Am'), b: T('b', 120, 'Am') };
  const onDisk = new Set();
  let fail = true;
  const stems = new EventTarget();
  Object.assign(stems, {
    running: null,
    isBusy: () => false,
    has: async (t) => onDisk.has(t.id),
    ensure: async (t) => {
      if (fail) throw new Error('modello mancante');
      onDisk.add(t.id);
      return true;
    },
    cleared: [],
    clearFailure(t) {
      this.cleared.push(t.id);
    },
    vocalEntry: async (t) => (t.id === 'b' ? 32.5 : 0),
  });
  const mm = new MashupManager({ stems, getTrack: (id) => tracks[id], bpmWait: 1000 });
  const m = await mm.save({ baseId: 'a', vocalId: 'b', bars: 16 });
  assert.equal(mm.status(m).id, 'todo');
  await mm.prepare(m.id);
  assert.deepEqual(mm.status(mm.get(m.id)), { id: 'failed', text: 'modello mancante' });
  fail = false;
  assert.equal(mm.prepareAll(), 1); // riprova quelli con errore
  for (let i = 0; i < 100 && mm.preparing.size; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(stems.cleared, ['a', 'b', 'a', 'b']);
  assert.equal(mm.get(m.id).vocalStart, 32.5);
  assert.equal(mm.status(mm.get(m.id)).id, 'ready');
  assert.equal(mm.find('a', 'b').id, m.id);
  // all'avvio: ciò che è già separato su disco risulta pronto; senza un brano il mashup è "mancante"
  const fresh = new MashupManager({ stems, getTrack: (id) => tracks[id] });
  await fresh.setList([mm.get(m.id), { id: 'x', baseId: 'a', vocalId: 'gone', bars: 16, vocalStart: 1 }]);
  assert.equal(fresh.status(fresh.get(m.id)).id, 'ready');
  assert.equal(fresh.status(fresh.get('x')).id, 'missing');
  await fresh.remove(m.id);
  assert.equal(fresh.get(m.id), null);
});

test('gestore dei mashup: se il brano della voce non ha ancora il BPM (analisi in pausa) lo aspetta', async () => {
  globalThis.window = globalThis.window || {};
  globalThis.window.api = { saveMashup: async (m) => ({ ...m, id: m.id || 'm1' }), deleteMashup: async () => {} };
  const { MashupManager } = await import('../src/renderer/js/ai/mashups.js');
  const tracks = { a: T('a', 120, 'Am'), b: T('b', 0, '') };
  const stems = Object.assign(new EventTarget(), {
    running: null, isBusy: () => false, has: async () => true, ensure: async () => true, clearFailure() {}, vocalEntry: async () => 16.5,
  });
  const mm = new MashupManager({ stems, getTrack: (id) => tracks[id], bpmWait: 2000 });
  const m = await mm.save({ baseId: 'a', vocalId: 'b', bars: 16, vocalStart: null });
  setTimeout(() => { tracks.b.bpm = 124; }, 300); // l'analisi riparte dopo la separazione
  await mm.prepare(m.id);
  assert.equal(mm.status(mm.get(m.id)).id, 'ready');
  assert.equal(mm.get(m.id).vocalStart, 16.5);
  // se il BPM non arriva: errore chiaro, non un'attesa infinita
  tracks.b.bpm = 0;
  const m2 = await mm.save({ id: 'm2', baseId: 'a', vocalId: 'b', bars: 16, vocalStart: null });
  const quick = new MashupManager({ stems, getTrack: (id) => tracks[id], bpmWait: 300 });
  quick.list = [m2];
  await quick.prepare('m2');
  assert.match(quick.status(m2).text, /BPM/);
});
