// Canale microfono dalla scheda audio locale: gain, EQ a 2 bande, eco, on-air e talkover.
import { api } from '../api.js';
import { Meter } from './mixer.js';

/** Permesso del sistema per microfono e ingressi linea (macOS): se è negato lo si dice, con dove riattivarlo. */
export async function askMicAccess() {
  if (!(await api.requestMic())) {
    throw new Error('accesso al microfono negato: consentilo a Segueo in Impostazioni di Sistema → Privacy e sicurezza → Microfono');
  }
}

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
    this.airSeq = 0; // ultima richiesta di on air (Spazio premuto e rilasciato mentre si apre il microfono)
  }

  /**
   * Apre il microfono scelto. Il nuovo si apre prima di chiudere quello in uso: se non si apre resta il vecchio,
   * l'on air non cambia e la scelta resta (il prossimo tentativo riprova lo stesso microfono).
   */
  async open(deviceId) {
    const id = deviceId || 'default';
    this.deviceId = id;
    await askMicAccess();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id !== 'default' ? { exact: id } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0,
      },
    });
    if (this.deviceId !== id) {
      // nel frattempo è stato scelto un altro microfono
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.release();
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.input);
    this.dispatchEvent(new CustomEvent('change'));
  }

  release() {
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
  }

  close() {
    this.release();
    this.setOnAir(false);
  }

  async setOnAir(on) {
    const req = ++this.airSeq;
    if (on && !this.stream) {
      try {
        await this.open(this.deviceId || 'default');
      } catch (err) {
        this.dispatchEvent(new CustomEvent('error', { detail: `Microfono non disponibile: ${err.message}` }));
        return;
      }
      // Spazio rilasciato (o altra richiesta) mentre si apriva il microfono: vale l'ultima, il microfono resta spento
      if (req !== this.airSeq) return;
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
