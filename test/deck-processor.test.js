import test from 'node:test';
import assert from 'node:assert/strict';

// Ambiente minimo di AudioWorklet per eseguire il processore in Node.
const SR = 44100;
let Processor = null;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: (m) => (this.sent || (this.sent = [])).push(m), onmessage: null };
  }
};
globalThis.registerProcessor = (_name, cls) => {
  Processor = cls;
};
await import('../src/renderer/worklets/deck-processor.js');

function make(left) {
  const p = new Processor();
  p.port.onmessage({ data: { type: 'load', left, right: left } });
  return p;
}

function render(p, frames) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i += 128) {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    p.process([], [[l, r]]);
    L.set(l.subarray(0, Math.min(128, frames - i)), i);
    R.set(r.subarray(0, Math.min(128, frames - i)), i);
  }
  return L;
}

function sine(freq, seconds) {
  const out = new Float32Array(SR * seconds);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

// stima della frequenza contando gli attraversamenti dello zero
function freqOf(x) {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  return crossings / (x.length / SR);
}

test('play avanza alla velocità del tempo', () => {
  const p = make(sine(440, 3));
  p.port.onmessage({ data: { type: 'tempo', value: 1.1 } });
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  render(p, SR);
  assert.ok(Math.abs(p.pos - SR * 1.1) < 256, `pos ${p.pos}`);
});

test('senza keylock il pitch sale con il tempo', () => {
  const p = make(sine(440, 4));
  p.port.onmessage({ data: { type: 'tempo', value: 1.2 } });
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  const f = freqOf(render(p, SR).subarray(4096));
  assert.ok(Math.abs(f - 528) < 6, `freq ${f}`);
});

test('con keylock la tonalità resta invariata', () => {
  const p = make(sine(440, 4));
  p.port.onmessage({ data: { type: 'tempo', value: 1.2 } });
  p.port.onmessage({ data: { type: 'keylock', value: true } });
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  const f = freqOf(render(p, SR).subarray(8192));
  assert.ok(Math.abs(f - 440) < 8, `freq ${f}`);
});

test('il loop riporta la posizione all\'inizio', () => {
  const p = make(sine(100, 4));
  p.port.onmessage({ data: { type: 'loop', in: SR * 0.5, out: SR * 1, active: true } });
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  render(p, SR * 2);
  assert.ok(p.pos >= SR * 0.5 && p.pos < SR, `pos ${p.pos}`);
});

test('lo scratch all\'indietro fa tornare indietro la posizione', () => {
  const p = make(sine(100, 4));
  p.port.onmessage({ data: { type: 'seek', pos: SR * 2 } });
  p.port.onmessage({ data: { type: 'scratch', active: true, velocity: -1 } });
  render(p, SR / 2);
  assert.ok(p.pos < SR * 2 - SR * 0.3, `pos ${p.pos}`);
});

test('fine brano: si ferma e notifica ended', () => {
  const p = make(sine(100, 0.2));
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  render(p, SR / 2);
  assert.equal(p.playing, false);
  assert.ok(p.sent.some((m) => m.type === 'ended'));
});

test('la frenata rallenta gradualmente', () => {
  const p = make(sine(100, 4));
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  render(p, 1024);
  p.port.onmessage({ data: { type: 'pause', brakeTime: 1 } });
  render(p, SR / 2);
  assert.ok(p.motor > 0.3 && p.motor < 0.7, `motor ${p.motor}`);
});

test('swap cambia versione del brano senza fermarlo né spostarlo (mashup)', () => {
  const p = make(sine(100, 4));
  p.port.onmessage({ data: { type: 'loop', in: SR * 2, out: SR * 3, active: true } });
  p.port.onmessage({ data: { type: 'play', startTime: 0 } });
  render(p, SR);
  const pos = p.pos;
  p.port.onmessage({ data: { type: 'swap', left: sine(300, 4), right: sine(300, 4) } });
  assert.equal(p.pos, pos);
  assert.equal(p.playing, true);
  assert.equal(p.loopActive, true);
  const out = render(p, SR / 2);
  assert.ok(Math.abs(freqOf(out) - 300) < 10, `frequenza ${freqOf(out)}`);
});
