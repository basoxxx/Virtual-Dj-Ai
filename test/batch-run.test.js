// BatchAnalyzer.run() da capo a fondo con Worker, OfflineAudioContext e window.api finti (nessun file vero).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.window.api = globalThis.window.api || {};
const api = globalThis.window.api; // è lo stesso oggetto che api.js esporta
const realSetTimeout = globalThis.setTimeout;
// timer di inattività del worker e tempi massimi dell'analisi: non devono tenere vivo il processo
globalThis.setTimeout = (f, ms, ...a) => {
  const h = realSetTimeout(f, ms, ...a);
  if (ms >= 1000) h.unref();
  return h;
};
let respond = () => ({});
let crash = () => false; // (opzioni) -> true se il worker deve cadere su questa richiesta
const calls = [];
globalThis.Worker = class {
  postMessage(msg, transfer = []) {
    // come structured clone: lo stesso buffer due volte nella lista dei trasferibili è un DataCloneError
    if (new Set(transfer).size !== transfer.length) throw new Error('DataCloneError: transferable duplicato');
    calls.push(msg.options);
    if (crash(msg.options)) {
      realSetTimeout(() => this.onerror({ message: 'memoria esaurita' }), 1);
      return;
    }
    realSetTimeout(() => this.onmessage({ data: { id: msg.id, result: respond(msg.options) } }), 1);
  }
  terminate() {}
};
globalThis.OfflineAudioContext = class {
  async decodeAudioData(buf) {
    // 3 byte = file rovinato
    if (buf.byteLength === 3) throw new Error('EncodingError: formato non riconosciuto');
    const d = new Float32Array(22050 * 4);
    return { numberOfChannels: 1, length: d.length, getChannelData: () => d };
  }
};
api.readFile = async (p) => {
  if (p.startsWith('/Volumes/')) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  return new Uint8Array(p.includes('rotto') ? 3 : 8);
};
const updates = [];
api.updateTrack = async (id, patch) => updates.push([id, patch]);

const { BatchAnalyzer } = await import('../src/renderer/js/ai/batch-analyzer.js');
const { configureAnalysis, needsAiRefine, analysisEvents } = await import('../src/renderer/js/audio/analyzer-client.js');
const full = (extra) => ({ analyzed: true, bpm: 124, key: 'Am', energy: 5, mixOut: 100, gain: 2, bpmEngine: 'classic', ...extra });
const aiBeat = { beat: { bpm: 128, offset: 0.1, engine: 'ai', confidence: 0.9 }, loudness: { gainDb: -3 } };
const FIRST = { beat: { bpm: 126, offset: 0.2, confidence: 0.8 }, key: { key: 'Fm' }, energy: 7, structure: { mixIn: 8, mixOut: 180, introEnd: 16, outroStart: 190, barEnergy: [1] } };

/** Esegue l'analisi e restituisce il riepilogo finale ('finished'). */
async function runWith(an, tracks) {
  let summary = null;
  an.addEventListener('finished', (e) => {
    summary = e.detail;
  }, { once: true });
  await an.run(tracks);
  return summary;
}

test('prima passata: campi salvati; file non decodificabile segnato e non più in coda', async () => {
  configureAnalysis({ engine: 'classic', refine: 'library' });
  calls.length = 0;
  updates.length = 0;
  respond = () => FIRST;
  const ok = { id: 'ok', path: '/ok.mp3', title: 'Ok' };
  const bad = { id: 'bad', path: '/rotto.mp3', title: 'Rotto' };
  const summary = await runWith(new BatchAnalyzer(null), [ok, bad]);
  assert.equal(ok.bpm, 126);
  assert.equal(ok.bpmEngine, 'classic');
  assert.equal(ok.mixIn, 8);
  assert.equal(ok.mixOut, 180);
  assert.equal(ok.key, 'Fm');
  assert.equal(bad.analysisFailed, true);
  assert.deepEqual(BatchAnalyzer.pending([ok, bad]), []);
  assert.equal(summary.analyzed, 1);
  assert.deepEqual(summary.failed.map((f) => [f.track.id, /non decodificabile/.test(f.reason)]), [['bad', true]]);
});

test('disco scollegato: il brano non viene segnato (si riprova alla prossima analisi) e il riepilogo lo dice', async () => {
  configureAnalysis({ engine: 'classic', refine: 'library' });
  respond = () => FIRST;
  const away = { id: 'away', path: '/Volumes/USB/brano.mp3', title: 'Lontano' };
  const an = new BatchAnalyzer(null);
  const progress = [];
  an.addEventListener('progress', (e) => progress.push(e.detail.failed.length));
  const summary = await runWith(an, [away]);
  assert.equal(away.analysisFailed, undefined);
  assert.deepEqual(BatchAnalyzer.pending([away]), [away]);
  assert.equal(summary.analyzed, 0);
  assert.match(summary.failed[0].reason, /file non raggiungibile/);
  assert.equal(progress.at(-1), 1);
  assert.equal(an.running, false);
  // ricollegato il disco, la prossima analisi lo fa
  api.readFile = async () => new Uint8Array(8);
  await runWith(an, [away]);
  assert.equal(away.bpm, 126);
  api.readFile = async (p) => {
    if (p.startsWith('/Volumes/')) throw new Error('ENOENT');
    return new Uint8Array(p.includes('rotto') ? 3 : 8);
  };
});

test('worker caduto: il brano si riprova una volta; se cade di nuovo è segnato', async () => {
  configureAnalysis({ engine: 'classic', refine: 'library' });
  respond = () => FIRST;
  let crashes = 1;
  crash = () => crashes-- > 0;
  const t = { id: 'w1', path: '/w1.mp3', title: 'W1' };
  let summary = await runWith(new BatchAnalyzer(null), [t]);
  assert.equal(t.bpm, 126);
  assert.deepEqual(summary.failed, []);
  crash = () => true;
  const t2 = { id: 'w2', path: '/w2.mp3', title: 'W2' };
  summary = await runWith(new BatchAnalyzer(null), [t2]);
  assert.equal(t2.analysisFailed, true);
  assert.match(summary.failed[0].reason, /memoria esaurita/);
  crash = () => false;
});

test('rifinitura AI: segna bpmEngine "ai", non tocca il gain, non riparte al prossimo avvio', async () => {
  configureAnalysis({ engine: 'ai', refine: 'library' });
  respond = () => aiBeat;
  const t = { id: 't', path: '/t.mp3', ...full() };
  await new BatchAnalyzer(null).run([t]);
  assert.equal(t.bpm, 128);
  assert.equal(t.bpmEngine, 'ai');
  assert.equal(t.gain, 2);
  assert.equal(needsAiRefine(t), false);
  configureAnalysis({ engine: 'classic' });
});

test('rifinitura AI: griglia corretta a mano durante la rifinitura -> non sovrascritta', async () => {
  configureAnalysis({ engine: 'ai', refine: 'library' });
  const t = { id: 'm', path: '/m.mp3', ...full() };
  respond = () => {
    t.bpmEngine = 'manual';
    t.bpm = 125;
    return aiBeat;
  };
  await new BatchAnalyzer(null).run([t]);
  assert.equal(t.bpm, 125);
  configureAnalysis({ engine: 'classic' });
});

test('rifinitura AI non riuscita su un brano (il worker ripiega sul classico) -> aiRefineFailed, niente salvataggio', async () => {
  configureAnalysis({ engine: 'ai', refine: 'library' });
  respond = () => ({ beat: { bpm: 124, offset: 0, engine: 'classic' }, aiError: 'nessuna battuta riconosciuta' });
  const t = { id: 'f', path: '/f.mp3', ...full() };
  updates.length = 0;
  const summary = await runWith(new BatchAnalyzer(null), [t]);
  assert.equal(t.aiRefineFailed, true);
  assert.deepEqual(updates, []);
  assert.deepEqual(summary.failed, []); // resta l'analisi classica: non è un brano "non riuscito"
  configureAnalysis({ engine: 'classic' });
});

test('motore AI che non parte (modello mancante): rifinitura fermata subito, brani non segnati, un avviso', async () => {
  configureAnalysis({ engine: 'ai', refine: 'library' });
  const warned = [];
  const onWarn = (e) => warned.push(e.detail);
  analysisEvents.addEventListener('ai-unavailable', onWarn);
  calls.length = 0;
  respond = () => ({ beat: { bpm: 124, offset: 0, engine: 'classic' }, aiError: 'modello segueo-analisi-battute.onnx non installato', aiSystemic: true });
  const tracks = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, path: `/s${i}.mp3`, ...full() }));
  const an = new BatchAnalyzer(null);
  const summary = await runWith(an, tracks);
  assert.ok(calls.length <= 2, `richieste al worker: ${calls.length}`); // al massimo i due brani già in volo
  assert.ok(tracks.every((t) => !t.aiRefineFailed && needsAiRefine(t)));
  assert.match(summary.aiError, /non installato/);
  assert.match(an.aiError, /non installato/);
  assert.deepEqual(warned, ['modello segueo-analisi-battute.onnx non installato']);
  analysisEvents.removeEventListener('ai-unavailable', onWarn);
  configureAnalysis({ engine: 'classic' });
});

test('"rifinitura solo sui deck": nessuna analisi AI in background', async () => {
  configureAnalysis({ engine: 'ai', refine: 'deck' });
  calls.length = 0;
  const t = { id: 'd', path: '/d.mp3', ...full() };
  await new BatchAnalyzer(null).run([t]);
  assert.equal(calls.filter((o) => o.engine === 'ai').length, 0);
  configureAnalysis({ engine: 'classic', refine: 'library' });
});

test('errore imprevisto (es. nella priorità): l\'analisi non resta "in corso" per sempre e lo dice', async () => {
  const an = new BatchAnalyzer(null, { priority: () => { throw new Error('libreria non pronta'); } });
  const summary = await runWith(an, [{ id: 'p1', path: '/p1.mp3' }, { id: 'p2', path: '/p2.mp3' }]);
  assert.equal(an.running, false);
  assert.match(summary.error, /libreria non pronta/);
});

test('stop(): nessun nuovo brano dopo la richiesta', async () => {
  const an = new BatchAnalyzer(null);
  let started = 0;
  await an.pass(Array.from({ length: 10 }, (_, i) => ({ id: String(i) })), 2, 'first', async () => {
    if (++started === 1) an.stop();
    await new Promise((r) => realSetTimeout(r, 5));
    return null;
  }, () => {});
  assert.ok(started <= 2, `partiti ${started}`);
});
