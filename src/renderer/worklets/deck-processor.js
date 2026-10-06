// Motore di riproduzione del deck in AudioWorklet:
// velocità variabile (anche negativa per lo scratch), loop precisi al campione,
// frenata/partenza del piatto, keylock e cambio di tonalità tramite pitch shifter a doppia testina.

const PS_SIZE = 8192; // buffer circolare del pitch shifter (potenza di 2)
const PS_MASK = PS_SIZE - 1;

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.pos = 0;
    this.playing = false;
    this.tempo = 1;
    this.bend = 0;
    this.motor = 0;
    this.motorRate = 0; // incremento per campione (0 = immediato)
    this.startRate = 0;
    this.scratching = false;
    this.scratchTarget = 0;
    this.scratchVel = 0;
    this.loopActive = false;
    this.loopIn = 0;
    this.loopOut = 0;
    this.keylock = false;
    this.keyRatio = 1; // cambio di tonalità (2^(semitoni/12)), indipendente dal tempo
    this.reverse = false;
    this.ended = false;
    this.quanta = 0;
    this.psBufL = new Float32Array(PS_SIZE);
    this.psBufR = new Float32Array(PS_SIZE);
    this.psWrite = 0;
    this.psPhase = 0;
    this.psWindow = 2048;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.left;
        this.R = m.right || m.left;
        this.len = this.L.length;
        this.pos = 0;
        this.playing = false;
        this.motor = 0;
        this.loopActive = false;
        this.ended = false;
        break;
      case 'swap':
        // altra versione dello stesso brano (es. solo voce o solo base): posizione, loop e riproduzione restano
        this.L = m.left;
        this.R = m.right || m.left;
        this.len = this.L.length;
        if (this.pos > this.len) this.pos = this.len;
        break;
      case 'unload':
        this.L = this.R = null;
        this.len = 0;
        this.playing = false;
        break;
      case 'play':
        this.playing = true;
        this.ended = false;
        this.motorRate = m.startTime > 0 ? 1 / (m.startTime * sampleRate) : 0;
        if (this.motorRate === 0) this.motor = 1;
        break;
      case 'pause':
        this.playing = false;
        this.motorRate = m.brakeTime > 0 ? 1 / (m.brakeTime * sampleRate) : 0;
        if (this.motorRate === 0) this.motor = 0;
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.len, m.pos));
        this.ended = false;
        break;
      case 'tempo':
        this.tempo = m.value;
        break;
      case 'key':
        this.keyRatio = m.value;
        break;
      case 'bend':
        this.bend = m.value;
        break;
      case 'keylock':
        this.keylock = m.value;
        break;
      case 'reverse':
        this.reverse = m.value;
        break;
      case 'loop':
        this.loopIn = m.in;
        this.loopOut = m.out;
        this.loopActive = m.active && m.out > m.in;
        if (this.loopActive && this.pos > this.loopOut) this.pos = this.loopIn;
        break;
      case 'scratch':
        this.scratching = m.active;
        this.scratchTarget = m.velocity || 0;
        if (m.active && m.reset) this.scratchVel = 0;
        break;
      case 'scratchVelocity':
        this.scratchTarget = m.velocity;
        break;
      default:
        break;
    }
  }

  read(buf, p) {
    const i = Math.floor(p);
    if (i < 0 || i >= this.len) return 0;
    const f = p - i;
    const a = buf[i];
    const b = i + 1 < this.len ? buf[i + 1] : 0;
    return a + (b - a) * f;
  }

  psRead(buf, delay) {
    const p = this.psWrite - delay;
    const i = Math.floor(p);
    const f = p - i;
    const a = buf[i & PS_MASK];
    const b = buf[(i + 1) & PS_MASK];
    return a + (b - a) * f;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const frames = outL.length;
    if (!this.L) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }
    const W = this.psWindow;
    for (let n = 0; n < frames; n++) {
      // motore del piatto (partenza/frenata)
      if (this.playing && this.motor < 1) this.motor = this.motorRate ? Math.min(1, this.motor + this.motorRate) : 1;
      else if (!this.playing && this.motor > 0) this.motor = this.motorRate ? Math.max(0, this.motor - this.motorRate) : 0;

      let vel;
      if (this.scratching) {
        this.scratchVel += (this.scratchTarget - this.scratchVel) * 0.003;
        vel = this.scratchVel;
      } else {
        vel = this.motor * this.tempo * (1 + this.bend);
        if (this.reverse) vel = -vel;
      }

      let l = 0;
      let r = 0;
      if (vel !== 0 || this.scratching) {
        l = this.read(this.L, this.pos);
        r = this.read(this.R, this.pos);
        this.pos += vel;
        if (this.loopActive && vel > 0 && this.pos >= this.loopOut) this.pos -= this.loopOut - this.loopIn;
        if (this.loopActive && vel < 0 && this.pos < this.loopIn) this.pos += this.loopOut - this.loopIn;
        if (this.pos < 0) this.pos = 0;
        if (this.pos >= this.len) {
          this.pos = this.len;
          if (!this.scratching && this.playing && !this.ended) {
            this.ended = true;
            this.playing = false;
            this.motor = 0;
            this.port.postMessage({ type: 'ended' });
          }
        }
      }

      // keylock: riporta l'intonazione originale compensando la velocità; keyRatio la trasporta
      const absVel = Math.abs(vel);
      const ratio = absVel > 0.05 ? (this.keylock ? 1 / absVel : 1) * this.keyRatio : 1;
      if (!this.scratching && absVel > 0.05 && Math.abs(ratio - 1) > 0.002) {
        this.psBufL[this.psWrite & PS_MASK] = l;
        this.psBufR[this.psWrite & PS_MASK] = r;
        this.psPhase += 1 - ratio;
        if (this.psPhase >= W) this.psPhase -= W;
        if (this.psPhase < 0) this.psPhase += W;
        const d1 = this.psPhase;
        let d2 = d1 + W / 2;
        if (d2 >= W) d2 -= W;
        const g1 = 0.5 - 0.5 * Math.cos((2 * Math.PI * d1) / W);
        const g2 = 1 - g1;
        l = g1 * this.psRead(this.psBufL, d1 + 2) + g2 * this.psRead(this.psBufL, d2 + 2);
        r = g1 * this.psRead(this.psBufR, d1 + 2) + g2 * this.psRead(this.psBufR, d2 + 2);
        this.psWrite++;
      } else {
        this.psBufL[this.psWrite & PS_MASK] = l;
        this.psBufR[this.psWrite & PS_MASK] = r;
        this.psWrite++;
      }

      outL[n] = l;
      outR[n] = r;
    }
    if (++this.quanta >= 3) {
      this.quanta = 0;
      const vel = this.scratching ? this.scratchVel : this.motor * this.tempo * (1 + this.bend) * (this.reverse ? -1 : 1);
      this.port.postMessage({ type: 'pos', pos: this.pos, playing: this.playing, vel, t: currentTime });
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
