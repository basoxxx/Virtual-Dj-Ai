import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBpm, detectKey, computeWaveform, loudness, shiftKey, parseKey, camelot, fft, formatTime,
} from '../src/renderer/js/dsp/analysis.js';

const SR = 44100;

function kickTrack(bpm, seconds, offset = 0) {
  const out = new Float32Array(SR * seconds);
  const beat = 60 / bpm;
  for (let t = offset; t < seconds; t += beat) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.15 && start + i < out.length; i++) {
      const env = Math.exp(-i / (SR * 0.03));
      const freq = 50 + 80 * Math.exp(-i / (SR * 0.01));
      out[start + i] += 0.9 * env * Math.sin((2 * Math.PI * freq * i) / SR);
    }
  }
  // hi-hat in levare e un po' di rumore
  let seed = 1;
  for (let t = offset + beat / 2; t < seconds; t += beat) {
    const start = Math.round(t * SR);
    for (let i = 0; i < SR * 0.03 && start + i < out.length; i++) {
      seed = (seed * 16807) % 2147483647;
      out[start + i] += 0.15 * ((seed / 2147483647) * 2 - 1) * Math.exp(-i / (SR * 0.008));
    }
  }
  return out;
}

for (const bpm of [95, 122, 128, 140, 174]) {
  test(`detectBpm riconosce ${bpm} BPM`, () => {
    const res = detectBpm(kickTrack(bpm, 30, 0.2), SR);
    assert.ok(Math.abs(res.bpm - bpm) < 0.6, `atteso ${bpm}, ottenuto ${res.bpm}`);
  });
}

test('detectBpm trova la fase della prima battuta', () => {
  const bpm = 125;
  const offset = 0.31;
  const res = detectBpm(kickTrack(bpm, 30, offset), SR);
  const beat = 60 / bpm;
  let diff = Math.abs(res.offset - offset) % beat;
  diff = Math.min(diff, beat - diff);
  assert.ok(diff < 0.03, `offset ${res.offset} vs ${offset}`);
});

function chordTrack(freqs, seconds) {
  const out = new Float32Array(SR * seconds);
  for (const f of freqs) {
    for (let i = 0; i < out.length; i++) out[i] += 0.2 * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return out;
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

test('detectKey riconosce La minore', () => {
  // A C E con enfasi sulla tonica
  const res = detectKey(chordTrack([hz(57), hz(69), hz(60), hz(64), hz(45)], 8), SR);
  assert.equal(res.key, 'Am');
  assert.equal(res.camelot, '8A');
});

test('detectKey riconosce Do maggiore', () => {
  const res = detectKey(chordTrack([hz(48), hz(60), hz(64), hz(67), hz(72)], 8), SR);
  assert.equal(res.key, 'C');
  assert.equal(res.camelot, '8B');
});

test('shiftKey e parseKey', () => {
  assert.equal(shiftKey('Am', 2), 'Bm');
  assert.equal(shiftKey('B', 1), 'C');
  assert.deepEqual(parseKey('F#m'), { tonic: 6, minor: true });
  assert.equal(camelot(9, true), '8A');
});

test('computeWaveform normalizza e produce bande', () => {
  const wf = computeWaveform(kickTrack(128, 5), SR, 100);
  assert.ok(wf.length >= 490 && wf.length <= 510);
  let max = 0;
  for (const v of wf.peak) max = Math.max(max, v);
  assert.ok(Math.abs(max - 1) < 1e-6);
});

test('loudness calcola il guadagno di normalizzazione', () => {
  const quiet = chordTrack([440], 2).map((x) => x * 0.1);
  const l = loudness(quiet);
  assert.ok(l.gainDb > 0);
});

test('fft di una sinusoide ha picco nel bin giusto', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 32 * i) / n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.equal(best, 32);
});

test('formatTime', () => {
  assert.equal(formatTime(75.5), '01:15.5');
  assert.equal(formatTime(-1, false), '00:00');
});

test('detectBpm: cassa a 100 BPM con accordo tenuto (regressione)', () => {
  const kick = kickTrack(100, 40, 0.05);
  const tones = chordTrack([hz(62), hz(65), hz(69), hz(74)], 40);
  const mix = kick.map((v, i) => v * 0.4 + tones[i] * 0.2);
  const res = detectBpm(mix, SR);
  assert.ok(Math.abs(res.bpm - 100) < 0.6, `ottenuto ${res.bpm}`);
});

test('detectBpm: arpeggio con accenti ogni 3 sedicesimi non inganna (regressione 84 vs 126)', () => {
  const bpm = 126;
  const secs = 60;
  const kick = kickTrack(bpm, secs, 0.05);
  const step = 60 / bpm / 4;
  for (let n = 0; n * step < secs; n++) {
    const s0 = Math.round((0.05 + n * step) * SR);
    const amp = n % 3 === 0 ? 0.5 : 0.15;
    for (let i = 0; i < SR * 0.08 && s0 + i < kick.length; i++) {
      kick[s0 + i] += amp * Math.sin((2 * Math.PI * 880 * i) / SR) * Math.exp(-i / (SR * 0.02));
    }
  }
  const res = detectBpm(kick, SR);
  assert.ok(Math.abs(res.bpm - bpm) < 0.6, `ottenuto ${res.bpm}`);
});
