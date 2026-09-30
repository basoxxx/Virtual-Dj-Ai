import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatNormalize, chatFeaturize, splitClauses, chatInputs, softmaxHeads, chatDecide } from '../src/renderer/js/ai/chat-features.js';
import { CHAT_HEADS, CHAT_THRESHOLDS } from '../src/renderer/js/ai/chat-heads.js';

const FIX = new URL('./fixtures/segueo-chat/', import.meta.url);
const CASES = JSON.parse(readFileSync(new URL('cases.json', FIX), 'utf8'));
const DECISIONS = JSON.parse(readFileSync(new URL('decisions.json', FIX), 'utf8'));
const MODEL = fileURLToPath(new URL('../src/renderer/models/segueo-chat.onnx', import.meta.url));

test('Segueo Chat: testo e caratteristiche identici a ml/segueochat (Python)', () => {
  for (const c of CASES) {
    assert.equal(chatNormalize(c.text), c.normalized, c.text);
    assert.deepEqual(chatFeaturize(c.text), c.ids, c.text);
  }
  assert.deepEqual(chatFeaturize(''), [0]);
});

test('Segueo Chat: un messaggio si divide in parti come in addestramento', () => {
  assert.deepEqual(splitClauses('Più energia, transizioni lunghe e niente house! poi metti golden hour'),
    ['più energia', 'transizioni lunghe', 'niente house', 'metti golden hour']);
  assert.deepEqual(chatInputs('solo techno'), ['solo techno']); // una parte sola: basta il messaggio intero
  assert.equal(chatInputs('alza e scendi').length, 3);
});

test('Segueo Chat: soglie per ogni testa e decisione (saluti solo senza richieste)', () => {
  for (const h of Object.keys(CHAT_HEADS)) {
    assert.ok(CHAT_THRESHOLDS.clause[h] > 0 && CHAT_THRESHOLDS.full[h] > 0, h);
  }
  // punteggi finti: energia crescente sicura nel messaggio intero, saluto nella parte
  const logits = (set) => {
    const out = [];
    for (const [h, labels] of Object.entries(CHAT_HEADS)) labels.forEach((l) => out.push(set[h] === l ? 20 : 0));
    return softmaxHeads(out);
  };
  const full = logits({ strategy: 'rise', talk: 'hello' });
  assert.deepEqual(chatDecide(full, [], CHAT_THRESHOLDS), { strategy: 'rise' });
  assert.deepEqual(chatDecide(logits({ talk: 'hello' }), [], CHAT_THRESHOLDS), { talk: 'hello' });
});

test('Segueo Chat: con onnxruntime-web l\'app decide come Python', { skip: !existsSync(MODEL) && 'modello non scaricato' }, async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const s = await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL)));
  const run = async (text) => {
    const ids = chatFeaturize(text);
    const r = await s.run({ ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]) });
    return Array.from(r.logits.data);
  };
  let maxErr = 0;
  for (const c of CASES) {
    const got = await run(c.text);
    for (let i = 0; i < got.length; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - c.logits[i]));
  }
  // int8: i kernel WASM arrotondano diversamente da quelli nativi
  assert.ok(maxErr < 0.5, `scarto massimo ${maxErr}`);
  let same = 0;
  for (const d of DECISIONS) {
    const probs = [];
    for (const t of chatInputs(d.text)) probs.push(softmaxHeads(await run(t)));
    const got = chatDecide(probs[0], probs.slice(1), CHAT_THRESHOLDS);
    if (JSON.stringify(got) === JSON.stringify(d.labels)) same++;
  }
  assert.ok(same >= DECISIONS.length - 1, `decisioni uguali a Python: ${same}/${DECISIONS.length}`);
});
