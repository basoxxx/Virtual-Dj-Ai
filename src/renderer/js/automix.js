// Automix: suona la coda di brani alternando i deck, con sync e dissolvenza di crossfader.

export class Automix extends EventTarget {
  constructor(engine, decks) {
    super();
    this.engine = engine;
    this.decks = decks;
    this.queue = [];
    this.enabled = false;
    this.mixLength = 10;
    this.fading = null;
    this.timer = null;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  setQueue(tracks) {
    this.queue = [...tracks];
    this.emit();
  }

  enqueue(tracks) {
    this.queue.push(...tracks);
    this.emit();
  }

  remove(index) {
    this.queue.splice(index, 1);
    this.emit();
  }

  move(from, to) {
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    this.emit();
  }

  clear() {
    this.queue = [];
    this.emit();
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.emit();
  }

  setEnabled(on) {
    this.enabled = on;
    clearInterval(this.timer);
    if (on) {
      this.timer = setInterval(() => this.tick(), 200);
      this.tick();
    } else if (this.fading) {
      cancelAnimationFrame(this.fading.raf);
      this.fading = null;
    }
    this.emit();
  }

  sideOf(deck) {
    return this.decks.indexOf(deck) === 0 ? -1 : 1;
  }

  async tick() {
    if (!this.enabled || this.busy) return;
    const [a, b] = this.decks;
    const playing = [a, b].filter((d) => d.playing);
    if (playing.length === 0) {
      if (!this.queue.length) return;
      this.busy = true;
      const deck = a;
      const ok = await deck.load(this.queue.shift());
      this.emit();
      this.busy = false;
      if (!ok) return;
      this.engine.setCrossfader(this.sideOf(deck));
      deck.play();
      return;
    }
    if (this.fading) return;
    const current = playing.length === 1 ? playing[0] : playing.reduce((x, y) => (x.remaining > y.remaining ? x : y));
    const next = current === a ? b : a;
    // precarica il prossimo brano con largo anticipo
    if (!next.playing && this.queue.length && (!next.loaded || next.track === current.track || next._automixDone)) {
      if (current.remaining < this.mixLength + 40 && !this.busy) {
        this.busy = true;
        const ok = await next.load(this.queue.shift());
        next._automixDone = false;
        this.emit();
        this.busy = false;
        if (ok) next.seek(next.cuePoint);
      }
      return;
    }
    const tempo = current.tempo || 1;
    if (!next.playing && next.loaded && !next._automixDone && current.remaining / tempo <= this.mixLength) {
      if (next.bpm && current.bpm) next.sync(current);
      next.play();
      if (current.bpm && next.bpm) next.alignPhase(current);
      this.fade(current, next);
    }
  }

  fade(from, to) {
    const startX = this.engine.crossfader;
    const endX = this.sideOf(to);
    const duration = Math.max(1, Math.min(this.mixLength, from.remaining / (from.tempo || 1))) * 1000;
    const t0 = performance.now();
    const step = () => {
      if (!this.fading) return;
      const k = Math.min(1, (performance.now() - t0) / duration);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * k);
      this.engine.setCrossfader(startX + (endX - startX) * eased);
      if (k < 1) {
        this.fading.raf = requestAnimationFrame(step);
      } else {
        this.fading = null;
        from.pause();
        from._automixDone = true;
        to._automixDone = false;
        this.emit();
      }
    };
    this.fading = { raf: requestAnimationFrame(step) };
  }
}
