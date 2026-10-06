// Comandi del deck pensati per le console (jog a impulsi, encoder del loop, roll, slicer), provati su un
// deck finto senza Web Audio: il worklet è sostituito da una posizione che segue i seek.
import test from 'node:test';
import assert from 'node:assert/strict';

let now = 0;
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
const { Deck } = await import('../src/renderer/js/audio/deck.js');
const P = Deck.prototype;

function fakeDeck(over = {}) {
  const posts = [];
  const d = Object.create(P);
  Object.assign(d, {
    track: {}, duration: 300, sampleRate: 44100, lastPos: 0, lastVel: 0, lastT: 0, playing: false, scratching: false,
    bpm: 120, gridOffset: 0, quantize: true, slip: false, slipAnchor: null, vinyl: true, pitch: 0,
    loop: { in: 0, out: 0, active: false, beats: 0 }, loopBeats: 4, rolling: 0, slicing: 0, jogWin: [], jogTimer: null, bendTimer: null,
    ctx: { currentTime: 0 }, posts, emitted: [],
  }, over);
  d.post = (m) => posts.push(m);
  d.emit = (t) => d.emitted.push(t);
  Object.defineProperty(d, 'position', { get() { return this.lastPos / this.sampleRate; }, configurable: true });
  return d;
}

const at = (d, sec) => { d.lastPos = sec * d.sampleRate; };

test('jog a impulsi da fermo: ghiera lenta, piatto più veloce', () => {
  const d = fakeDeck();
  at(d, 10);
  for (let i = 0; i < 720; i++) d.jogTicks(1, 720, false);
  assert.ok(Math.abs(d.position - 11.8) < 1e-6, `ghiera: ${d.position}`);
  for (let i = 0; i < 720; i++) d.jogTicks(1, 720, true);
  assert.ok(Math.abs(d.position - 17.2) < 1e-6, `piatto: ${d.position}`);
});

test('scratch: la velocità segue la mano (400 tick/s su 720 tick/giro = velocità normale)', () => {
  const d = fakeDeck({ scratching: true });
  at(d, 30);
  const vels = [];
  d.jogScratch = (v) => vels.push(v);
  for (let i = 0; i < 20; i++) { now += 2.5; d.jogTicks(1, 720, true); }
  assert.ok(Math.abs(vels.at(-1) - 1) < 0.06, `velocità normale: ${vels.at(-1)}`);
  vels.length = 0;
  for (let i = 0; i < 20; i++) { now += 10; d.jogTicks(1, 720, true); }
  assert.ok(Math.abs(vels.at(-1) - 0.25) < 0.06, `un quarto: ${vels.at(-1)}`);
  vels.length = 0;
  for (let i = 0; i < 20; i++) { now += 5; d.jogTicks(-1, 720, true); }
  assert.ok(Math.abs(vels.at(-1) + 0.5) < 0.06, `indietro a metà: ${vels.at(-1)}`);
  clearTimeout(d.jogTimer);
});

test('encoder del loop: fuori dal loop sceglie la dimensione, dentro dimezza/raddoppia', () => {
  const d = fakeDeck({ playing: true });
  at(d, 5.1);
  d.loopSizeStep(-1);
  d.loopSizeStep(-1);
  assert.equal(d.loopBeats, 1);
  d.toggleAutoLoop();
  assert.equal(d.loop.active, true);
  assert.equal(d.loop.in, 5);
  assert.ok(Math.abs(d.loop.out - 5.5) < 1e-9);
  d.loopSizeStep(1);
  assert.ok(Math.abs(d.loop.out - 6) < 1e-9);
  d.toggleAutoLoop();
  assert.equal(d.loop.active, false);
});

test('loop roll: al rilascio il brano riprende dove sarebbe arrivato', () => {
  const d = fakeDeck({ playing: true });
  at(d, 20.3);
  d.roll(0.25, true);
  assert.equal(d.rolling, 0.25);
  assert.ok(Math.abs(d.loop.in - 20.25) < 1e-9 && Math.abs(d.loop.out - 20.375) < 1e-9, `roll ${d.loop.in}-${d.loop.out}`);
  d.ctx.currentTime = 2;
  d.roll(0.25, false);
  assert.equal(d.loop.active, false);
  assert.equal(d.slipAnchor, null);
  assert.ok(Math.abs(d.position - 22.3) < 1e-6, `ripresa ${d.position}`);
});

test('slicer: fetta della frase da 8 battute, poi ritorno', () => {
  const d = fakeDeck({ playing: true });
  at(d, 9.2); // battuta 18 (frase da 8 battute = 4 s: 8..12)
  d.ctx.currentTime = 0;
  d.slice(3, true);
  assert.ok(Math.abs(d.position - 9) < 1e-9, `fetta 3: ${d.position}`);
  d.ctx.currentTime = 1;
  d.slice(3, false);
  assert.ok(Math.abs(d.position - 10.2) < 1e-6, `ripresa ${d.position}`);
});

test('LOOP IN tenuto premuto: loop di 4 battute dal punto di IN', () => {
  const d = fakeDeck({ playing: true });
  at(d, 3);
  d.loopIn();
  at(d, 3.6);
  d.loopFromIn(4);
  assert.equal(d.loop.active, true);
  assert.equal(d.loop.in, 3);
  assert.equal(d.loop.out, 5);
});
