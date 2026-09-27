// Sampler a 8 pad con suoni sintetizzati inclusi e caricamento di campioni personali.
import { api } from '../api.js';

const SR = 44100;

function render(seconds, fn) {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  fn(ctx);
  return ctx.startRendering();
}

function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

const BUILTIN = [
  {
    name: 'Air Horn',
    color: '#ff453a',
    make: () => render(1.6, (ctx) => {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, 0);
      out.gain.linearRampToValueAtTime(0.35, 0.02);
      out.gain.setValueAtTime(0.35, 0.22);
      out.gain.linearRampToValueAtTime(0.05, 0.26);
      out.gain.linearRampToValueAtTime(0.35, 0.3);
      out.gain.setValueAtTime(0.35, 1.3);
      out.gain.linearRampToValueAtTime(0, 1.6);
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 3);
      shaper.curve = curve;
      shaper.connect(out).connect(ctx.destination);
      for (const f of [311, 370, 466, 622]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f * 0.97, 0);
        o.frequency.linearRampToValueAtTime(f, 0.05);
        o.connect(shaper);
        o.start();
      }
    }),
  },
  {
    name: 'Sirena',
    color: '#ff9f0a',
    make: () => render(2.5, (ctx) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.2;
      const depth = ctx.createGain();
      depth.gain.value = 350;
      o.frequency.value = 900;
      lfo.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18, 0);
      g.gain.setValueAtTime(0.18, 2.2);
      g.gain.linearRampToValueAtTime(0, 2.5);
      const lp = ctx.createBiquadFilter();
      lp.frequency.value = 3000;
      o.connect(lp).connect(g).connect(ctx.destination);
      o.start();
      lfo.start();
    }),
  },
  {
    name: 'Kick',
    color: '#64d2ff',
    make: () => render(0.6, (ctx) => {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, 0);
      o.frequency.exponentialRampToValueAtTime(42, 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1, 0);
      g.gain.exponentialRampToValueAtTime(0.001, 0.55);
      o.connect(g).connect(ctx.destination);
      o.start();
    }),
  },
  {
    name: 'Clap',
    color: '#bf5af2',
    make: () => render(0.5, (ctx) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.5);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      for (const t of [0, 0.012, 0.024]) {
        g.gain.setValueAtTime(0.9, t);
        g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
      }
      g.gain.setValueAtTime(0.9, 0.036);
      g.gain.exponentialRampToValueAtTime(0.001, 0.45);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    }),
  },
  {
    name: 'Laser',
    color: '#30d158',
    make: () => render(0.7, (ctx) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(3000, 0);
      o.frequency.exponentialRampToValueAtTime(80, 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, 0);
      g.gain.exponentialRampToValueAtTime(0.001, 0.68);
      o.connect(g).connect(ctx.destination);
      o.start();
    }),
  },
  {
    name: 'Riser',
    color: '#ffd60a',
    make: () => render(4, (ctx) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 3;
      bp.frequency.setValueAtTime(300, 0);
      bp.frequency.exponentialRampToValueAtTime(9000, 3.9);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.02, 0);
      g.gain.exponentialRampToValueAtTime(0.6, 3.8);
      g.gain.linearRampToValueAtTime(0, 4);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    }),
  },
  {
    name: 'Rewind',
    color: '#ff375f',
    make: () => render(1.2, (ctx) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 1.2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6;
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(6, 0);
      lfo.frequency.linearRampToValueAtTime(18, 1.2);
      const depth = ctx.createGain();
      depth.gain.value = 900;
      bp.frequency.value = 1400;
      lfo.connect(depth).connect(bp.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, 0);
      g.gain.linearRampToValueAtTime(0, 1.2);
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
      lfo.start();
    }),
  },
  {
    name: 'Snare Roll',
    color: '#0a84ff',
    make: () => render(2, (ctx) => {
      const noise = noiseBuffer(ctx, 2);
      let t = 0;
      let step = 0.25;
      while (t < 1.9) {
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.1 + (t / 2) * 0.6, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        src.connect(hp).connect(g).connect(ctx.destination);
        src.start(t, Math.random(), 0.15);
        t += step;
        step = Math.max(0.03, step * 0.86);
      }
    }),
  },
];

export class Sampler extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.ctx = engine.ctx;
    this.output = this.ctx.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(engine.samplerBus);
    this.pads = BUILTIN.map((b) => ({ name: b.name, color: b.color, buffer: null, source: null, loop: false, path: null }));
  }

  async init(saved = []) {
    await Promise.all(BUILTIN.map(async (b, i) => {
      this.pads[i].buffer = await b.make();
    }));
    for (const [i, s] of saved.entries()) {
      if (s && s.path) await this.loadFile(i, s.path, s.name).catch(() => {});
      if (s && s.loop) this.pads[i].loop = true;
    }
  }

  async loadFile(i, path, name) {
    const bytes = await api.readFile(path);
    const buf = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pad = this.pads[i];
    pad.buffer = buf;
    pad.path = path;
    pad.name = name || path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/#.*$/, '');
    this.dispatchEvent(new CustomEvent('change'));
  }

  resetPad(i) {
    const b = BUILTIN[i];
    const pad = this.pads[i];
    pad.name = b.name;
    pad.path = null;
    b.make().then((buf) => {
      pad.buffer = buf;
      this.dispatchEvent(new CustomEvent('change'));
    });
  }

  trigger(i) {
    const pad = this.pads[i];
    if (!pad || !pad.buffer) return;
    this.engine.resume();
    if (pad.source) {
      this.stop(i);
      if (pad.loop) return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = pad.buffer;
    src.loop = pad.loop;
    src.connect(this.output);
    src.onended = () => {
      if (pad.source === src) {
        pad.source = null;
        this.dispatchEvent(new CustomEvent('change'));
      }
    };
    src.start();
    pad.source = src;
    this.dispatchEvent(new CustomEvent('change'));
  }

  stop(i) {
    const pad = this.pads[i];
    if (pad.source) {
      try {
        pad.source.stop();
      } catch {
        // già fermo
      }
      pad.source = null;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  stopAll() {
    this.pads.forEach((_p, i) => this.stop(i));
  }

  setVolume(v) {
    this.output.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01);
  }

  serialize() {
    return this.pads.map((p) => ({ path: p.path, name: p.path ? p.name : null, loop: p.loop }));
  }
}
