// Deck: caricamento traccia, trasporto, cue stile CDJ, 8 hot cue, loop, beat jump,
// pitch/keylock, sync di tempo e fase, slip mode, reverse/censor, ingresso linea.
import { api } from '../api.js';
import { analyze, analysisPatch, analysisEngine, refineWithAi } from './analyzer-client.js';
import { FxSlot } from './effects.js';
import { shiftKey } from '../dsp/analysis.js';

export const HOTCUE_COUNT = 8;

export class Deck extends EventTarget {
  constructor(engine, strip, id) {
    super();
    this.engine = engine;
    this.ctx = engine.ctx;
    this.strip = strip;
    this.id = id;
    this.node = new AudioWorkletNode(this.ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.playerGain = this.ctx.createGain();
    this.lineGain = this.ctx.createGain();
    this.lineGain.gain.value = 0;
    this.fx = [new FxSlot(this.ctx), new FxSlot(this.ctx)];
    this.node.connect(this.playerGain);
    this.playerGain.connect(this.fx[0].input);
    this.lineGain.connect(this.fx[0].input);
    this.fx[0].output.connect(this.fx[1].input);
    this.fx[1].output.connect(strip.input);
    this.node.port.onmessage = (e) => this.onWorklet(e.data);

    this.track = null;
    this.duration = 0;
    this.sampleRate = this.ctx.sampleRate;
    this.waveform = null;
    this.bpm = 0;
    this.gridOffset = 0;
    this.key = '';
    this.cover = null;
    this.playing = false;
    this.loading = false;
    this.cuePoint = 0;
    this.hotcues = new Array(HOTCUE_COUNT).fill(null);
    this.loop = { in: 0, out: 0, active: false, beats: 0 };
    this.pitch = 0; // percentuale
    this.pitchRange = 8;
    this.keylock = false;
    this.quantize = true;
    this.slip = false;
    this.slipAnchor = null;
    this.vinyl = true;
    this.reverse = false;
    this.brakeTime = 0;
    this.startTime = 0;
    this.cuePreview = false;
    this.lastPos = 0;
    this.lastVel = 0;
    this.lastT = 0;
    this.lineStream = null;
    this.lineSource = null;
    this.lineDevice = null;
    this.bendTimer = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  post(msg) {
    this.node.port.postMessage(msg);
  }

  onWorklet(m) {
    if (m.type === 'pos') {
      this.lastPos = m.pos;
      this.lastVel = m.vel;
      this.lastT = m.t;
    } else if (m.type === 'ended') {
      this.playing = false;
      this.emit('state');
      this.emit('ended');
    }
  }

  get loaded() {
    return Boolean(this.track) && this.duration > 0;
  }

  get tempo() {
    return 1 + this.pitch / 100;
  }

  get effectiveBpm() {
    return this.bpm * this.tempo;
  }

  get beatLength() {
    return 60 / (this.bpm || 120);
  }

  get displayKey() {
    if (!this.key) return '';
    if (this.keylock) return this.key;
    return shiftKey(this.key, 12 * Math.log2(this.tempo));
  }

  /** posizione corrente stimata in secondi (interpolata tra i messaggi del worklet) */
  get position() {
    if (!this.loaded) return 0;
    const dt = Math.max(0, this.ctx.currentTime - this.lastT);
    let p = this.lastPos + this.lastVel * dt * this.sampleRate;
    if (this.loop.active && p >= this.loop.out * this.sampleRate) {
      const len = (this.loop.out - this.loop.in) * this.sampleRate;
      p = this.loop.in * this.sampleRate + ((p - this.loop.in * this.sampleRate) % len);
    }
    return Math.max(0, Math.min(this.duration, p / this.sampleRate));
  }

  get remaining() {
    return Math.max(0, this.duration - this.position);
  }

  // --- Caricamento ----------------------------------------------------------------

  async load(track) {
    if (this.lineDevice) await this.setLineInput(null);
    this.loading = true;
    this.emit('loading', track);
    try {
      const bytes = await api.readFile(track.path);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const audio = await this.ctx.decodeAudioData(ab);
      const left = audio.getChannelData(0);
      const right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
      this.post({ type: 'unload' });
      this.post({ type: 'load', left, right });
      // versione completa (per tornarci dopo solo voce / solo base)
      this.fullBuffers = { left, right };
      this.stem = 'full';
      this.post({ type: 'seek', pos: 0 });
      this.track = track;
      this.duration = audio.duration;
      this.sampleRate = audio.sampleRate;
      this.playing = false;
      this.lastPos = 0;
      this.lastVel = 0;
      this.lastT = this.ctx.currentTime;
      this.waveform = null;
      this.cover = null;
      this.bpm = track.bpm || 0;
      this.gridOffset = track.gridOffset || 0;
      this.key = track.key || '';
      this.hotcues = new Array(HOTCUE_COUNT).fill(null);
      (track.hotcues || []).forEach((c, i) => {
        if (i < HOTCUE_COUNT && typeof c === 'number') this.hotcues[i] = c;
      });
      this.cuePoint = this.hotcues[0] ?? (track.analyzed ? this.gridOffset : 0);
      this.loop = { in: 0, out: 0, active: false, beats: 0 };
      this.post({ type: 'loop', in: 0, out: 0, active: false });
      this.post({ type: 'seek', pos: this.cuePoint * this.sampleRate });
      this.lastPos = this.cuePoint * this.sampleRate;
      this.strip.setAutoGain(this.engine.autoGain !== false ? track.gain || 0 : 0);
      this.loading = false;
      this.emit('loaded', track);
      this.emit('state');
      this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
      api.getCover(track.path).then((c) => {
        if (this.track === track) {
          this.cover = c;
          this.emit('cover', c);
        }
      });
      // l'energia per battuta (remix dal vivo) non viaggia con la libreria: si chiede solo per il brano caricato
      if (!track.barEnergy && track.analyzed && api.getTrack) {
        api.getTrack(track.id).then((full) => {
          if (full && full.barEnergy && !track.barEnergy) track.barEnergy = full.barEnergy;
        }).catch(() => {});
      }
      this.runAnalysis(track, [left, right === left ? left : right], audio.sampleRate, bytes);
      return true;
    } catch (err) {
      this.loading = false;
      this.emit('error', `Impossibile caricare "${track.title}": ${err.message}`);
      this.emit('state');
      return false;
    }
  }

  async runAnalysis(track, channels, sampleRate, encoded) {
    const needBeat = !track.analyzed || !track.bpm;
    const needKey = !track.key;
    this.emit('analyzing', true);
    try {
      // prima il classico (risultati subito), poi con il motore AI la rifinitura in background
      const res = await analyze(channels, sampleRate, { engine: 'classic', bpm: needBeat, key: needKey, knownBpm: track.bpm || 0, knownOffset: track.gridOffset || 0 });
      if (this.track !== track) return;
      this.waveform = res.waveform;
      const patch = analysisPatch(res, this.duration);
      if (res.beat && res.beat.bpm) {
        this.bpm = res.beat.bpm;
        this.gridOffset = res.beat.offset;
        if (!track.hotcues || track.hotcues[0] == null) {
          if (Math.abs(this.position - this.cuePoint) < 0.01 && !this.playing) {
            this.cuePoint = this.gridOffset;
            this.seek(this.cuePoint);
          }
        }
      }
      if (res.key) this.key = res.key.key;
      if (res.loudness && this.engine.autoGain !== false) this.strip.setAutoGain(patch.gain);
      Object.assign(track, patch);
      api.updateTrack(track.id, patch);
      this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
      this.emit('analyzed', track);
      this.emit('state');
    } catch (err) {
      this.emit('error', `Analisi non riuscita: ${err.message}`);
    } finally {
      this.emit('analyzing', false);
    }
    if (needBeat && analysisEngine() === 'ai' && this.track === track) await this.refineAnalysis(track, channels, sampleRate, encoded);
  }

  /** Rifinitura AI (Beat This!) di griglia, battuta forte e struttura dopo l'analisi classica. */
  async refineAnalysis(track, channels, sampleRate, encoded) {
    let res;
    try {
      res = await refineWithAi(channels, sampleRate, encoded);
    } catch (err) {
      console.warn('Rifinitura AI non riuscita', err);
    }
    if (!res || !res.beat || res.beat.engine !== 'ai') {
      track.aiRefineFailed = true;
      return;
    }
    if (track.bpmEngine === 'manual') return; // griglia corretta a mano nel frattempo
    const patch = analysisPatch(res, this.duration);
    delete patch.gain;
    Object.assign(track, patch);
    api.updateTrack(track.id, patch);
    // un deck in riproduzione cambia solo fase e battuta forte, non il tempo: chi è in sync non salta
    if (this.track !== track || (this.playing && Math.abs(res.beat.bpm - this.bpm) >= 0.5)) return;
    const atCue = Math.abs(this.position - this.cuePoint) < 0.01 && !this.playing;
    this.bpm = res.beat.bpm;
    this.gridOffset = res.beat.offset;
    if (atCue && (!track.hotcues || track.hotcues[0] == null)) {
      this.cuePoint = this.gridOffset;
      this.seek(this.cuePoint);
    }
    this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
    this.emit('analyzed', track);
    this.emit('state');
  }

  eject() {
    if (this.playing) return false;
    this.post({ type: 'unload' });
    this.fullBuffers = null;
    this.stem = 'full';
    this.track = null;
    this.duration = 0;
    this.waveform = null;
    this.bpm = 0;
    this.key = '';
    this.cover = null;
    this.loop = { in: 0, out: 0, active: false, beats: 0 };
    this.emit('loaded', null);
    this.emit('state');
    return true;
  }

  // --- Trasporto --------------------------------------------------------------------

  play() {
    if (!this.loaded) return;
    this.engine.resume();
    this.cuePreview = false;
    this.playing = true;
    this.post({ type: 'play', startTime: this.startTime });
    if (this.track && !this.track._counted) {
      this.track._counted = true;
      api.markPlayed(this.track.id);
    }
    this.emit('state');
  }

  pause() {
    if (!this.loaded) return;
    this.playing = false;
    this.cuePreview = false;
    this.post({ type: 'pause', brakeTime: this.brakeTime });
    this.emit('state');
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this.playing = false;
    this.post({ type: 'pause', brakeTime: 0 });
    this.seek(this.cuePoint);
    this.emit('state');
  }

  seek(sec) {
    if (!this.loaded) return;
    const s = Math.max(0, Math.min(this.duration, sec));
    this.post({ type: 'seek', pos: s * this.sampleRate });
    this.lastPos = s * this.sampleRate;
    this.lastT = this.ctx.currentTime;
    if (this.loop.active && (s < this.loop.in || s >= this.loop.out)) this.setLoopActive(false);
    this.emit('seek', s);
  }

  snap(sec) {
    if (!this.quantize || !this.bpm) return sec;
    const beat = this.beatLength;
    const n = Math.round((sec - this.gridOffset) / beat);
    return Math.max(0, this.gridOffset + n * beat);
  }

  /** CUE stile CDJ: premuto in play torna al cue, da fermo imposta il cue o fa preascolto */
  cueDown() {
    if (!this.loaded) return;
    if (this.playing && !this.cuePreview) {
      this.pause();
      this.seek(this.cuePoint);
      return;
    }
    const pos = this.position;
    if (Math.abs(pos - this.cuePoint) < 0.02) {
      this.cuePreview = true;
      this.playing = true;
      this.post({ type: 'play', startTime: 0 });
      this.emit('state');
    } else {
      this.cuePoint = this.snap(pos);
      this.seek(this.cuePoint);
      this.emit('state');
    }
  }

  cueUp() {
    if (this.cuePreview) {
      this.cuePreview = false;
      this.playing = false;
      this.post({ type: 'pause', brakeTime: 0 });
      this.seek(this.cuePoint);
      this.emit('state');
    }
  }

  /** "Stutter": riparte dal punto di cue senza fermarsi */
  cuePlay() {
    this.seek(this.cuePoint);
    this.play();
  }

  // --- Hot cue ------------------------------------------------------------------------

  hotcue(i) {
    if (!this.loaded) return;
    const c = this.hotcues[i];
    if (c == null) {
      this.hotcues[i] = this.snap(this.position);
      this.saveHotcues();
    } else {
      this.seek(c);
      if (!this.playing) this.cuePoint = c;
    }
    this.emit('state');
  }

  deleteHotcue(i) {
    this.hotcues[i] = null;
    this.saveHotcues();
    this.emit('state');
  }

  saveHotcues() {
    if (!this.track) return;
    this.track.hotcues = [...this.hotcues];
    api.updateTrack(this.track.id, { hotcues: this.track.hotcues });
  }

  // --- Loop ----------------------------------------------------------------------------

  /**
   * Versione del brano in riproduzione: 'full', 'vocals' (solo voce) o 'instrumental' (solo base), dalle
   * parti separate salvate su disco (mashup). Lo scambio non ferma né sposta il brano.
   */
  async setStem(kind) {
    if (!this.track || !this.fullBuffers) return false;
    if (kind === (this.stem || 'full')) return true;
    const track = this.track;
    let left;
    let right;
    if (kind === 'full') {
      ({ left, right } = this.fullBuffers);
    } else {
      const bytes = await api.readStem(track.id, kind);
      if (!bytes) throw new Error('parte separata non disponibile');
      const audio = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      left = audio.getChannelData(0);
      right = audio.numberOfChannels > 1 ? audio.getChannelData(1) : left;
    }
    if (this.track !== track) return false;
    this.post({ type: 'swap', left, right });
    this.stem = kind;
    this.emit('state');
    return true;
  }

  sendLoop() {
    this.post({ type: 'loop', in: this.loop.in * this.sampleRate, out: this.loop.out * this.sampleRate, active: this.loop.active });
    this.emit('state');
  }

  beginSlip() {
    if (this.slip && !this.slipAnchor) this.slipAnchor = { pos: this.position, t: this.ctx.currentTime, tempo: this.tempo };
  }

  endSlip() {
    if (!this.slipAnchor) return;
    const a = this.slipAnchor;
    this.slipAnchor = null;
    const target = a.pos + (this.playing ? (this.ctx.currentTime - a.t) * a.tempo : 0);
    this.seek(target);
  }

  autoLoop(beats) {
    if (!this.loaded) return;
    if (this.loop.active && this.loop.beats === beats) {
      this.setLoopActive(false);
      return;
    }
    const start = this.loop.active ? this.loop.in : this.snapDown(this.position);
    this.beginSlip();
    this.loop = { in: start, out: start + beats * this.beatLength, active: true, beats };
    this.sendLoop();
  }

  snapDown(sec) {
    if (!this.quantize || !this.bpm) return sec;
    const beat = this.beatLength;
    const n = Math.floor((sec - this.gridOffset) / beat + 0.02);
    return Math.max(0, this.gridOffset + n * beat);
  }

  loopIn() {
    if (!this.loaded) return;
    this.loop.in = this.snap(this.position);
    if (this.loop.out <= this.loop.in) this.loop.out = 0;
    this.loop.active = false;
    this.loop.beats = 0;
    this.sendLoop();
  }

  loopOut() {
    if (!this.loaded) return;
    const out = this.snap(this.position);
    if (out <= this.loop.in) return;
    this.beginSlip();
    this.loop.out = out;
    this.loop.active = true;
    this.loop.beats = this.bpm ? Math.round(((out - this.loop.in) / this.beatLength) * 100) / 100 : 0;
    this.sendLoop();
  }

  setLoopActive(active) {
    if (active && this.loop.out > this.loop.in) {
      this.beginSlip();
      this.loop.active = true;
      const p = this.position;
      if (p < this.loop.in || p >= this.loop.out) this.seek(this.loop.in);
    } else {
      this.loop.active = false;
      this.post({ type: 'loop', in: this.loop.in * this.sampleRate, out: this.loop.out * this.sampleRate, active: false });
      this.endSlip();
    }
    this.sendLoop();
  }

  reloop() {
    this.setLoopActive(!this.loop.active);
  }

  loopScale(factor) {
    if (this.loop.out <= this.loop.in) return;
    const len = (this.loop.out - this.loop.in) * factor;
    if (len < 0.01 || len > 600) return;
    this.loop.out = this.loop.in + len;
    if (this.loop.beats) this.loop.beats *= factor;
    this.sendLoop();
  }

  loopMove(beats) {
    const d = beats * this.beatLength;
    this.loop.in = Math.max(0, this.loop.in + d);
    this.loop.out = Math.max(this.loop.in + 0.01, this.loop.out + d);
    if (this.loop.active) this.seek(this.position + d);
    this.sendLoop();
  }

  beatJump(beats) {
    if (!this.loaded) return;
    this.seek(this.position + beats * this.beatLength);
  }

  // --- Pitch / tempo --------------------------------------------------------------------

  setPitch(percent) {
    this.pitch = Math.max(-this.pitchRange, Math.min(this.pitchRange, percent));
    this.post({ type: 'tempo', value: this.tempo });
    this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
    this.emit('pitch', this.pitch);
    this.emit('state');
  }

  setPitchRange(range) {
    this.pitchRange = range;
    if (Math.abs(this.pitch) > range) this.setPitch(this.pitch);
    this.emit('state');
  }

  setKeylock(on) {
    this.keylock = on;
    this.post({ type: 'keylock', value: on });
    this.emit('state');
  }

  /** nudge temporaneo (pitch bend) in percentuale */
  bend(percent) {
    this.post({ type: 'bend', value: percent / 100 });
  }

  nudge(percent, ms = 180) {
    this.bend(percent);
    clearTimeout(this.bendTimer);
    this.bendTimer = setTimeout(() => this.bend(0), ms);
  }

  sync(master) {
    if (!master || !master.bpm || !this.bpm) return false;
    let ratio = master.effectiveBpm / this.bpm;
    while (ratio > 1.5) ratio /= 2;
    while (ratio < 0.67) ratio *= 2;
    const pitch = (ratio - 1) * 100;
    if (Math.abs(pitch) > this.pitchRange) {
      const ranges = [8, 16, 25, 50, 100];
      this.setPitchRange(ranges.find((r) => r >= Math.abs(pitch)) || 100);
    }
    this.setPitch(pitch);
    if (master.playing && this.loaded) this.alignPhase(master);
    return true;
  }

  beatPhase() {
    if (!this.bpm) return 0;
    const b = (this.position - this.gridOffset) / this.beatLength;
    return b - Math.floor(b);
  }

  alignPhase(master) {
    let diff = master.beatPhase() - this.beatPhase();
    if (diff > 0.5) diff -= 1;
    if (diff < -0.5) diff += 1;
    this.seek(this.position + diff * this.beatLength);
  }

  tapTempo() {
    const now = performance.now();
    this.taps = (this.taps || []).filter((t) => now - t < 3000);
    this.taps.push(now);
    if (this.taps.length >= 4) {
      const intervals = this.taps.slice(1).map((t, i) => t - this.taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const tapped = 60000 / avg / this.tempo;
      this.bpm = Math.round(tapped * 100) / 100;
      this.gridOffset = this.position % this.beatLength;
      if (this.track) {
        this.track.bpm = this.bpm;
        this.track.gridOffset = this.gridOffset;
        this.track.bpmEngine = 'manual';
        api.updateTrack(this.track.id, { bpm: this.bpm, gridOffset: this.gridOffset, bpmEngine: 'manual' });
      }
      this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
      this.emit('state');
    }
  }

  /** sposta la beatgrid in modo che la battuta cada sulla posizione attuale */
  setGridHere() {
    if (!this.bpm) return;
    this.gridOffset = this.position % this.beatLength;
    if (this.track) {
      this.track.gridOffset = this.gridOffset;
      this.track.bpmEngine = 'manual';
      api.updateTrack(this.track.id, { gridOffset: this.gridOffset, bpmEngine: 'manual' });
    }
    this.emit('state');
  }

  setBpm(bpm) {
    if (!(bpm > 20 && bpm < 400)) return;
    this.bpm = bpm;
    if (this.track) {
      this.track.bpm = bpm;
      this.track.bpmEngine = 'manual';
      api.updateTrack(this.track.id, { bpm, bpmEngine: 'manual' });
    }
    this.fx.forEach((f) => f.setBpm(this.effectiveBpm));
    this.emit('state');
  }

  // --- Jog / scratch -------------------------------------------------------------------

  jogTouch(on) {
    if (!this.loaded) return;
    if (!this.vinyl) return;
    if (on) {
      this.beginSlip();
      this.post({ type: 'scratch', active: true, velocity: 0, reset: !this.playing });
    } else {
      this.post({ type: 'scratch', active: false });
      this.endSlip();
    }
    this.scratching = on;
  }

  /** velocità di scratch: 1 = velocità normale */
  jogScratch(velocity) {
    this.post({ type: 'scratchVelocity', velocity });
  }

  /** rotazione del jog senza touch: pitch bend in play, ricerca fine da fermo */
  jogTurn(delta) {
    if (!this.loaded) return;
    if (this.playing) this.nudge(Math.max(-30, Math.min(30, delta * 40)), 120);
    else this.seek(this.position + delta * 0.5);
  }

  setReverse(on) {
    this.reverse = on;
    this.post({ type: 'reverse', value: on });
    this.emit('state');
  }

  censor(on) {
    if (on) this.beginSlip();
    this.setReverse(on);
    if (!on) this.endSlip();
  }

  setSlip(on) {
    this.slip = on;
    if (!on) this.slipAnchor = null;
    this.emit('state');
  }

  // --- Ingresso linea (giradischi/CD/strumenti dalla scheda audio) ------------------

  async setLineInput(deviceId) {
    if (this.lineSource) {
      this.lineSource.disconnect();
      this.lineSource = null;
    }
    if (this.lineStream) {
      this.lineStream.getTracks().forEach((t) => t.stop());
      this.lineStream = null;
    }
    this.lineDevice = null;
    if (!deviceId) {
      this.lineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      this.playerGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
      this.emit('line', null);
      this.emit('state');
      return;
    }
    await api.requestMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        latency: 0,
      },
    });
    if (this.playing) this.pause();
    this.lineStream = stream;
    this.lineSource = this.ctx.createMediaStreamSource(stream);
    this.lineSource.connect(this.lineGain);
    this.lineDevice = deviceId;
    this.lineGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
    this.playerGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    this.emit('line', deviceId);
    this.emit('state');
  }
}
