// Canale del mixer: gain, EQ a 3 bande con kill, filtro a manopola singola,
// fader volume, crossfader, preascolto in cuffia e VU meter.

export const EQ_BANDS = {
  low: { type: 'lowshelf', freq: 220 },
  mid: { type: 'peaking', freq: 1000, q: 0.8 },
  high: { type: 'highshelf', freq: 3500 },
};

export class Meter {
  constructor(ctx, node) {
    this.splitter = ctx.createChannelSplitter(2);
    this.left = ctx.createAnalyser();
    this.right = ctx.createAnalyser();
    this.left.fftSize = 512;
    this.right.fftSize = 512;
    node.connect(this.splitter);
    this.splitter.connect(this.left, 0);
    this.splitter.connect(this.right, 1);
    this.buf = new Float32Array(512);
    this.levels = [0, 0];
    this.peaks = [0, 0];
    this.clip = 0;
  }

  read() {
    const now = performance.now();
    [this.left, this.right].forEach((an, i) => {
      an.getFloatTimeDomainData(this.buf);
      let pk = 0;
      for (let j = 0; j < this.buf.length; j++) {
        const v = Math.abs(this.buf[j]);
        if (v > pk) pk = v;
      }
      if (pk >= 0.999) this.clip = now;
      // caduta lenta come un VU reale
      this.levels[i] = Math.max(pk, this.levels[i] * 0.86);
      this.peaks[i] = Math.max(this.levels[i], this.peaks[i] - 0.006);
    });
    return { levels: this.levels, peaks: this.peaks, clip: now - this.clip < 800 };
  }
}

export class ChannelStrip {
  constructor(engine, name) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;
    this.name = name;
    this.input = ctx.createGain();
    this.trim = ctx.createGain();
    this.autoGain = ctx.createGain();
    this.eq = {};
    let node = this.input.connect(this.autoGain).connect(this.trim);
    for (const [band, def] of Object.entries(EQ_BANDS)) {
      const f = ctx.createBiquadFilter();
      f.type = def.type;
      f.frequency.value = def.freq;
      if (def.q) f.Q.value = def.q;
      node = node.connect(f);
      this.eq[band] = f;
    }
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 22000;
    this.lpf.Q.value = 0.9;
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 10;
    this.hpf.Q.value = 0.9;
    this.postEq = node.connect(this.lpf).connect(this.hpf);
    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.postEq.connect(this.fader).connect(this.xfade);
    this.postEq.connect(this.cueSend);
    this.cueSend.connect(engine.cueBus);
    this.xfade.connect(engine.musicBus);
    this.meter = new Meter(ctx, this.fader);
    this.eqValues = { low: 0, mid: 0, high: 0 };
    this.kills = { low: false, mid: false, high: false };
    this.xfAssign = 'thru';
    this.volume = 1;
    this.cue = false;
  }

  smooth(param, value, tc = 0.012) {
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  setTrim(db) {
    this.smooth(this.trim.gain, 10 ** (db / 20));
  }

  setAutoGain(db) {
    this.smooth(this.autoGain.gain, 10 ** (db / 20), 0.05);
  }

  /** v in -1..1: sinistra taglia fino a -30 dB, destra alza fino a +6 dB */
  setEq(band, v) {
    this.eqValues[band] = v;
    this.applyEq(band);
  }

  setKill(band, on) {
    this.kills[band] = on;
    this.applyEq(band);
  }

  applyEq(band) {
    const v = this.eqValues[band];
    const db = this.kills[band] ? -40 : v < 0 ? v * 30 : v * 6;
    this.smooth(this.eq[band].gain, db);
  }

  /** Filtro "one knob": sinistra passa-basso, destra passa-alto. */
  setFilter(v) {
    this.filterValue = v;
    const dead = 0.03;
    if (v < -dead) {
      const t = (-v - dead) / (1 - dead);
      this.smooth(this.lpf.frequency, 22000 * (80 / 22000) ** t);
      this.smooth(this.hpf.frequency, 10);
      this.smooth(this.lpf.Q, 0.9 + t * 3);
    } else if (v > dead) {
      const t = (v - dead) / (1 - dead);
      this.smooth(this.hpf.frequency, 20 * (9000 / 20) ** t);
      this.smooth(this.lpf.frequency, 22000);
      this.smooth(this.hpf.Q, 0.9 + t * 3);
    } else {
      this.smooth(this.lpf.frequency, 22000);
      this.smooth(this.hpf.frequency, 10);
    }
  }

  setVolume(v) {
    this.volume = v;
    // curva quasi logaritmica del fader
    this.smooth(this.fader.gain, v * v, 0.008);
  }

  setCue(on) {
    this.cue = on;
    this.smooth(this.cueSend.gain, on ? 1 : 0, 0.005);
  }

  setCrossfaderAssign(side) {
    this.xfAssign = side;
    this.engine.applyCrossfader();
  }
}
