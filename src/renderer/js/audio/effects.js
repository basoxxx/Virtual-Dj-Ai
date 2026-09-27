// Slot effetti per deck: Echo, Reverb, Flanger, Phaser, Filtro LFO, Bitcrusher, Trance gate.
// Ogni slot ha on/off, dry/wet e un parametro; i tempi seguono il BPM del deck.

export const EFFECTS = [
  { id: 'none', name: '—', param: '' },
  { id: 'echo', name: 'Echo', param: 'Feedback' },
  { id: 'reverb', name: 'Reverb', param: 'Durata' },
  { id: 'flanger', name: 'Flanger', param: 'Profondità' },
  { id: 'phaser', name: 'Phaser', param: 'Velocità' },
  { id: 'wah', name: 'Filtro LFO', param: 'Risonanza' },
  { id: 'crush', name: 'Bitcrusher', param: 'Bit' },
  { id: 'gate', name: 'Trance Gate', param: 'Profondità' },
  { id: 'beatdelay', name: 'Ping-pong', param: 'Tempo' },
];

function impulseResponse(ctx, seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  return buf;
}

function crushCurve(bits) {
  const n = 4096;
  const curve = new Float32Array(n);
  const steps = 2 ** bits;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

export class FxSlot {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.type = 'none';
    this.on = false;
    this.mix = 0.5;
    this.param = 0.5;
    this.bpm = 120;
    this.nodes = [];
    this.fx = null;
    this.applyMix();
  }

  setBpm(bpm) {
    this.bpm = bpm > 0 ? bpm : 120;
    if (this.fx && this.fx.onBpm) this.fx.onBpm();
  }

  beat(fraction) {
    return (60 / this.bpm) * fraction;
  }

  setType(type) {
    if (type === this.type) return;
    this.teardown();
    this.type = type;
    if (type !== 'none') this.fx = this.build(type);
    this.applyParam();
    this.applyMix();
  }

  setOn(on) {
    this.on = on;
    this.applyMix();
  }

  setMix(v) {
    this.mix = v;
    this.applyMix();
  }

  setParam(v) {
    this.param = v;
    this.applyParam();
  }

  applyMix() {
    const t = this.ctx.currentTime;
    const active = this.on && this.fx;
    // gli effetti "insert" sostituiscono il segnale, quelli "send" si sommano
    const insert = this.fx && this.fx.insert;
    const wet = active ? this.mix : 0;
    const dry = active && insert ? 1 - this.mix : 1;
    this.wet.gain.setTargetAtTime(wet, t, 0.01);
    this.dry.gain.setTargetAtTime(dry, t, 0.01);
  }

  applyParam() {
    if (this.fx && this.fx.onParam) this.fx.onParam(this.param);
  }

  track(...nodes) {
    this.nodes.push(...nodes);
    return nodes[0];
  }

  teardown() {
    for (const n of this.nodes) {
      try {
        if (n.stop) n.stop();
      } catch {
        // già fermo
      }
      try {
        n.disconnect();
      } catch {
        // già scollegato
      }
    }
    this.nodes = [];
    this.fx = null;
    this.input.disconnect();
    this.input.connect(this.dry);
  }

  lfo(freq, depth, target) {
    const osc = this.track(this.ctx.createOscillator());
    const gain = this.track(this.ctx.createGain());
    osc.frequency.value = freq;
    gain.gain.value = depth;
    osc.connect(gain).connect(target);
    osc.start();
    return { osc, gain };
  }

  build(type) {
    const ctx = this.ctx;
    switch (type) {
      case 'echo': {
        const delay = this.track(ctx.createDelay(4));
        const fb = this.track(ctx.createGain());
        const hp = this.track(ctx.createBiquadFilter());
        hp.type = 'highpass';
        hp.frequency.value = 300;
        this.input.connect(delay);
        delay.connect(hp).connect(fb).connect(delay);
        delay.connect(this.wet);
        const fx = {
          onBpm: () => delay.delayTime.setTargetAtTime(this.beat(0.75), ctx.currentTime, 0.02),
          onParam: (v) => fb.gain.setTargetAtTime(v * 0.9, ctx.currentTime, 0.02),
        };
        fx.onBpm();
        return fx;
      }
      case 'beatdelay': {
        const merger = this.track(ctx.createChannelMerger(2));
        const dl = this.track(ctx.createDelay(4));
        const dr = this.track(ctx.createDelay(4));
        const fbl = this.track(ctx.createGain());
        const fbr = this.track(ctx.createGain());
        const mono = this.track(ctx.createGain());
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        this.input.connect(mono).connect(dl);
        dl.connect(fbl).connect(dr);
        dr.connect(fbr).connect(dl);
        dl.connect(merger, 0, 0);
        dr.connect(merger, 0, 1);
        merger.connect(this.wet);
        fbl.gain.value = 0.55;
        fbr.gain.value = 0.55;
        const fractions = [0.25, 0.5, 0.75, 1];
        const fx = {
          fraction: 0.5,
          onBpm: () => {
            dl.delayTime.setTargetAtTime(this.beat(fx.fraction), ctx.currentTime, 0.02);
            dr.delayTime.setTargetAtTime(this.beat(fx.fraction), ctx.currentTime, 0.02);
          },
          onParam: (v) => {
            fx.fraction = fractions[Math.min(3, Math.floor(v * 4))];
            fx.onBpm();
          },
        };
        return fx;
      }
      case 'reverb': {
        const conv = this.track(ctx.createConvolver());
        const pre = this.track(ctx.createBiquadFilter());
        pre.type = 'highpass';
        pre.frequency.value = 200;
        this.input.connect(pre).connect(conv).connect(this.wet);
        let timer = null;
        let current = -1;
        return {
          onParam: (v) => {
            const secs = 0.6 + v * 5;
            if (Math.abs(secs - current) < 0.2) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              current = secs;
              conv.buffer = impulseResponse(ctx, secs);
            }, current < 0 ? 0 : 120);
          },
        };
      }
      case 'flanger': {
        const delay = this.track(ctx.createDelay(0.05));
        const fb = this.track(ctx.createGain());
        delay.delayTime.value = 0.004;
        fb.gain.value = 0.6;
        this.input.connect(delay);
        delay.connect(fb).connect(delay);
        delay.connect(this.wet);
        const { gain, osc } = this.lfo(0.25, 0.0025, delay.delayTime);
        return {
          insert: true,
          onBpm: () => osc.frequency.setTargetAtTime(this.bpm / 60 / 16, ctx.currentTime, 0.05),
          onParam: (v) => {
            gain.gain.setTargetAtTime(0.0005 + v * 0.0035, ctx.currentTime, 0.02);
            fb.gain.setTargetAtTime(0.3 + v * 0.55, ctx.currentTime, 0.02);
          },
        };
      }
      case 'phaser': {
        let node = this.input;
        const filters = [];
        for (let i = 0; i < 6; i++) {
          const ap = this.track(ctx.createBiquadFilter());
          ap.type = 'allpass';
          ap.frequency.value = 1000;
          ap.Q.value = 0.7;
          node.connect(ap);
          node = ap;
          filters.push(ap);
        }
        node.connect(this.wet);
        const osc = this.track(ctx.createOscillator());
        osc.frequency.value = 0.4;
        for (const f of filters) {
          const g = this.track(ctx.createGain());
          g.gain.value = 800;
          osc.connect(g).connect(f.frequency);
        }
        osc.start();
        return {
          insert: true,
          onParam: (v) => osc.frequency.setTargetAtTime(0.05 + v * 3, ctx.currentTime, 0.05),
        };
      }
      case 'wah': {
        const bp = this.track(ctx.createBiquadFilter());
        bp.type = 'bandpass';
        bp.frequency.value = 1200;
        this.input.connect(bp).connect(this.wet);
        const { osc } = this.lfo(1, 1000, bp.frequency);
        const fx = {
          insert: true,
          onBpm: () => osc.frequency.setTargetAtTime(this.bpm / 60 / 2, ctx.currentTime, 0.05),
          onParam: (v) => bp.Q.setTargetAtTime(0.5 + v * 12, ctx.currentTime, 0.02),
        };
        fx.onBpm();
        return fx;
      }
      case 'crush': {
        const shaper = this.track(ctx.createWaveShaper());
        this.input.connect(shaper).connect(this.wet);
        return {
          insert: true,
          onParam: (v) => {
            shaper.curve = crushCurve(Math.round(12 - v * 10));
          },
        };
      }
      case 'gate': {
        const vca = this.track(ctx.createGain());
        vca.gain.value = 0;
        const osc = this.track(ctx.createOscillator());
        osc.type = 'square';
        const depth = this.track(ctx.createGain());
        const offset = this.track(ctx.createConstantSource());
        osc.connect(depth).connect(vca.gain);
        offset.connect(vca.gain);
        osc.start();
        offset.start();
        this.input.connect(vca).connect(this.wet);
        const fx = {
          insert: true,
          onBpm: () => osc.frequency.setTargetAtTime((this.bpm / 60) * 2, ctx.currentTime, 0.02),
          onParam: (v) => {
            depth.gain.setTargetAtTime(v * 0.5, ctx.currentTime, 0.01);
            offset.offset.setTargetAtTime(1 - v * 0.5, ctx.currentTime, 0.01);
          },
        };
        fx.onBpm();
        return fx;
      }
      default:
        return null;
    }
  }
}
