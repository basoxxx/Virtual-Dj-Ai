// Hot cue e tonalità del deck (TonePlay, key sync) su un deck finto senza Web Audio.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { Deck } = await import('../src/renderer/js/audio/deck.js');

function fakeDeck(over = {}) {
  const d = Object.create(Deck.prototype);
  Object.assign(d, {
    track: {}, duration: 300, sampleRate: 44100, lastPos: 0, playing: false, bpm: 120, gridOffset: 0, quantize: true, pitch: 0, pitchRange: 8,
    keylock: true, key: 'Am', keyShift: 0, hotcues: new Array(8).fill(null), hotcuePlays: true, cuePoint: 0, lastHotcue: -1,
    loop: { in: 0, out: 0, active: false, beats: 0 }, ctx: { currentTime: 0 }, posts: [],
  }, over);
  d.post = (m) => d.posts.push(m);
  d.emit = () => {};
  return d;
}

test('hot cue a deck fermo: salta e parte; con l\'opzione spenta resta fermo', () => {
  const d = fakeDeck();
  d.hotcues[0] = 12;
  let played = 0;
  d.play = () => {
    played++;
  };
  d.hotcue(0);
  assert.equal(played, 1);
  assert.equal(d.cuePoint, 12);
  d.hotcuePlays = false;
  d.hotcue(0);
  assert.equal(played, 1);
});

test('tonalità: setKeyShift arrotonda e limita a ±12, displayKey la mostra, keySync sceglie il salto più piccolo', () => {
  const a = fakeDeck();
  a.setKeyShift(14.4);
  assert.equal(a.keyShift, 12);
  assert.deepEqual(a.posts.at(-1), { type: 'key', value: 2 });
  a.setKeyShift(2);
  assert.equal(a.displayKey, 'Bm');
  const b = fakeDeck({ key: 'Bm' });
  a.setKeyShift(0);
  assert.equal(a.keySync(b), true);
  assert.equal(a.keyShift, 2);
  // senza keylock la tonalità mostrata segue anche il tempo (+6% ≈ +1 semitono)
  const c = fakeDeck({ keylock: false, pitch: 5.95 });
  assert.equal(c.displayKey, 'Bbm');
});
