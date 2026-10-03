import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSetlist, parseTime, extractJson, matchEntries, claudePrompt, setlistFromQueue, libraryLines } from '../src/renderer/js/ai/setlist.js';

const lib = [
  { id: '1', path: '/m/Kevin MacLeod - Ether Disco.mp3', artist: 'Kevin MacLeod', title: 'Ether Disco', bpm: 120, key: 'C', energy: 7, genre: 'Disco', duration: 176 },
  { id: '2', path: '/m/overcast.mp3', artist: 'Kevin MacLeod', title: 'Overcast', bpm: 120, key: 'Cm', duration: 228 },
  { id: '3', path: '/m/Daft Punk - One More Time.mp3', artist: 'Daft Punk', title: 'One More Time (Radio Edit)', bpm: 123, key: 'F#m' },
  { id: '4', path: '/m/Altro - One More Time.mp3', artist: 'Altro', title: 'One More Time' },
  { id: '5', path: '/m/senza tag/Beyoncé - Déjà Vu.mp3', artist: '', title: 'Beyoncé - Déjà Vu' },
];

test('scaletta: tempi in minuti:secondi', () => {
  assert.equal(parseTime('2:30'), 150);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('45'), 45);
  assert.equal(parseTime(90), 90);
  assert.equal(parseTime('0:45.5'), 45.5);
  assert.equal(parseTime('fine'), null);
});

test('scaletta: il JSON si trova anche dentro la risposta di Claude', () => {
  const text = 'Ecco la tua scaletta!\n```json\n{ "brani": [ "A - B", ], }\n```\nBuona serata';
  assert.deepEqual(extractJson(text), { brani: ['A - B'] });
  assert.throws(() => extractJson('nessuna scaletta qui'), /JSON/);
  assert.throws(() => extractJson('{ "brani": [ }'), /JSON valido/);
});

test('scaletta: impostazioni generali, cambi di stile per brano, entrata e uscita', () => {
  const set = parseSetlist(JSON.stringify({
    scaletta: 'Aperitivo',
    dopo: 'continua',
    impostazioni: { transizioni: 'bass swap', battute: 16, energia: 'crescente' },
    brani: [
      { artista: 'Kevin MacLeod', titolo: 'Ether Disco', entrata: '0:30' },
      { titolo: 'Overcast', transizioni: 'Raffica', battute: '32', uscita: '2:10', nota: 'si sale' },
      'Daft Punk - One More Time',
      { titolo: 'X', transizioni: 'boh', battute: 0, remix: 'forse' },
      { artista: 'senza titolo' },
    ],
  }));
  assert.equal(set.title, 'Aperitivo');
  assert.equal(set.after, 'continue');
  assert.deepEqual(set.options, { style: 'bassswap', bars: 16, strategy: 'rise' });
  assert.equal(set.entries.length, 4);
  assert.equal(set.entries[0].inAt, 30);
  assert.deepEqual(set.entries[1].options, { style: 'rapid', bars: 32 });
  assert.equal(set.entries[1].outAt, 130);
  assert.equal(set.entries[1].note, 'si sale');
  assert.deepEqual([set.entries[2].artist, set.entries[2].title], ['Daft Punk', 'One More Time']);
  assert.equal(set.warnings.length, 4); // transizioni e battute sconosciute, remix non booleano, brano senza titolo
  // modelli AI e valori interni
  assert.deepEqual(parseSetlist({ brani: [{ titolo: 'a', transizioni: 'techno' }, { titolo: 'b', style: 'model' }] }).entries.map((e) => e.options.style), ['model-techno', 'model']);
  assert.equal(parseSetlist({ brani: ['a'] }).after, 'stop');
  assert.throws(() => parseSetlist({ brani: [] }), /non ha brani/);
});

test('scaletta: i brani si trovano nella libreria anche scritti in modo un po\' diverso', () => {
  const set = parseSetlist({ brani: [
    { artista: 'kevin macleod', titolo: 'ether disco' },
    { titolo: 'Overcast' },
    { artista: 'Daft Punk', titolo: 'One More Time' }, // in libreria è "(Radio Edit)"
    { artista: 'Altro', titolo: 'One More Time' },
    { artista: 'Beyonce', titolo: 'Deja Vu' }, // solo nel nome del file, senza accenti
    { file: 'overcast.mp3' },
    { artista: 'Nessuno', titolo: 'Brano che non esiste' },
  ] });
  const { found, missing } = matchEntries(set.entries, lib);
  assert.deepEqual(found.map((f) => f.track.id), ['1', '2', '3', '4', '5', '2']);
  assert.deepEqual(missing.map((e) => e.title), ['Brano che non esiste']);
});

test('scaletta: testo per Claude con formato e libreria, e coda salvata come scaletta', () => {
  const prompt = claudePrompt(lib);
  assert.match(prompt, /FORMATO DELLA SCALETTA/);
  assert.match(prompt, /LA MIA LIBRERIA \(5 brani/);
  assert.match(libraryLines(lib)[0], /^Kevin MacLeod - Ether Disco \| 120 BPM \| C \(8B\) \| energia 7\/10 \| Disco \| 02:56$/);
  const cues = [{ track: lib[1], options: { style: 'rapid', bars: 8 }, inAt: 45, outAt: null, note: 'su', used: false }];
  const data = setlistFromQueue([lib[0], lib[1]], { style: 'bassswap', bars: 16, strategy: 'rise' }, { title: 'Prova', cues });
  assert.deepEqual(data, {
    scaletta: 'Prova', dopo: 'fine',
    impostazioni: { transizioni: 'bass swap', battute: 16, energia: 'crescente' },
    brani: [
      { artista: 'Kevin MacLeod', titolo: 'Ether Disco' },
      { artista: 'Kevin MacLeod', titolo: 'Overcast', transizioni: 'raffica', battute: 8, entrata: '00:45', nota: 'su' },
    ],
  });
  // la scaletta salvata si rilegge uguale
  const again = parseSetlist(JSON.stringify(data));
  assert.deepEqual(again.entries[1].options, { style: 'rapid', bars: 8 });
  assert.equal(again.entries[1].inAt, 45);
});

test('scaletta nell\'AI DJ: coda in ordine, cambio di stile all\'entrata del brano, punti di entrata e uscita', async () => {
  const { AutoDJ } = await import('../src/renderer/js/ai/autodj.js');
  const dj = new AutoDJ({ engine: {}, decks: [], getControls: () => ({}), getPool: () => lib, random: () => 0.9 });
  const set = parseSetlist({ scaletta: 'Test', impostazioni: { transizioni: 'filtro', battute: 8 }, brani: [
    { titolo: 'Ether Disco' },
    { titolo: 'Overcast', transizioni: 'taglio', uscita: '1:41', entrata: '0:31' },
  ] });
  const { found } = matchEntries(set.entries, lib);
  dj.loadSet({ title: set.title, after: set.after, options: set.options, items: found });
  assert.equal(dj.options.mode, 'queue');
  assert.equal(dj.options.style, 'filter');
  assert.deepEqual(dj.queue.map((t) => t.id), ['1', '2']);

  const first = await dj.pickNext(null);
  assert.equal(first.track.id, '1');
  assert.match(first.reason, /scaletta «Test»/);
  const a = { track: lib[0], beatLength: 0.5, gridOffset: 0.1, duration: 176, position: 10 };
  dj.applyCue(first.cue, a);
  assert.equal(dj.options.style, 'filter'); // il primo brano non cambia niente

  const second = await dj.pickNext(lib[0]);
  const b = { track: lib[1], beatLength: 0.5, gridOffset: 0, duration: 228, position: 0, bpm: 120 };
  dj.applyCue(second.cue, b);
  assert.equal(dj.options.style, 'cut'); // da qui in poi tagli sul beat
  assert.equal(dj.options.bars, 8);
  assert.ok(dj.log.some((l) => /Scaletta: da Kevin MacLeod - Overcast transizioni taglio/.test(l.text)));

  // A non ha un'uscita decisa: B decide solo la propria entrata
  const plan = dj.makePlan(a, b);
  assert.equal(plan.type, 'cut');
  assert.equal(plan.mixIn, 32); // 0:31 allineato alla misura (2 s)
  assert.match(plan.why, /^dalla scaletta: entrata alle 00:31$/);

  // quando B è in onda la sua uscita decide l'inizio del mix verso il brano dopo
  const c = { track: lib[2], beatLength: 0.5, gridOffset: 0, duration: 200, position: 0, bpm: 120 };
  b.position = 40;
  const plan2 = dj.makePlan(b, c);
  assert.equal(plan2.startAt, 102); // 1:41 sulla misura più vicina
  assert.match(plan2.why, /uscita alle 01:41/);
  assert.equal(await dj.pickNext(lib[1]), null); // finita la scaletta il set si chiude ("fine")
});
