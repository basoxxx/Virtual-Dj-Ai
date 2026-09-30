import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseMessage, genreVocabulary, matchTracks, mergeFilters, describeFilters, intentsToActions, SegueoChat,
} from '../src/renderer/js/ai/segueochat.js';
import { chatInputs, chatFeaturize, softmaxHeads, chatDecide } from '../src/renderer/js/ai/chat-features.js';
import { CHAT_THRESHOLDS } from '../src/renderer/js/ai/chat-heads.js';
import { AutoDJ } from '../src/renderer/js/ai/autodj.js';
import { matchesFilters, NO_FILTERS } from '../src/renderer/js/ai/selector.js';

const T = (id, artist, title, genre, bpm = 124, key = 'Am', energy = 6) => ({ id, artist, title, genre, bpm, key, energy, path: `/m/${id}.mp3` });
const TRACKS = [
  T('gh', 'Nova Reyes', 'Golden Hour', 'Nu Disco'), T('gc', 'Kaito Mori', 'Glass City', 'Tech House', 124, 'Am'),
  T('nd', 'Jonah Wilde', 'Night Drive', 'Melodic Techno', 124, 'Dm'), T('nl', 'Aurelia Vance', 'Northern Lights', 'Deep House', 122, 'Dm'),
  T('pa', 'Silas Hart', 'Parallel', 'Progressive House', 128, 'Bm'), T('wh', 'DJ Test', 'Warehouse', 'Techno', 130, 'Fm', 8),
];
const CTX = { tracks: TRACKS, playlists: [{ id: 'p1', name: 'Tramonto', tracks: ['gh'] }], genres: genreVocabulary(TRACKS) };
const parse = (s) => parseMessage(s, CTX).actions;

test('SegueoChat: energia, transizioni e durata a parole', () => {
  assert.deepEqual(parse('più energia'), [{ type: 'option', key: 'strategy', value: 'rise' }]);
  assert.deepEqual(parse('rilassata'), [{ type: 'option', key: 'strategy', value: 'chill' }]);
  assert.deepEqual(parse('a onde'), [{ type: 'option', key: 'strategy', value: 'wave' }]);
  assert.deepEqual(parse('fammi una serata anni 90 che parte soft e poi esplode'), [{ type: 'option', key: 'strategy', value: 'rise' }]);
  assert.deepEqual(parse('alza l\'energia e fai transizioni lunghe'), [
    { type: 'option', key: 'strategy', value: 'rise' }, { type: 'option', key: 'bars', value: 32 }]);
  assert.deepEqual(parse('transizioni con il filtro'), [{ type: 'option', key: 'style', value: 'filter' }]);
  assert.deepEqual(parse('stile techno'), [{ type: 'option', key: 'style', value: 'model-techno' }]);
  assert.deepEqual(parse('bass swap'), [{ type: 'option', key: 'style', value: 'bassswap' }]);
  assert.deepEqual(parse('mix da 60 battute'), [{ type: 'option', key: 'bars', value: 64 }]);
  assert.deepEqual(parse('spegni il remix'), [{ type: 'option', key: 'remix', value: false }]);
  assert.deepEqual(parse('niente mashup'), [{ type: 'option', key: 'mashup', value: false }]);
  assert.deepEqual(parse('usa la playlist tramonto'), [{ type: 'option', key: 'source', value: 'p1' }]);
  assert.ok(!parse('aggiungi golden hour alla playlist tramonto').some((a) => a.key === 'source'));
  assert.deepEqual(parse('segui solo la coda'), [{ type: 'option', key: 'mode', value: 'queue' }]);
});

test('SegueoChat: generi e BPM diventano filtri (e "stile techno" resta uno stile)', () => {
  assert.deepEqual(parse('solo techno'), [{ type: 'filters', genres: ['techno'] }]);
  assert.deepEqual(parse('niente house'), [{ type: 'filters', exclude: ['house'] }]);
  assert.deepEqual(parse('basta techno, voglio deep house'), [{ type: 'filters', genres: ['deep house'], exclude: ['techno'] }]);
  assert.deepEqual(parse('anche un po\' di deep house'), [{ type: 'filters', genres: ['deep house'], add: true }]);
  assert.deepEqual(parse('suona techno tra 124 e 130 bpm'), [{ type: 'filters', genres: ['techno'], bpmMin: 124, bpmMax: 130 }]);
  assert.deepEqual(parse('intorno ai 124 bpm'), [{ type: 'filters', bpmMin: 121, bpmMax: 127 }]);
  assert.deepEqual(parse('togli i filtri'), [{ type: 'filters', clear: true }]);
  // i filtri si combinano con quelli di prima
  let f = mergeFilters(NO_FILTERS, { genres: ['techno'] });
  f = mergeFilters(f, { exclude: ['tech house'], bpmMax: 130 });
  assert.equal(describeFilters(f), 'solo techno · niente tech house · fino a 130 BPM');
  assert.ok(matchesFilters(TRACKS[5], f)); // Warehouse, Techno, 130
  assert.ok(matchesFilters(TRACKS[2], f)); // Melodic Techno
  assert.ok(!matchesFilters(TRACKS[1], f)); // Tech House
  assert.equal(describeFilters(NO_FILTERS), '');
});

test('SegueoChat: brani in coda o come prossimo, trovati per titolo o artista', () => {
  assert.deepEqual(parse('metti Golden Hour come prossimo'), [{ type: 'queue', op: 'playNext', tracks: ['gh'] }]);
  assert.deepEqual(parse('dopo questo metti glass city'), [{ type: 'queue', op: 'playNext', tracks: ['gc'] }]);
  assert.deepEqual(parse('aggiungi Night Drive'), [{ type: 'queue', op: 'add', tracks: ['nd'] }]);
  assert.deepEqual(parse('suona qualcosa di Nova Reyes'), [{ type: 'queue', op: 'add', tracks: ['gh'] }]);
  assert.deepEqual(parse('togli parallel dalla coda'), [{ type: 'queue', op: 'remove', tracks: ['pa'] }]);
  assert.deepEqual(parse('svuota la coda'), [{ type: 'queue', op: 'clear' }]);
  assert.deepEqual(matchTracks('golden hour di nova reyes', TRACKS).map((t) => t.id)[0], 'gh');
  assert.deepEqual(matchTracks('zzz', TRACKS), []);
  assert.match(parseMessage('metti Pippo Baudo', CTX).notes[0], /Non trovo "pippo baudo"/);
});

test('SegueoChat: scalette, mashup, comandi, domande e "per i prossimi N brani"', () => {
  const [set] = parse('crea una scaletta di 20 brani house in crescendo');
  assert.equal(set.type, 'buildSet');
  assert.equal(set.length, 20);
  assert.equal(set.strategy, 'rise');
  assert.deepEqual(set.filters.genres, ['house']);
  assert.equal(parse('fammi un set di un\'ora rilassato')[0].length, 17);
  assert.deepEqual(parse('fai un mashup'), [{ type: 'mashup', auto: true }]);
  assert.deepEqual(parse('fai un mashup ogni tanto durante la serata'), [{ type: 'option', key: 'mashup', value: true }]);
  assert.deepEqual(parse('voce di golden hour sulla base di glass city'), [{ type: 'mashup', vocalId: 'gh', baseId: 'gc' }]);
  assert.deepEqual(parse('chiudi il set dopo questo'), [{ type: 'control', op: 'endAfterCurrent' }]);
  assert.deepEqual(parse('parti'), [{ type: 'control', op: 'start' }]);
  assert.deepEqual(parse('fermati'), [{ type: 'control', op: 'stop' }]);
  assert.deepEqual(parse('mixa ora'), [{ type: 'control', op: 'mixNow' }]);
  assert.deepEqual(parse('cambia il prossimo'), [{ type: 'control', op: 'skip' }]);
  assert.deepEqual(parse('cosa suoni?'), [{ type: 'info', what: 'now' }]);
  assert.deepEqual(parse('qual è il prossimo?'), [{ type: 'info', what: 'next' }]);
  assert.deepEqual(parse('perché?'), [{ type: 'info', what: 'why' }]);
  assert.deepEqual(parse('cosa c\'è in coda?'), [{ type: 'info', what: 'queue' }]);
  assert.deepEqual(parse('aiuto'), [{ type: 'info', what: 'help' }]);
  assert.deepEqual(parse('tagli a raffica per i prossimi 3 brani'), [{ type: 'temporary', count: 3, actions: [{ type: 'option', key: 'style', value: 'rapid' }] }]);
  assert.deepEqual(parse('per il prossimo brano solo techno'), [{ type: 'temporary', count: 1, actions: [{ type: 'filters', genres: ['techno'] }] }]);
  assert.equal(parseMessage('grazie', CTX).smallTalk, 'thanks');
  assert.deepEqual(parse('blablabla'), []);
});

// AI DJ vero con due deck finti, e SegueoChat collegata come nell'app
function setup({ mashups = null } = {}) {
  const deck = (id) => ({ id, track: null, playing: false, position: 0, bpm: 0, duration: 0, tempo: 1, remaining: 0, _aiReady: false });
  const decks = [deck('A'), deck('B')];
  const dj = new AutoDJ({ engine: {}, decks, getControls: () => ({}), getPool: () => TRACKS, random: () => 0.5 });
  dj.setEnabled = function setEnabled(on) {
    this.enabled = on;
  };
  const saved = [];
  dj.addEventListener('options', () => saved.push(dj.savedOptions()));
  const chat = new SegueoChat({
    automix: dj, mashups, getTracks: () => TRACKS, getPlaylists: () => CTX.playlists, setOptions: (p) => dj.setOptions(p), setView: () => {},
  });
  return { dj, chat, saved };
}

test('SegueoChat: esegue i comandi sull\'AI DJ, li scrive nel diario e si può annullare', async () => {
  const { dj, chat, saved } = setup();
  dj.enqueue([TRACKS[4]]);
  const r = await chat.send('più energia, transizioni con il filtro e solo techno');
  assert.equal(dj.options.strategy, 'rise');
  assert.equal(dj.options.style, 'filter');
  assert.deepEqual(dj.options.filters.genres, ['techno']);
  assert.deepEqual(r.lines, ['Energia: crescente', 'Filtri: solo techno', 'Transizioni: Filtro']);
  assert.ok(saved.length >= 3); // opzioni salvate a ogni cambio
  assert.match(dj.log.at(-1).text, /^SegueoChat: Energia/);
  await chat.send('metti Golden Hour come prossimo');
  assert.deepEqual(dj.queue.map((t) => t.id), ['gh', 'pa']);
  // annulla l'ultima risposta: la coda torna com'era
  await chat.undo(chat.messages.at(-1).id);
  assert.deepEqual(dj.queue.map((t) => t.id), ['pa']);
  // annulla la prima: opzioni e filtri di prima
  await chat.undo(chat.messages.find((m) => m.lines && m.lines.length === 3).id);
  assert.equal(dj.options.strategy, 'steady');
  assert.equal(dj.options.style, 'auto');
  assert.deepEqual(dj.options.filters, NO_FILTERS);
  assert.equal(chat.messages.at(-1).text, 'Annullato: tutto come prima.');
});

test('SegueoChat: i filtri valgono nella scelta dei brani dell\'AI DJ (e se nessun brano li rispetta si ignorano)', async () => {
  const { dj, chat } = setup();
  await chat.send('solo techno');
  // nella libreria ci sono 2 brani techno: finiti quelli, si riprende dal meno recente, sempre techno
  for (let i = 0; i < 4; i++) {
    const pick = await dj.pickNext(TRACKS[0]);
    assert.match(pick.track.genre, /Techno/);
    dj.history.push(pick.track);
  }
  assert.doesNotMatch(dj.log.map((e) => e.text).join('\n'), /Nessun brano rispetta/);
  await chat.send('solo reggaeton');
  dj.history = [];
  const pick = await dj.pickNext(TRACKS[0]);
  assert.ok(pick.track);
  assert.match(dj.log.map((e) => e.text).join('\n'), /Nessun brano rispetta i filtri/);
});

test('SegueoChat: cambi per i prossimi N brani, poi si torna alle impostazioni di prima', async () => {
  const { dj, chat, saved } = setup();
  await chat.send('tagli a raffica per i prossimi 2 brani');
  assert.equal(dj.options.style, 'rapid');
  assert.equal(saved.at(-1).style, 'auto'); // si salva quello a cui si tornerà
  dj.onTrackOnAir();
  assert.equal(dj.options.style, 'rapid');
  dj.onTrackOnAir();
  assert.equal(dj.options.style, 'auto');
  assert.equal(dj.temp, null);
});

test('SegueoChat: "chiudi il set dopo questo" non prepara altri brani e poi spegne l\'AI DJ', async () => {
  const { dj, chat } = setup();
  assert.match((await chat.send('chiudi il set dopo questo')).text, /Non sta suonando niente/);
  dj.enabled = true;
  dj.decks[0].playing = true;
  dj.decks[0].track = TRACKS[0];
  dj.enqueue([TRACKS[1]]);
  await chat.send('chiudi il set dopo questo');
  dj.decks[0].playing = false;
  assert.equal(dj.endAfterCurrent, true);
  assert.equal(await dj.pickNext(TRACKS[0]), null);
  assert.match((await chat.send('qual è il prossimo?')).text, /chiudo il set/);
  dj.history.push(TRACKS[0]);
  await dj.tick(); // nessun deck in onda: il set è finito
  assert.equal(dj.enabled, false);
  assert.equal(dj.endAfterCurrent, false);
  assert.match(dj.log.at(-1).text, /Set finito/);
});

test('SegueoChat: scaletta dal motore interno con genere ed energia della frase', async () => {
  const { dj, chat } = setup();
  const r = await chat.send('crea una scaletta di 3 brani techno');
  assert.equal(dj.queue.length, 2); // nella libreria ci sono solo 2 brani techno
  assert.ok(dj.queue.every((t) => /techno/i.test(t.genre)));
  assert.match(r.text, /In coda: /);
});

test('SegueoChat: domande sullo stato del set', async () => {
  const { dj, chat } = setup();
  assert.match((await chat.send('cosa suoni?')).text, /Non suona niente/);
  assert.match((await chat.send('come stai suonando?')).text, /AI DJ spento · scelgo i brani da tutta la libreria · energia: costante/);
  dj.enqueue([TRACKS[0], TRACKS[1]]);
  assert.match((await chat.send('cosa c\'è in coda?')).text, /In coda \(2\): 1\. Nova Reyes - Golden Hour; 2\. Kaito Mori - Glass City/);
  dj.say('Prossimo: Nova Reyes - Golden Hour — BPM 124 (+0.0%) · key 8A→8A ✓');
  dj.say('   Transizione bass swap di 16 battute alle 02:30 (brani compatibili)');
  assert.match((await chat.send('perché?')).text, /Ho scelto Nova Reyes - Golden Hour — BPM 124.*Transizione bass swap/);
  assert.match((await chat.send('aiuto')).text, /Energia: "più energia"/);
  assert.match((await chat.send('boh qwerty')).text, /Non ho capito/);
});

test('SegueoChat: mashup chiesto a parole, preparato e messo in coda', async () => {
  const made = [];
  const mashups = {
    find: () => null,
    save: async (m) => {
      const saved = { ...m, id: `m${made.length + 1}` };
      made.push(saved);
      return saved;
    },
    prepare: (id) => made.find((m) => m.id === id) && (made.find((m) => m.id === id).prepared = true),
    remove: async (id) => made.splice(made.findIndex((m) => m.id === id), 1),
  };
  const { dj, chat } = setup({ mashups });
  const r = await chat.send('voce di golden hour sulla base di glass city');
  assert.deepEqual([made[0].baseId, made[0].vocalId, made[0].prepared], ['gc', 'gh', true]);
  assert.deepEqual(dj.queue.map((t) => t.id), ['gc', 'gh']);
  assert.match(r.lines[0], /voce di Nova Reyes - Golden Hour sulla base di Kaito Mori - Glass City/);
  await chat.undo(r.id);
  assert.equal(made.length, 0);
  assert.deepEqual(dj.queue, []);
});

test('SegueoChat + modello: le richieste riconosciute diventano azioni, l\'interprete ha la precedenza', () => {
  const act = (labels, text, rules = []) => intentsToActions(labels, text, CTX, rules).actions;
  assert.deepEqual(act({ strategy: 'rise' }, 'la pista è morta, svegliala'), [{ type: 'option', key: 'strategy', value: 'rise' }]);
  const rule = [{ type: 'option', key: 'strategy', value: 'rise' }];
  assert.deepEqual(act({ strategy: 'chill' }, 'più energia', rule), rule); // l'interprete ha già capito: niente contraddizioni
  assert.deepEqual(act({ bars: 'long', style: 'fade' }, 'cambi più dolci e più lenti'), [
    { type: 'option', key: 'style', value: 'fade' }, { type: 'option', key: 'bars', value: 32 }]);
  const [set] = act({ set: 'build', strategy: 'rise', genre: 'include' }, 'mi serve una playlist di 12 pezzi techno che cresce');
  assert.equal(set.type, 'buildSet');
  assert.equal(set.length, 12);
  assert.equal(set.strategy, 'rise');
  assert.deepEqual(set.filters.genres, ['techno']);
  assert.deepEqual(act({ genre: 'exclude' }, 'la techno stasera lasciala perdere'), [{ type: 'filters', exclude: ['techno'] }]);
  assert.deepEqual(act({ genre: 'include' }, 'boh qualcosa'), []); // nessun genere nominato: niente filtro
  assert.deepEqual(act({ style: 'fade', temporary: 'yes' }, 'per un paio di pezzi sfuma di più'), [
    { type: 'temporary', count: 2, actions: [{ type: 'option', key: 'style', value: 'fade' }] }]);
  assert.deepEqual(act({ mashup: 'explicit' }, 'metti la voce di golden hour su glass city'), [{ type: 'mashup', vocalId: 'gh', baseId: 'gc' }]);
  assert.deepEqual(act({ mashup: 'explicit' }, 'glass city con sopra la voce di golden hour'), [{ type: 'mashup', vocalId: 'gh', baseId: 'gc' }]);
  assert.deepEqual(act({ queue: 'playNext' }, 'dopo quello che suona ci sta glass city'), [{ type: 'queue', op: 'playNext', tracks: ['gc'] }]);
  // richieste pericolose o equivoche viste solo dal modello, senza le parole giuste: niente
  assert.deepEqual(act({ set: 'build' }, 'mi dici una ricetta?'), []);
  assert.deepEqual(act({ control: 'stop' }, 'che bella questa'), []);
  assert.deepEqual(act({ returnTempo: 'off' }, 'che tempo fa a milano?'), []);
  const r = intentsToActions({ queue: 'add' }, 'metti quella che piace a me', CTX);
  assert.deepEqual(r.actions, []);
  assert.match(r.notes[0], /quale brano/);
});

const MODEL = fileURLToPath(new URL('../src/renderer/models/segueo-chat.onnx', import.meta.url));
test('SegueoChat + modello Segueo Chat vero: capisce modi di dire che l\'interprete non conosce', { skip: !existsSync(MODEL) && 'modello non scaricato' }, async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL)));
  const model = {
    available: true,
    predict: async (text) => {
      const probs = [];
      for (const t of chatInputs(text)) {
        const ids = chatFeaturize(t);
        const res = await s.run({ ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]) });
        probs.push(softmaxHeads(Array.from(res.logits.data)));
      }
      return chatDecide(probs[0], probs.slice(1), CHAT_THRESHOLDS);
    },
  };
  const deck = (id) => ({ id, track: null, playing: false, position: 0, bpm: 0, duration: 0, tempo: 1, remaining: 0, _aiReady: false });
  const dj = new AutoDJ({ engine: {}, decks: [deck('A'), deck('B')], getControls: () => ({}), getPool: () => TRACKS, random: () => 0.5 });
  const chat = new SegueoChat({ automix: dj, model, getTracks: () => TRACKS, getPlaylists: () => [], setOptions: (p) => dj.setOptions(p), setView: () => {} });
  assert.equal(chat.engine.id, 'model');
  const cases = [
    ['la pista è morta, svegliala un po\'', () => dj.options.strategy === 'rise'],
    ['cambi più secchi', () => dj.options.style === 'cut'],
    ['troppo forte, abbassa un po\' il ritmo', () => dj.options.strategy === 'chill'],
    ['è mezzanotte, massima potenza', () => dj.options.strategy === 'peak'],
    ['i cambi falli durare di più', () => dj.options.bars === 32],
  ];
  for (const [text, ok] of cases) {
    assert.equal(parseMessage(text, CTX).actions.length, 0, `l'interprete da solo non capisce "${text}"`);
    const r = await chat.send(text);
    assert.ok(ok(), `${text} -> ${JSON.stringify(dj.options)}`);
    assert.equal(r.engine, 'model');
  }
  assert.match((await chat.send('come si chiama questo pezzo?')).text, /Non suona niente/); // domanda capita: "cosa suoni"
  assert.match((await chat.send('mi dici una ricetta?')).text, /mi occupo solo della musica|Non ho capito/);
  const returnTempo = dj.options.returnTempo;
  await chat.send('che tempo fa a milano?');
  assert.equal(dj.options.returnTempo, returnTempo);
});
