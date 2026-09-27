import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiManager } from '../src/renderer/js/midi.js';
import { AudioEngine } from '../src/renderer/js/audio/engine.js';
import { harmonicMatch, camelotOf } from '../src/renderer/js/dsp/analysis.js';
import { encodeWav, encodeWavFromInt16 } from '../src/renderer/js/dsp/wav.js';

test('MidiManager.parse: note on/off, CC, pitch bend', () => {
  assert.deepEqual(MidiManager.parse([0x91, 36, 127]), { key: 'note:1:36', value: 1, raw: 127, isNote: true });
  assert.equal(MidiManager.parse([0x81, 36, 0]).value, 0);
  assert.equal(MidiManager.parse([0x90, 36, 0]).value, 0);
  assert.equal(MidiManager.parse([0xb0, 7, 127]).key, 'cc:0:7');
  assert.equal(MidiManager.parse([0xe0, 0x7f, 0x7f]).value, 1);
  assert.equal(MidiManager.parse([0xf8]), null);
});

test('MidiManager: learn e dispatch verso le azioni', () => {
  const calls = [];
  const actions = new Map([
    ['play', { label: 'Play', kind: 'button', run: (on) => calls.push(['play', on]) }],
    ['vol', { label: 'Vol', kind: 'knob', run: (v) => calls.push(['vol', v]) }],
    ['jog', { label: 'Jog', kind: 'jog', run: (d) => calls.push(['jog', d]) }],
  ]);
  const m = new MidiManager(actions);
  m.learn('play');
  m.onMessage([0x90, 10, 0]); // il note-off non viene appreso
  m.onMessage([0x90, 10, 100]);
  m.learn('vol');
  m.onMessage([0xb0, 1, 0]);
  m.learn('jog');
  m.onMessage([0xb0, 2, 1]); // encoder "twos" (1 / 127)
  calls.length = 0;
  m.onMessage([0x90, 10, 127]);
  m.onMessage([0xb0, 1, 127]);
  m.onMessage([0xb0, 2, 3]);
  m.onMessage([0xb0, 2, 126]);
  assert.deepEqual(calls, [['play', true], ['vol', 1], ['jog', 3], ['jog', -2]]);
  assert.equal(m.keyFor('vol'), 'cc:0:1');
  m.clear('vol');
  assert.equal(m.keyFor('vol'), '');
});

test('curve del crossfader', () => {
  for (const curve of ['smooth', 'linear', 'cut']) {
    const left = AudioEngine.crossfaderGains(-1, curve);
    const right = AudioEngine.crossfaderGains(1, curve);
    assert.ok(Math.abs(left.a - 1) < 1e-9 && Math.abs(left.b) < 1e-9, curve);
    assert.ok(Math.abs(right.b - 1) < 1e-9 && Math.abs(right.a) < 1e-9, curve);
  }
  const mid = AudioEngine.crossfaderGains(0, 'smooth');
  assert.ok(mid.a > 0.99 && mid.b > 0.99);
  const cut = AudioEngine.crossfaderGains(-0.8, 'cut');
  assert.equal(cut.a, 1);
  assert.equal(cut.b, 1);
});

test('compatibilità armonica Camelot', () => {
  assert.equal(camelotOf('Am'), '8A');
  assert.ok(harmonicMatch('Am', 'C')); // 8A - 8B
  assert.ok(harmonicMatch('Am', 'Em')); // 8A - 9A
  assert.ok(harmonicMatch('Am', 'Dm')); // 8A - 7A
  assert.ok(harmonicMatch('Abm', 'Bm') === false);
  assert.ok(harmonicMatch('B', 'E')); // 1B - 12B
  assert.ok(!harmonicMatch('Am', 'F#'));
  assert.ok(!harmonicMatch('', 'Am'));
});

test('encodeWav produce un header valido', () => {
  const l = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWav([l, l], 44100);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(40, true), 16);
  assert.equal(v.getInt16(44 + 2 * 2, true), Math.trunc(0.5 * 0x7fff));
  const joined = encodeWavFromInt16([new Int16Array([1, 2]), new Int16Array([3, 4])], 48000, 2);
  assert.equal(joined.byteLength, 44 + 8);
});
