import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bpmScore, keyScore, tempoRatio, rankCandidates, buildSet, planTransition, transitionState, targetEnergy,
} from '../src/renderer/js/ai/selector.js';
import { trackStructure, energyLevel, analyzeTrack } from '../src/renderer/js/dsp/analysis.js';


const T = (id, bpm, key, energy, extra = {}) => ({ id, title: `T${id}`, artist: `A${id}`, path: `/m/${id}.mp3`, bpm, key, energy, ...extra });

test('tempoRatio gestisce metà e doppio tempo', () => {
  assert.equal(tempoRatio(128, 128), 1);
  assert.ok(Math.abs(tempoRatio(128, 64) - 1) < 1e-9);
  assert.ok(Math.abs(tempoRatio(87, 174) - 1) < 1e-9);
});

test('bpmScore premia i tempi vicini', () => {
  assert.equal(bpmScore(128, 128), 1);
  assert.ok(bpmScore(128, 126) > bpmScore(128, 120));
  assert.equal(bpmScore(128, 100), 0);
});

test('keyScore segue la ruota Camelot', () => {
  assert.equal(keyScore('Am', 'Am'), 1);
  assert.ok(keyScore('Am', 'C') >= 0.9); // relativa
  assert.ok(keyScore('Am', 'Em') >= 0.9); // 8A → 9A
  assert.ok(keyScore('Am', 'F#m') < 0.5); // 8A → 11A
  assert.equal(keyScore('Am', 'Bbm'), 0.5); // +1 semitono (energy boost)
});

test('rankCandidates sceglie il brano armonico e con BPM vicino', () => {
  const cur = T(0, 124, 'Am', 6);
  const pool = [T(1, 140, 'F#', 6), T(2, 125, 'Em', 6), T(3, 124, 'Bbm', 6), T(4, 98, 'Am', 6)];
  const ranked = rankCandidates(cur, pool, { random: () => 0.5 });
  assert.equal(ranked[0].track.id, 2);
  assert.ok(ranked[0].reasons.some((r) => r.includes('BPM')));
});

test('la strategia "rise" preferisce energia più alta', () => {
  const cur = T(0, 124, 'Am', 6);
  const pool = [T(1, 124, 'Am', 4), T(2, 124, 'Am', 8)];
  const ranked = rankCandidates(cur, pool, { strategy: 'rise', step: 0, random: () => 0 });
  assert.equal(ranked[0].track.id, 2);
  assert.ok(targetEnergy('chill', 8, 0) <= 5);
});

test('buildSet non ripete brani e rispetta la lunghezza', () => {
  const pool = Array.from({ length: 30 }, (_, i) => T(i, 120 + (i % 8), ['Am', 'C', 'Em', 'G', 'Dm'][i % 5], 3 + (i % 7)));
  const set = buildSet(pool, { length: 12, random: () => 0.3 });
  assert.equal(set.length, 12);
  assert.equal(new Set(set.map((t) => t.id)).size, 12);
});

test('planTransition sceglie la transizione adatta', () => {
  assert.equal(planTransition(T(0, 128, 'Am', 5), T(1, 90, 'Am', 5)).type, 'echo');
  assert.equal(planTransition(T(0, 128, 'Am', 5), T(1, 90, 'Am', 5)).sync, false);
  assert.equal(planTransition(T(0, 128, 'Am', 5), T(1, 128, 'F#m', 5)).type, 'filter');
  assert.equal(planTransition(T(0, 128, 'Am', 5), T(1, 127, 'Em', 8)).type, 'bassswap');
  const manual = planTransition(T(0, 128, 'Am', 5), T(1, 127, 'Em', 8), { style: 'fade', bars: 32 });
  assert.equal(manual.type, 'fade');
  assert.equal(manual.bars, 32);
});

test('transitionState: il bass swap scambia i bassi a metà', () => {
  const s0 = transitionState('bassswap', 0.1);
  assert.equal(s0.inLow, -1);
  assert.equal(s0.outLow, 0);
  const s1 = transitionState('bassswap', 0.7);
  assert.equal(s1.inLow, 0);
  assert.equal(s1.outLow, -1);
  assert.equal(transitionState('fade', 0).xf, 0);
  assert.equal(transitionState('fade', 1).xf, 1);
  assert.equal(transitionState('echo', 0.9).outPlayer, 0);
  assert.equal(transitionState('echo', 0.9).echo, 1);
});

test('trackStructure trova intro, outro e punto di mix sulle frasi', () => {
  const SR = 8000;
  const bpm = 120;
  const bar = 2; // secondi
  const bars = 64;
  const mono = new Float32Array(SR * bar * bars);
  for (let i = 0; i < mono.length; i++) {
    const b = Math.floor(i / (SR * bar));
    const amp = b < 8 || b >= 56 ? 0.1 : 0.8; // intro e outro quieti
    mono[i] = amp * Math.sin(i * 0.3);
  }
  const s = trackStructure(mono, SR, bpm, 0);
  assert.equal(s.introEnd, 8 * bar);
  assert.equal(s.outroStart, 56 * bar);
  assert.ok(s.mixOut <= 56 * bar && s.mixOut >= 32 * bar);
  assert.equal((s.mixOut / bar) % 8, 0);
});

test('energyLevel è compreso fra 1 e 10', () => {
  assert.equal(energyLevel(-40, 0), 1);
  assert.equal(energyLevel(-6, 1), 10);
});

test('analyzeTrack senza forma d\'onda usa BPM noti', () => {
  const SR = 8000;
  const mono = new Float32Array(SR * 30).map((_, i) => 0.3 * Math.sin(i * 0.2));
  const res = analyzeTrack([mono], SR, { bpm: false, key: false, waveform: false, knownBpm: 120, knownOffset: 0 });
  assert.equal(res.waveform, undefined);
  assert.ok(res.structure && res.structure.mixOut > 0);
  assert.ok(res.energy >= 1 && res.energy <= 10);
});
