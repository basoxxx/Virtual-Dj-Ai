// Canale microfono dalla scheda audio locale: gain, EQ a 2 bande, eco, on-air e talkover.
import { api } from '../api.js';
import { Meter } from './mixer.js';

export class MicChannel extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    const ctx = engine.ctx;
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 90;
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 250;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 3500;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -24;
    this.comp.ratio.value = 4;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.28;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.35;
    this.echoWet = ctx.createGain();
    this.echoWet.gain.value = 0;
    this.input.connect(this.hp).connect(this.low).connect(this.high).connect(this.comp).connect(this.gate);
    this.gate.connect(engine.micBus);
    this.gate.connect(this.echo);
    this.echo.connect(this.echoFb).connect(this.echo);
    this.echo.connect(this.echoWet).connect(engine.micBus);
    this.meter = new Meter(ctx, this.comp);
    this.stream = null;
    this.source = null;
    this.deviceId = null;
    this.onAir = false;
    this.talkover = true;
  }

  async open(deviceId) {
    this.close();
    await api.requestMic();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.input);
    this.deviceId = deviceId || 'default';
    this.dispatchEvent(new CustomEvent('change'));
  }

  close() {
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
    this.deviceId = null;
    this.setOnAir(false);
  }

  async setOnAir(on) {
    if (on && !this.stream) {
      try {
        await this.open(this.deviceId || 'default');
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', { detail: `Microfono non disponibile: ${err.message}` }));
        return;
      }
    }
    this.onAir = on;
    this.gate.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    this.engine.setTalkover(on && this.talkover);
    this.dispatchEvent(new CustomEvent('change'));
  }

  setTalkover(on) {
    this.talkover = on;
    this.engine.setTalkover(this.onAir && on);
    this.dispatchEvent(new CustomEvent('change'));
  }

  setGain(v) {
    this.input.gain.setTargetAtTime(v * v * 2, this.ctx.currentTime, 0.01);
  }

  setEq(band, v) {
    const f = band === 'low' ? this.low : this.high;
    f.gain.setTargetAtTime(v < 0 ? v * 20 : v * 8, this.ctx.currentTime, 0.01);
  }

  setEcho(v) {
    this.echoWet.gain.setTargetAtTime(v * 0.7, this.ctx.currentTime, 0.02);
  }
}
