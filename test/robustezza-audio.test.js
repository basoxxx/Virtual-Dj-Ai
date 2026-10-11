// Errori che prima sparivano in silenzio (AI DJ, deck, analisi, worker, microfono, sampler): con Worker, decodifica,
// window.api e periferiche finti, senza Web Audio.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.window.api = globalThis.window.api || {};
const api = globalThis.window.api; // è lo stesso oggetto che api.js esporta
api.updateTrack = async () => {};
api.getCover = async () => null;
api.requestMic = async () => true;
api.on = () => () => {};

// timer lunghi (inattività dei worker, tempi massimi) che non devono tenere vivo il processo; i tempi massimi
// dell'analisi (>= 2 minuti) si possono far scattare a mano
const realSetTimeout = globalThis.setTimeout;
const longTimers = [];
globalThis.setTimeout = (f, ms, ...a) => {
  const h = realSetTimeout(f, ms, ...a);
  if (ms >= 1000) h.unref();
  if (ms >= 120000) longTimers.push({ f, ms, h });
  return h;
};
const tick = () => new Promise((r) => setImmediate(r));
globalThis.requestAnimationFrame = (fn) => realSetTimeout(fn, 0);
globalThis.cancelAnimationFrame = (h) => clearTimeout(h);

// Worker finti: il comportamento dipende dal file del worker
const workers = [];
let analysisReply = () => ({}); // opzioni della richiesta -> risultato (null = il worker non risponde)
let analysisCrashes = 0; // quante richieste di analisi fanno cadere il worker
let curvesReply = () => new Float32Array(0);
globalThis.Worker = class {
  constructor(url) {
    this.kind = String(url).match(/workers\/(\w+)\.js/)[1];
    this.terminated = false;
    this.messages = [];
    workers.push(this);
  }
  postMessage(msg) {
    this.messages.push(msg);
    const reply = (data) => realSetTimeout(() => !this.terminated && this.onmessage({ data }), 1);
    if (this.kind === 'analyzer') {
      if (analysisCrashes > 0) {
        analysisCrashes--;
        realSetTimeout(() => this.onerror({ message: 'memoria esaurita' }), 1);
        return;
      }
      reply({ id: msg.id, started: true });
      const result = analysisReply(msg.options);
      if (result) reply({ id: msg.id, result });
    } else if (this.kind === 'transition') {
      reply({ id: msg.id, curves: curvesReply() });
    }
    // chat e separator: non rispondono (worker bloccato)
  }
  terminate() {
    this.terminated = true;
  }
};
globalThis.OfflineAudioContext = class {
  async decodeAudioData() {
    const d = new Float32Array(22050);
    return { numberOfChannels: 1, length: d.length, getChannelData: () => d };
  }
};

const { Deck } = await import('../src/renderer/js/audio/deck.js');
const { MicChannel } = await import('../src/renderer/js/audio/mic.js');
const { Sampler } = await import('../src/renderer/js/audio/sampler.js');
const { configureAnalysis, refineOnce, isRefining, analysisEvents, analyze } = await import('../src/renderer/js/audio/analyzer-client.js');
const { AutoDJ } = await import('../src/renderer/js/ai/autodj.js');
const { planCurves, validCurves } = await import('../src/renderer/js/ai/transition-planner.js');
const { ChatModel } = await import('../src/renderer/js/ai/chat-model.js');
const { SegueoChat } = await import('../src/renderer/js/ai/segueochat.js');
const { StemManager } = await import('../src/renderer/js/ai/stems.js');

const AI_BEAT = { beat: { bpm: 128, offset: 0.1, engine: 'ai', confidence: 0.9 } };
const CLASSIC = { beat: { bpm: 124, offset: 0, engine: 'classic' } };

/** Deck vero (metodi di deck.js) senza AudioWorklet: i messaggi al worklet finiscono in posts. */
function realDeck(over = {}) {
  const d = Object.create(Deck.prototype);
  Object.assign(d, {
    id: 'A', track: null, duration: 60, sampleRate: 44100, lastPos: 0, lastVel: 0, lastT: 0, playing: false, cuePoint: 0,
    bpm: 0, gridOffset: 0, key: '', pitch: 0, keyShift: 0, keylock: false, quantize: true, hotcues: new Array(8).fill(null),
    loop: { in: 0, out: 0, active: false, beats: 0 }, jogWin: [], ctx: { currentTime: 0 }, strip: { setAutoGain() {} },
    engine: { autoGain: true }, fx: [{ setBpm() {} }, { setBpm() {} }], posts: [], emitted: [],
  }, over);
  d.post = (m) => d.posts.push(m);
  d.emit = (type, detail) => d.emitted.push([type, detail]);
  return d;
}

// --- B1: rifinitura AI "solo sui deck" ------------------------------------------------------------

test('rifinitura "solo sui deck": un brano già analizzato col classico passa da Beat This! quando va sul deck', async () => {
  configureAnalysis({ engine: 'ai', refine: 'deck' });
  try {
    analysisReply = (o) => (o.engine === 'ai' ? AI_BEAT : CLASSIC);
    const before = workers.flatMap((w) => w.messages).length;
    // analizzato dalla prima passata dell'analisi della libreria: BPM e tonalità ci sono già
    const track = { id: 'deck1', path: '/deck1.mp3', title: 'Deck 1', analyzed: true, bpm: 124, key: 'Am', bpmEngine: 'classic' };
    const d = realDeck({ track, bpm: 124 });
    await d.runAnalysis(track, [new Float32Array(44100)], 44100, new Uint8Array(8));
    const sent = workers.flatMap((w) => w.messages).slice(before);
    assert.ok(sent.some((m) => m.options.engine === 'ai'), 'rifinitura AI chiesta al worker');
    assert.equal(track.bpmEngine, 'ai');
    assert.equal(d.bpm, 128);
    assert.equal(d.gridOffset, 0.1);
    assert.equal(d.analyzing, false);
    assert.equal(isRefining(track), false);
  } finally {
    configureAnalysis({ engine: 'classic', refine: 'library' });
  }
});

test('rifinitura AI condivisa: deck e analisi della libreria non rifanno lo stesso brano', async () => {
  const t = { id: 'shared' };
  let runs = 0;
  let release;
  const run = () => new Promise((r) => {
    runs++;
    release = () => r({ res: AI_BEAT, duration: 100 });
  });
  const a = refineOnce(t, run);
  const b = refineOnce(t, run);
  await tick();
  assert.equal(isRefining(t), true);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(runs, 1);
  assert.equal(ra.shared, false);
  assert.equal(rb.shared, true);
  assert.equal(rb.res, AI_BEAT);
  assert.equal(isRefining(t), false);
});

// --- B4: motore AI che non parte ------------------------------------------------------------------

test('modello AI mancante sul deck: il brano non viene segnato, l\'avviso arriva una volta sola', async () => {
  configureAnalysis({ engine: 'ai', refine: 'deck' });
  const warned = [];
  const onWarn = (e) => warned.push(e.detail);
  analysisEvents.addEventListener('ai-unavailable', onWarn);
  try {
    analysisReply = (o) => (o.engine === 'ai' ? { ...CLASSIC, aiError: 'modello x.onnx non installato', aiSystemic: true } : CLASSIC);
    for (const id of ['m1', 'm2']) {
      const track = { id, path: `/${id}.mp3`, title: id, analyzed: true, bpm: 124, key: 'Am', bpmEngine: 'classic' };
      const d = realDeck({ track, bpm: 124 });
      await d.runAnalysis(track, [new Float32Array(44100)], 44100, new Uint8Array(8));
      assert.equal(track.aiRefineFailed, undefined, 'non è colpa del brano: si riprova');
      assert.equal(track.bpmEngine, 'classic');
    }
    assert.deepEqual(warned, ['modello x.onnx non installato']);
    // un errore del brano (nessuna battuta) invece non si riprova
    analysisReply = (o) => (o.engine === 'ai' ? { ...CLASSIC, aiError: 'nessuna battuta riconosciuta' } : CLASSIC);
    const track = { id: 'm3', path: '/m3.mp3', title: 'm3', analyzed: true, bpm: 124, key: 'Am', bpmEngine: 'classic' };
    await realDeck({ track, bpm: 124 }).runAnalysis(track, [new Float32Array(44100)], 44100, new Uint8Array(8));
    assert.equal(track.aiRefineFailed, true);
  } finally {
    analysisEvents.removeEventListener('ai-unavailable', onWarn);
    configureAnalysis({ engine: 'classic', refine: 'library' });
  }
});

test('analisi sul deck: se il worker cade (anche per un\'altra richiesta) si riprova una volta', async () => {
  analysisReply = () => ({ ...CLASSIC, waveform: { peak: new Float32Array(4) } });
  analysisCrashes = 1;
  const track = { id: 'crash1', path: '/crash1.mp3', title: 'Crash', analyzed: false, bpm: 0, key: '' };
  const d = realDeck({ track });
  await d.runAnalysis(track, [new Float32Array(44100)], 44100, new Uint8Array(8));
  assert.equal(analysisCrashes, 0);
  assert.ok(d.waveform, 'forma d\'onda dopo il secondo tentativo');
  assert.equal(d.bpm, 124);
  assert.ok(!d.emitted.some(([type]) => type === 'error'), JSON.stringify(d.emitted.filter(([t]) => t === 'error')));
});

// AudioWorkletNode finto: i messaggi finiscono in sent; throwNext fa fallire il costruttore
let nodeFails = false;
const nodes = [];
globalThis.AudioWorkletNode = class {
  constructor() {
    if (nodeFails) throw new Error('AudioWorklet non disponibile');
    this.sent = [];
    this.connected = true;
    this.port = { postMessage: (m) => this.sent.push(m), onmessage: null };
    nodes.push(this);
  }
  connect() {}
  disconnect() {
    this.connected = false;
  }
};

/** Deck con il nodo AudioWorklet finto (post va davvero al nodo) e un brano caricato. */
function deckWithNode(over = {}) {
  const left = new Float32Array(44100 * 60);
  const d = realDeck({ track: { id: 'w', title: 'W' }, fullBuffers: { left, right: left }, stem: 'full', playerGain: gainNode(), ...over });
  delete d.post;
  d.createNode();
  return { d, left };
}

test('motore audio del deck fermato da un errore: ripartito subito con brano, posizione, loop e impostazioni', () => {
  const { d, left } = deckWithNode({ playing: true, lastPos: 44100 * 12, keyShift: 2, keylock: true, loop: { in: 10, out: 14, active: true, beats: 8 } });
  const first = d.node;
  first.onprocessorerror(new Event('processorerror'));
  assert.notEqual(d.node, first);
  assert.equal(first.connected, false);
  assert.equal(d.broken, false);
  assert.equal(d.playing, true);
  const sent = d.node.sent;
  assert.deepEqual(sent.find((m) => m.type === 'load').left, left);
  assert.equal(sent.find((m) => m.type === 'seek').pos, 44100 * 12);
  assert.deepEqual(sent.find((m) => m.type === 'loop'), { type: 'loop', in: 44100 * 10, out: 44100 * 14, active: true });
  assert.deepEqual(sent.find((m) => m.type === 'key'), { type: 'key', value: 2 ** (2 / 12) });
  assert.deepEqual(sent.find((m) => m.type === 'keylock'), { type: 'keylock', value: true });
  assert.equal(sent.at(-1).type, 'play');
  // parte separata in uso (mashup): riparte quella, non il brano completo
  const vocals = new Float32Array(10);
  d.stem = 'vocals';
  d.stemBuffers = { left: vocals, right: vocals };
  d.node.onprocessorerror(new Event('processorerror'));
  assert.equal(d.node.sent.find((m) => m.type === 'load').left, vocals);
});

test('motore audio che non riparte: il deck non fa finta di suonare e l\'AI DJ non lo usa come pronto', () => {
  const { d } = deckWithNode({ _aiReady: true });
  // il costruttore non riesce: resta il nodo di prima, segnato come fermo
  nodeFails = true;
  const old = d.node;
  old.onprocessorerror(new Event('processorerror'));
  nodeFails = false;
  assert.equal(d.node, old);
  assert.equal(d.broken, true);
  assert.equal(d._aiReady, false);
  d.emitted.length = 0;
  d.play();
  assert.equal(d.playing, false);
  assert.ok(!old.sent.some((m) => m.type === 'play'));
  assert.match(d.emitted.find(([t]) => t === 'error')[1], /motore audio fermato, ricarica il brano/);
  // errore che si ripete: dopo 3 ripartenze in un minuto il deck si ferma
  const { d: d2 } = deckWithNode({ playing: true });
  for (let i = 0; i < 4; i++) d2.node.onprocessorerror(new Event('processorerror'));
  assert.equal(d2.broken, true);
  assert.equal(d2.playing, false);
});

// --- B11: worker bloccati o non avviati -----------------------------------------------------------

test('worker di analisi bloccato: dopo il tempo massimo la richiesta fallisce e il worker si chiude', async () => {
  analysisReply = () => null; // non risponde mai
  longTimers.length = 0;
  const p = analyze([new Float32Array(44100 * 10)], 44100, { engine: 'classic', bpm: true, tag: 'bloccato' });
  await new Promise((r) => realSetTimeout(r, 10));
  const timer = longTimers.find((t) => t.ms >= 120000);
  assert.ok(timer, 'tempo massimo avviato quando il worker comincia la richiesta');
  timer.f();
  await assert.rejects(p, (err) => err.kind === 'worker' && /non ha risposto in tempo/.test(err.message));
  const w = workers.find((x) => x.messages.some((m) => m.options.tag === 'bloccato'));
  assert.equal(w.terminated, true);
  // worker che non parte (file mancante): errore chiaro invece di un'attesa infinita
  const q = analyze([new Float32Array(100)], 44100, { engine: 'classic' });
  const w2 = workers.at(-1);
  w2.onerror({});
  await assert.rejects(q, /Worker di analisi non avviato: file mancante\?/);
  assert.equal(w2.terminated, true);
  analysisReply = () => CLASSIC;
});

test('Segueo Chat: modello che non risponde -> errore dopo il tempo massimo e worker chiuso; dopo due si riprova più tardi', async () => {
  let clock = 1000;
  const m = new ChatModel({ timeoutMs: 30, idleMs: 60000, retryMs: 180000, now: () => clock });
  await assert.rejects(m.predict('più energia'), /non ha risposto in tempo/);
  assert.equal(workers.filter((w) => w.kind === 'chat').at(-1).terminated, true);
  // un timeout solo (es. avvio a freddo con la CPU occupata) non spegne il modello
  assert.equal(m.available, true);
  await assert.rejects(m.predict('più energia'), /non ha risposto in tempo/);
  assert.equal(m.available, false);
  assert.equal(await m.predict('più energia'), null);
  clock += 180000;
  assert.equal(m.available, true);
  // modello non installato: solo comandi integrati per tutta la sessione
  const missing = new ChatModel({ now: () => clock });
  missing.run = async () => {
    throw new Error('modello segueo-chat-v2.onnx non installato');
  };
  await assert.rejects(missing.predict('ciao'));
  clock += 10 * 180000;
  assert.equal(missing.available, false);
});

test('separazione di voce e base bloccata: si ferma dopo il tempo senza avanzamento', async () => {
  const st = new StemManager({ stallMs: 30 });
  await assert.rejects(st.separate(new Float32Array(10), new Float32Array(10), () => {}), /non ha risposto in tempo/);
  assert.equal(workers.filter((w) => w.kind === 'separator').at(-1).terminated, true);
});

// --- B17: stato del modello Demucs ---------------------------------------------------------------

test('modello per i mashup: un errore nel chiedere lo stato non diventa "da scaricare"', async () => {
  api.modelStatus = async () => {
    throw new Error('IPC non disponibile');
  };
  const st = new StemManager();
  await assert.rejects(st.checkModel(), /IPC non disponibile/);
  assert.equal(st.modelInstalled, null);
  api.modelStatus = async () => ({ installed: false });
  assert.equal(await st.checkModel(), false);
});

// --- AI DJ ----------------------------------------------------------------------------------------

const T = (id, bpm = 124, extra = {}) => ({ id, title: `T${id}`, artist: '', path: `/m/${id}.mp3`, bpm, key: 'Am', energy: 5, analyzed: Boolean(bpm), bpmEngine: 'classic', mixOut: 240, ...extra });

/** Deck finto per l'AI DJ: in onda (cur) o pronto (next). load(t) riesce se loadable(t). */
function djDeck(id, track, { loadable = () => true, ...extra } = {}) {
  return {
    id, track, playing: false, position: 30, bpm: track ? track.bpm : 0, gridOffset: 0, duration: 300, tempo: 1, pitch: 0, analyzing: false,
    get loaded() { return Boolean(this.track); },
    get beatLength() { return 60 / (this.bpm || 120); },
    get remaining() { return this.duration - this.position; },
    playerGain: { gain: { setTargetAtTime() {} } }, ctx: { currentTime: 0 },
    fx: [{}, { type: 'none', on: false, mix: 0.5, setType() {}, setParam() {}, setMix() {}, setOn() {} }],
    loads: [],
    async load(t) {
      this.loads.push(t.id);
      if (!loadable(t)) return false;
      this.track = t;
      this.bpm = t.bpm;
      this.position = 0;
      return true;
    },
    seek(s) { this.position = s; },
    setPitch(p) { this.pitch = p; },
    play() { this.playing = true; },
    pause() { this.playing = false; },
    sync() {}, alignPhase() {}, emit() {}, setStem: async () => true,
    ...extra,
  };
}

function setupDJ({ pool = [], cur = T('cur'), next = null, loadable, options = {} } = {}) {
  const a = djDeck('A', cur, { playing: true });
  const b = djDeck('B', next, { loadable, position: 0 });
  const engine = { x: 0, setCrossfader(x) { this.x = x; } };
  const dj = new AutoDJ({ engine, decks: [a, b], getControls: () => ({}), getPool: () => pool, random: () => 0.5 });
  const log = [];
  dj.say = (t) => log.push(t);
  dj.wait = () => tick();
  dj.enabled = true;
  dj.setOptions({ style: 'auto', ...options });
  return { dj, a, b, engine, log };
}

test('AI DJ, rifinitura: aspetta solo se è davvero in corso, e dopo 30 s usa la griglia classica', async () => {
  configureAnalysis({ engine: 'ai', refine: 'deck' });
  try {
    // brano già analizzato col classico ma nessuno lo sta rifinendo: niente attesa di 30 s
    const { dj, a, b, log } = setupDJ({ pool: [T('n1')] });
    let waits = 0;
    dj.wait = () => {
      waits++;
      return tick();
    };
    await dj.prepareNext(a, b);
    assert.equal(waits, 0);
    assert.equal(dj.plan.toTrack.id, 'n1');
    assert.ok(!log.some((x) => /Griglia AI/.test(x)));
    // deck ancora in analisi con il motore AI: si aspetta, e dopo 300 controlli si va avanti con la griglia classica
    const s2 = setupDJ({ pool: [T('n2')] });
    s2.b.load = async function load(t) {
      this.track = t;
      this.bpm = t.bpm;
      this.analyzing = true;
      return true;
    };
    await s2.dj.prepareNext(s2.a, s2.b);
    assert.ok(s2.log.includes('Griglia AI non pronta: uso quella classica'), s2.log.join('\n'));
    assert.ok(s2.dj.plan);
  } finally {
    configureAnalysis({ engine: 'classic', refine: 'library' });
  }
});

test('AI DJ: un brano che non si carica non si ripropone (niente raffica di tentativi sullo stesso file)', async () => {
  const bad = T('bad', 124);
  const good = T('good', 110);
  const { dj, a, b, log } = setupDJ({ pool: [bad, good], loadable: (t) => t.id !== 'bad' });
  await dj.prepareNext(a, b);
  assert.equal(dj.plan, null);
  assert.ok(dj.unloadable.has('bad'));
  await dj.prepareNext(a, b);
  assert.deepEqual(b.loads, ['bad', 'good']);
  assert.equal(dj.plan.toTrack.id, 'good');
  assert.equal(log.filter((x) => /Non riesco a caricare/.test(x)).length, 1);
  assert.match(log.find((x) => /Non riesco a caricare/.test(x)), /lo salto e ne scelgo un altro/);
});

test('AI DJ: brani della coda che non si caricano vengono tolti; tre di fila e si aspetta (disco scollegato?)', async () => {
  const { dj, a, b, log } = setupDJ({ pool: [], loadable: () => false, options: { mode: 'queue' } });
  dj.setQueue([T('q1'), T('q2'), T('q3'), T('q4')]);
  for (let i = 0; i < 3; i++) await dj.prepareNext(a, b);
  assert.equal(log.filter((x) => /tolto dalla coda/.test(x)).length, 3);
  assert.ok(log.some((x) => /il disco della musica è collegato\? Riprovo tra 15 secondi/.test(x)));
  assert.ok(dj.pauseUntil > Date.now());
  dj.plan = null;
  await dj.tick();
  assert.deepEqual(b.loads, ['q1', 'q2', 'q3']); // in pausa: q4 non si prova subito
});

test('AI DJ: brano in onda senza BPM -> mix senza sync invece di bloccarsi per sempre', async () => {
  const { dj, a, b, log } = setupDJ({ cur: T('nobpm', 0), pool: [T('n1')] });
  a.analyzing = true; // analisi ancora in corso: si aspetta
  await dj.prepareNext(a, b);
  assert.equal(dj.plan, null);
  a.analyzing = false; // analisi finita senza BPM
  await dj.prepareNext(a, b);
  assert.ok(dj.plan);
  assert.equal(dj.plan.sync, false);
  assert.match(dj.plan.why, /BPM di Tnobpm non noto/);
  assert.equal(log.filter((x) => /sconosciuto/.test(x)).length, 1);
  assert.ok(Number.isFinite(dj.plan.startAt));
});

test('AI DJ: prossimo brano ancora senza BPM -> lo dice, poi ripianifica con il sync quando arriva', async () => {
  const late = T('late', 0);
  const { dj, a, b, log } = setupDJ({ pool: [late] });
  await dj.prepareNext(a, b);
  assert.ok(log.includes('Analisi di Tlate non pronta: mix senza sync'), log.join('\n'));
  assert.equal(dj.plan.noBpm, true);
  assert.doesNotMatch(dj.plan.why, /tempi troppo diversi/);
  late.bpm = 124;
  b.bpm = 124;
  await dj.tick();
  assert.equal(dj.plan, null); // si ripianifica
  await dj.tick();
  assert.equal(dj.plan.sync, true);
});

test('AI DJ: un errore a metà mix porta il crossfader sul brano entrante e libera l\'AI DJ', async () => {
  const { dj, a, b, engine, log } = setupDJ({ next: T('in') });
  const plan = dj.makePlan(a, b);
  dj.applyState = () => {
    throw new TypeError('valore non finito');
  };
  dj.beginTransition(a, b, plan);
  await new Promise((r) => realSetTimeout(r, 20));
  assert.equal(dj.transition, null);
  assert.equal(engine.x, 1);
  assert.ok(log.some((x) => /^Errore durante il mix \(valore non finito\)/.test(x)), log.join('\n'));
  assert.ok(log.includes('In onda: Tin'));
});

test('curve del modello corte o con NaN: il pianificatore le rifiuta (l\'AI DJ usa le regole)', async () => {
  assert.equal(validCurves(new Float32Array(9 * 4), 4), true);
  assert.equal(validCurves(new Float32Array(9 * 3), 4), false);
  const nan = new Float32Array(9 * 4);
  nan[20] = NaN;
  assert.equal(validCurves(nan, 4), false);
  const n = 3000;
  const wf = { binsPerSecond: 150, length: n, peak: new Float32Array(n).fill(0.5), low: new Float32Array(n), mid: new Float32Array(n), high: new Float32Array(n) };
  const deck = { waveform: wf, bpm: 128, gridOffset: 0.2, duration: 20 };
  curvesReply = () => new Float32Array(9 * 8); // il modello dovrebbe dare almeno 16 battute
  await assert.rejects(planCurves(deck, 2, deck, 0, 4), /curve del modello non valide/);
});

test('AI DJ: un errore nel ciclo finisce nel diario una volta sola', async () => {
  const { dj, log } = setupDJ();
  dj.tick = async () => {
    throw new Error('boom');
  };
  await dj.safeTick();
  await dj.safeTick();
  assert.deepEqual(log, ['Errore dell\'AI DJ: boom']);
});

test('scaletta su una libreria non ancora analizzata: errore chiaro e la coda resta com\'era', async () => {
  const pool = Array.from({ length: 6 }, (_, i) => T(`u${i}`, 0));
  const { dj } = setupDJ({ pool });
  dj.setQueue([pool[0]]);
  await assert.rejects(dj.generateSet({ length: 5 }), /Nessun brano analizzato da mettere in scaletta: premi "Analizza libreria"/);
  const chat = new SegueoChat({ automix: dj, getTracks: () => pool, getPlaylists: () => [], setOptions: (p) => dj.setOptions(p), setView: () => {} });
  const r = await chat.send('crea una scaletta di 10 brani');
  assert.deepEqual(dj.queue.map((t) => t.id), ['u0']);
  assert.match(r.text, /Nessun brano analizzato/);
  assert.doesNotMatch(r.text, /Scaletta di 0 brani/);
});

test('AI DJ spento mentre il mashup carica voce e base: la voce non parte e niente errori', async () => {
  const { dj, a, b, log } = setupDJ({ next: T('voce') });
  let release;
  const stems = [];
  a.setStem = (kind) => {
    stems.push(['A', kind]);
    return kind === 'instrumental' ? new Promise((r) => { release = r; }) : Promise.resolve(true);
  };
  b.setStem = async (kind) => {
    stems.push(['B', kind]);
    return true;
  };
  const plan = { ...dj.makePlan(a, b), mashup: { status: 'ready', vocalStart: 12, bars: 16 } };
  const started = dj.beginMashup(a, b, plan);
  dj.setEnabled(false);
  release(true);
  await started;
  assert.equal(b.playing, false);
  assert.equal(dj.transition, null);
  assert.deepEqual(stems.filter(([, k]) => k === 'vocals'), []);
  assert.ok(stems.some(([d, k]) => d === 'A' && k === 'full'), 'la base torna al brano completo');
  assert.ok(!log.some((x) => /Mashup:/.test(x)), log.join('\n'));
});

// --- B14: SegueoChat ------------------------------------------------------------------------------

test('SegueoChat: modello che dà errore -> nota una volta sola; annullamento con errori riportati', async () => {
  const { dj } = setupDJ({ pool: [T('x')] });
  const model = { available: true, predict: async () => { throw new Error('sessione ONNX rovinata'); } };
  const mashups = { remove: async () => { throw new Error('libreria non scrivibile'); }, find: () => null };
  const chat = new SegueoChat({ automix: dj, model, mashups, getTracks: () => [T('x')], getPlaylists: () => [], setOptions: (p) => dj.setOptions(p), setView: () => {} });
  const r1 = await chat.send('più energia');
  assert.match(r1.text, /Il modello Segueo Chat non risponde \(sessione ONNX rovinata\): uso solo i comandi integrati/);
  const r2 = await chat.send('transizioni lunghe');
  assert.doesNotMatch(r2.text, /non risponde/);
  r2.undo.mashups.push('m1');
  await chat.undo(r2.id);
  const last = chat.messages.at(-1);
  assert.match(last.text, /non ho potuto eliminare il mashup creato \(libreria non scrivibile\)/);
  assert.doesNotMatch(last.text, /tutto come prima/);
});

// --- B7, B21: ingresso linea e microfono --------------------------------------------------------

function fakeMedia({ fail = null, delay = 0 } = {}) {
  const calls = [];
  const stopped = [];
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      async getUserMedia(c) {
        calls.push(c.audio.deviceId);
        if (delay) await new Promise((r) => realSetTimeout(r, delay));
        if (fail && fail(c)) throw new Error('NotReadableError: dispositivo occupato');
        const id = calls.length;
        return { getTracks: () => [{ stop: () => stopped.push(id) }] };
      },
    },
  });
  return { calls, stopped };
}

const gainNode = () => ({ gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect(n) { return n; }, disconnect() {} });

test('ingresso linea: se il nuovo ingresso non si apre il deck torna sul brano invece di restare muto', async () => {
  fakeMedia({ fail: (c) => c.audio.deviceId && c.audio.deviceId.exact === 'B' });
  const d = realDeck({ playerGain: gainNode(), lineGain: gainNode() });
  d.ctx.createMediaStreamSource = () => gainNode();
  await d.setLineInput('A');
  assert.equal(d.playerGain.gain.value, 0);
  assert.equal(d.lineGain.gain.value, 1);
  await assert.rejects(d.setLineInput('B'), /dispositivo occupato/);
  assert.equal(d.playerGain.gain.value, 1);
  assert.equal(d.lineGain.gain.value, 0);
  assert.equal(d.lineDevice, null);
  // permesso negato da macOS: si dice dove riattivarlo
  api.requestMic = async () => false;
  await assert.rejects(d.setLineInput('A'), /Privacy e sicurezza → Microfono/);
  api.requestMic = async () => true;
});

function fakeMic() {
  const m = Object.create(MicChannel.prototype);
  const events = [];
  Object.assign(m, {
    ctx: { currentTime: 0, createMediaStreamSource: () => gainNode() }, input: gainNode(), gate: gainNode(),
    engine: { talk: false, setTalkover(on) { this.talk = on; } }, stream: null, source: null, deviceId: 'usb-mic', onAir: false, talkover: true, airSeq: 0,
    dispatchEvent: (e) => events.push(e),
  });
  return { m, events };
}

test('microfono: se non si apre resta quello scelto; Spazio rilasciato durante l\'apertura non lo lascia acceso', async () => {
  const media = fakeMedia({ fail: () => true });
  const { m, events } = fakeMic();
  await m.setOnAir(true);
  assert.equal(m.deviceId, 'usb-mic');
  assert.equal(m.onAir, false);
  assert.match(events.at(-1).detail, /Microfono non disponibile/);
  await m.setOnAir(true);
  assert.deepEqual(media.calls.map((x) => x && x.exact), ['usb-mic', 'usb-mic']); // non ripiega su "default"
  // tasto premuto e rilasciato mentre il sistema chiede il permesso
  fakeMedia({ delay: 20 });
  const down = m.setOnAir(true);
  await m.setOnAir(false);
  await down;
  assert.equal(m.onAir, false);
  assert.equal(m.gate.gain.value, 0);
  assert.equal(m.engine.talk, false);
  assert.ok(m.stream, 'il microfono resta aperto, spento');
  // cambio di microfono in onda: resta in onda; se il nuovo non si apre resta il vecchio
  await m.setOnAir(true);
  assert.equal(m.onAir, true);
  const old = m.stream;
  fakeMedia({ fail: () => true });
  await assert.rejects(m.open('altro'));
  assert.equal(m.stream, old);
  assert.equal(m.onAir, true);
});

// --- B15: sampler -------------------------------------------------------------------------------

test('sampler: un campione non trovato all\'avvio resta assegnato (non si perde al salvataggio)', async () => {
  const anything = () => new Proxy(function f() {}, { get: (_t, k) => (k === 'then' ? undefined : anything()), apply: () => anything(), set: () => true });
  globalThis.OfflineAudioContext = class {
    constructor() {
      return new Proxy(this, { get: (t, k) => (k === 'startRendering' ? async () => ({ duration: 1 }) : k === 'createBuffer' ? (_c, n) => ({ getChannelData: () => new Float32Array(n) }) : k === 'sampleRate' ? 44100 : anything()) });
    }
  };
  api.readFile = async (p) => {
    if (p.startsWith('/Volumes/')) throw new Error('ENOENT: no such file or directory');
    return new Uint8Array(8);
  };
  const ctx = { createGain: () => anything(), decodeAudioData: async () => ({ duration: 1 }) };
  const s = new Sampler({ ctx, samplerBus: anything() });
  await s.init([{ path: '/Volumes/USB/horn.wav', name: 'Horn', loop: true }, null, { path: '/ok/kick.wav', name: 'Kick' }]);
  assert.deepEqual(s.missing.map((x) => [x.pad, x.name]), [[1, 'Horn']]);
  assert.equal(s.pads[0].name, 'Air Horn'); // suona quello di serie
  assert.deepEqual(s.serialize().slice(0, 3), [{ path: '/Volumes/USB/horn.wav', name: 'Horn', loop: true }, { path: null, name: null, loop: false }, { path: '/ok/kick.wav', name: 'Kick', loop: false }]);
  // riassegnato dall'utente: vale il nuovo
  await s.loadFile(0, '/ok/snare.wav', 'Snare');
  assert.equal(s.serialize()[0].path, '/ok/snare.wav');
});

// --- tonalità al caricamento ------------------------------------------------------------------------

test('caricare un brano azzera la trasposizione del brano di prima (il nuovo non suona trasposto)', async () => {
  const pcm = new Float32Array(441);
  api.readFile = async () => new Uint8Array(8);
  const d = realDeck({
    keyShift: 3,
    ctx: { currentTime: 0, decodeAudioData: async () => ({ duration: 0.01, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => pcm }) },
  });
  d.runAnalysis = async () => {};
  const track = { id: 'k', path: '/ok/k.mp3', title: 'K', analyzed: true, bpm: 128, key: 'Am', bpmEngine: 'manual' };
  assert.equal(await d.load(track), true);
  assert.equal(d.keyShift, 0);
  assert.deepEqual(d.posts.filter((m) => m.type === 'key').at(-1), { type: 'key', value: 1 });
  assert.equal(d.displayKey, 'Am');
});
