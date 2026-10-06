// Motore audio: bus master e cuffia, crossfader, limiter, routing verso le
// periferiche locali (uscita master, uscita cuffia separata o split), registrazione.
import { Meter } from './mixer.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.channels = [];
    this.crossfader = 0;
    this.xfCurve = 'smooth';
    this.routing = { mode: 'single', masterDevice: '', headphoneDevice: '' };
    this.recording = false;
    this.recordStart = 0;
  }

  async init({ latency = 'interactive', sampleRate } = {}) {
    const opts = { latencyHint: latency };
    if (sampleRate) opts.sampleRate = sampleRate;
    const ctx = new AudioContext(opts);
    this.ctx = ctx;
    const base = new URL('../../worklets/', import.meta.url);
    await ctx.audioWorklet.addModule(new URL('deck-processor.js', base));
    await ctx.audioWorklet.addModule(new URL('recorder-processor.js', base));

    this.musicBus = ctx.createGain();
    this.duck = ctx.createGain();
    this.micBus = ctx.createGain();
    this.samplerBus = ctx.createGain();
    this.masterSum = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.8;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.masterOut = ctx.createGain();
    this.limiterOn = true;

    this.musicBus.connect(this.duck).connect(this.masterSum);
    this.micBus.connect(this.masterSum);
    this.samplerBus.connect(this.masterSum);
    this.masterSum.connect(this.masterGain).connect(this.limiter).connect(this.masterOut);
    this.masterMeter = new Meter(ctx, this.masterOut);

    // cuffia: mix tra preascolto (cue) e master
    this.cueBus = ctx.createGain();
    this.hpCue = ctx.createGain();
    this.hpMaster = ctx.createGain();
    this.hpVolume = ctx.createGain();
    this.hpVolume.gain.value = 0.8;
    this.cueBus.connect(this.hpCue).connect(this.hpVolume);
    this.masterOut.connect(this.hpMaster).connect(this.hpVolume);
    this.hpMeter = new Meter(ctx, this.hpVolume);
    this.setCueMix(0);

    // uscite fisiche
    this.masterRoute = ctx.createGain();
    this.hpRoute = ctx.createGain();
    this.masterOut.connect(this.masterRoute);
    this.hpVolume.connect(this.hpRoute);
    this.hpStreamDest = ctx.createMediaStreamDestination();
    this.hpAudio = new Audio();
    this.hpAudio.autoplay = true;

    this.recorder = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.masterOut.connect(this.recorder);
    this.recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);

    await this.applyRouting(this.routing);
    return ctx;
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }

  addChannel(strip) {
    this.channels.push(strip);
    this.applyCrossfader();
  }

  setMasterVolume(v) {
    this.masterGain.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.01);
  }

  setLimiter(on) {
    this.limiterOn = on;
    this.limiter.threshold.value = on ? -1 : 0;
    this.limiter.ratio.value = on ? 20 : 1;
  }

  setHeadphoneVolume(v) {
    this.hpVolume.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.01);
  }

  /** 0 = solo cue, 1 = solo master */
  setCueMix(v) {
    this.cueMix = v;
    this.hpCue.gain.setTargetAtTime(Math.cos((v * Math.PI) / 2), this.ctx.currentTime, 0.01);
    this.hpMaster.gain.setTargetAtTime(Math.sin((v * Math.PI) / 2), this.ctx.currentTime, 0.01);
  }

  setTalkover(on, depthDb = -14) {
    this.duck.gain.setTargetAtTime(on ? 10 ** (depthDb / 20) : 1, this.ctx.currentTime, on ? 0.05 : 0.3);
  }

  setCrossfader(x) {
    this.crossfader = Math.max(-1, Math.min(1, x));
    this.applyCrossfader();
    this.dispatchEvent(new CustomEvent('crossfader', { detail: this.crossfader }));
  }

  setCrossfaderCurve(curve) {
    this.xfCurve = curve;
    this.applyCrossfader();
  }

  static crossfaderGains(x, curve) {
    const t = (x + 1) / 2;
    let a;
    let b;
    if (curve === 'linear') {
      a = 1 - t;
      b = t;
    } else if (curve === 'cut') {
      // curva da scratch: taglio netto agli estremi
      a = t > 0.94 ? (1 - t) / 0.06 : 1;
      b = t < 0.06 ? t / 0.06 : 1;
    } else {
      a = Math.cos((t * Math.PI) / 2);
      b = Math.sin((t * Math.PI) / 2);
      // a centro corsa entrambi al massimo volume percepito
      a = Math.min(1, a * Math.SQRT2);
      b = Math.min(1, b * Math.SQRT2);
    }
    return { a, b };
  }

  applyCrossfader() {
    if (!this.ctx) return;
    const { a, b } = AudioEngine.crossfaderGains(this.crossfader, this.xfCurve);
    for (const ch of this.channels) {
      const g = ch.xfAssign === 'A' ? a : ch.xfAssign === 'B' ? b : 1;
      ch.xfade.gain.setTargetAtTime(g, this.ctx.currentTime, 0.004);
    }
  }

  // --- Periferiche audio locali ------------------------------------------------

  static async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return {
        outputs: list.filter((d) => d.kind === 'audiooutput'),
        inputs: list.filter((d) => d.kind === 'audioinput'),
      };
    } catch {
      return { outputs: [], inputs: [] };
    }
  }

  /**
   * mode:
   *  - 'single'   : master sull'uscita scelta, cuffia (se impostata) su una seconda periferica
   *  - 'split'    : stessa scheda, master mono a sinistra e cuffia mono a destra (cavo splitter)
   *  - 'quad'     : scheda DJ a 4 uscite (es. Hercules Inpulse): master su 1-2, cuffia su 3-4
   *  - 'separate' : alias di single con cuffia obbligatoria su un'altra periferica
   * Restituisce { outputs, quad }: canali di uscita della scheda master e se la cuffia è su 3-4.
   */
  async applyRouting(routing) {
    this.routing = { ...this.routing, ...routing };
    const { mode, masterDevice, headphoneDevice } = this.routing;
    const ctx = this.ctx;
    for (const n of [this.masterRoute, this.hpRoute]) n.disconnect();
    if (this.splitMerger) {
      this.splitMerger.disconnect();
      this.splitMerger = null;
    }
    this.hpAudio.pause();
    this.hpAudio.srcObject = null;

    if (typeof ctx.setSinkId === 'function') {
      try {
        await ctx.setSinkId(masterDevice || '');
      } catch (err) {
        console.warn('setSinkId master', err);
      }
    }
    const dest = ctx.destination;
    const outputs = dest.maxChannelCount || 2;
    if (dest.channelCount !== 2) {
      dest.channelCount = 2;
      dest.channelInterpretation = 'speakers';
    }

    if (mode === 'quad') {
      if (outputs < 4) {
        this.masterRoute.connect(dest);
        this.dispatchEvent(new CustomEvent('error', {
          detail: `La scheda audio scelta ha ${outputs} uscite: per la cuffia su 3-4 ne servono 4. Su Windows imposta la scheda come "Quadrifonico" (Pannello audio → Configura) oppure scegli la cuffia come seconda uscita.`,
        }));
        return { outputs, quad: false };
      }
      dest.channelCount = 4;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(4);
      const masterSplit = ctx.createChannelSplitter(2);
      const hpSplit = ctx.createChannelSplitter(2);
      this.masterRoute.connect(masterSplit);
      this.hpRoute.connect(hpSplit);
      masterSplit.connect(merger, 0, 0);
      masterSplit.connect(merger, 1, 1);
      hpSplit.connect(merger, 0, 2);
      hpSplit.connect(merger, 1, 3);
      merger.connect(dest);
      this.splitMerger = merger;
      return { outputs, quad: true };
    }

    if (mode === 'split') {
      const merger = ctx.createChannelMerger(2);
      const monoMaster = ctx.createGain();
      const monoHp = ctx.createGain();
      for (const m of [monoMaster, monoHp]) {
        m.channelCount = 1;
        m.channelCountMode = 'explicit';
        m.channelInterpretation = 'speakers';
      }
      this.masterRoute.connect(monoMaster).connect(merger, 0, 0);
      this.hpRoute.connect(monoHp).connect(merger, 0, 1);
      merger.connect(ctx.destination);
      this.splitMerger = merger;
      return { outputs, quad: false };
    }

    this.masterRoute.connect(ctx.destination);
    if (headphoneDevice && headphoneDevice !== masterDevice) {
      this.hpRoute.connect(this.hpStreamDest);
      this.hpAudio.srcObject = this.hpStreamDest.stream;
      try {
        if (this.hpAudio.setSinkId) await this.hpAudio.setSinkId(headphoneDevice);
        await this.hpAudio.play();
      } catch (err) {
        console.warn('Uscita cuffia', err);
        this.dispatchEvent(new CustomEvent('error', { detail: `Uscita cuffia non disponibile: ${err.message}` }));
      }
    }
    return { outputs, quad: false };
  }

  get outputLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  // --- Registrazione -----------------------------------------------------------

  async startRecording(api) {
    if (this.recording) return;
    this.recApi = api;
    await api.recordStart({ sampleRate: this.ctx.sampleRate, channels: 2 });
    this.recording = true;
    this.recordStart = performance.now();
    this.recorder.port.postMessage({ type: 'start' });
    this.dispatchEvent(new CustomEvent('recording', { detail: true }));
  }

  stopRecording() {
    if (!this.recording) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.onRecStopped = async () => {
        this.recording = false;
        this.dispatchEvent(new CustomEvent('recording', { detail: false }));
        resolve(await this.recApi.recordStop());
      };
      this.recorder.port.postMessage({ type: 'stop' });
    });
  }

  onRecorderMessage(m) {
    if (m.type === 'chunk' && this.recApi) this.recApi.recordChunk(m.chunk);
    else if (m.type === 'stopped' && this.onRecStopped) {
      const cb = this.onRecStopped;
      this.onRecStopped = null;
      cb();
    }
  }
}
