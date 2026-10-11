// Uscite del motore audio (master, cuffia, scheda a 4 uscite) su un AudioContext finto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/renderer/js/audio/engine.js';

function fakeEngine({ outputs = 4, setSinkId } = {}) {
  const conns = [];
  const errors = [];
  const node = (name) => ({ name, connect(dst, out = 0, inp = 0) { conns.push([name, dst.name, out, inp]); return dst; }, disconnect() {} });
  let k = 0;
  const dest = { name: 'dest', maxChannelCount: outputs, channelCount: 2 };
  const ctx = { destination: dest, setSinkId, createChannelMerger: () => node('merger'), createChannelSplitter: () => node(`split${k++}`) };
  const e = Object.create(AudioEngine.prototype);
  Object.assign(e, { ctx, routing: {}, masterRoute: node('master'), hpRoute: node('hp'), splitMerger: null, hpAudio: { pause() {}, srcObject: null } });
  e.dispatchEvent = (ev) => errors.push(ev.detail);
  return { e, conns, errors, dest };
}

test('uscite "quad": casse su 1-2, cuffia su 3-4; con 2 uscite la cuffia non finisce sulle casse', async () => {
  const { e, conns, errors, dest } = fakeEngine();
  assert.deepEqual(await e.applyRouting({ mode: 'quad' }), { outputs: 4, quad: true, sinkOk: true });
  assert.equal(dest.channelCount, 4);
  assert.equal(dest.channelInterpretation, 'discrete');
  assert.deepEqual(conns.filter((c) => c[1] === 'merger'), [['split0', 'merger', 0, 0], ['split0', 'merger', 1, 1], ['split1', 'merger', 0, 2], ['split1', 'merger', 1, 3]]);
  assert.deepEqual(conns.filter((c) => c[0] === 'master' || c[0] === 'hp').map((c) => [c[0], c[1]]), [['master', 'split0'], ['hp', 'split1']]);
  conns.length = 0;
  dest.maxChannelCount = 2;
  assert.deepEqual(await e.applyRouting({ mode: 'quad' }), { outputs: 2, quad: false, sinkOk: true });
  assert.ok(!conns.some((c) => c[0] === 'hp'), JSON.stringify(conns));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ha 2 uscite/);
  // configurazione automatica della console: con 2 uscite nessun errore, chi chiama prova altro
  errors.length = 0;
  assert.deepEqual(await e.applyRouting({ mode: 'quad' }, { quiet: true }), { outputs: 2, quad: false, sinkOk: true });
  assert.equal(errors.length, 0);
});

test('scheda master scollegata: errore "uscita master non disponibile" e nessuna configurazione a 4 uscite sulla scheda sbagliata', async () => {
  const { e, conns, errors } = fakeEngine({ setSinkId: async () => { throw new Error('NotFoundError'); } });
  const res = await e.applyRouting({ mode: 'quad', masterDevice: 'console' });
  assert.deepEqual(res, { outputs: 4, quad: false, sinkOk: false });
  assert.deepEqual(conns.map((c) => [c[0], c[1]]), [['master', 'dest']]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Uscita master non disponibile \(NotFoundError\)/);
  assert.equal(e.sinkOk, false);
});

test('cambi di uscita uno alla volta: due richieste insieme non lasciano collegamenti di entrambe', async () => {
  let release;
  const { e, conns } = fakeEngine({ setSinkId: (id) => (id === 'lenta' ? new Promise((r) => { release = r; }) : Promise.resolve()) });
  const first = e.applyRouting({ mode: 'quad', masterDevice: 'lenta' });
  const second = e.applyRouting({ mode: 'single', masterDevice: 'veloce' });
  await new Promise((r) => setImmediate(r));
  assert.equal(conns.length, 0); // la seconda aspetta la prima
  release();
  await Promise.all([first, second]);
  assert.equal(e.routing.masterDevice, 'veloce');
  assert.deepEqual(conns.at(-1).slice(0, 2), ['master', 'dest']);
});

test('scheda che non risponde mai (setSinkId o play appesi): il cambio di uscita finisce lo stesso e non blocca i successivi', async () => {
  const { e, errors } = fakeEngine({ setSinkId: (id) => (id === 'appesa' ? new Promise(() => {}) : Promise.resolve()) });
  e.deviceTimeoutMs = 20;
  const res = await e.applyRouting({ mode: 'single', masterDevice: 'appesa' });
  assert.equal(res.sinkOk, false);
  assert.match(errors[0], /^Uscita master non disponibile \(.*non risponde/);
  // cuffia su un'uscita il cui play() non si risolve mai
  e.hpStreamDest = { stream: {} };
  e.hpAudio = { pause() {}, srcObject: null, setSinkId: async () => {}, play: () => new Promise(() => {}) };
  errors.length = 0;
  const hp = await e.applyRouting({ mode: 'single', masterDevice: '', headphoneDevice: 'cuffia' });
  assert.equal(hp.hpOk, false);
  assert.match(errors[0], /^Uscita cuffia non disponibile: .*non risponde/);
  // la coda non resta bloccata
  assert.equal((await e.applyRouting({ mode: 'single', masterDevice: '', headphoneDevice: '' })).sinkOk, true);
});
