// Visualizzazione forme d'onda: vista scorrevole con beatgrid e vista d'insieme del brano.

const HOTCUE_COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ff375f'];
export { HOTCUE_COLORS };

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

function bandColor(wf, i, alpha = 1) {
  const l = wf.low[i];
  const m = wf.mid[i];
  const h = wf.high[i];
  const c = Math.max(l, m, h, 1e-6);
  const r = Math.round(40 + 215 * (l / c) ** 1.2);
  const g = Math.round(40 + 190 * (m / c) ** 1.4);
  const b = Math.round(60 + 195 * (h / c) ** 1.1);
  return `rgba(${r},${g},${b},${alpha})`;
}

export class ScrollingWaveform {
  constructor(canvas, deck, accent) {
    this.canvas = canvas;
    this.deck = deck;
    this.accent = accent;
    this.span = 8; // secondi visibili
    this.g = canvas.getContext('2d');
    this.drag = null;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.span = Math.max(1.5, Math.min(40, this.span * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  zoom(factor) {
    this.span = Math.max(1.5, Math.min(40, this.span * factor));
  }

  onDown(e) {
    if (!this.deck.loaded || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { x: e.clientX, t: performance.now(), startPos: this.deck.position, playing: this.deck.playing };
    if (this.deck.playing) this.deck.jogTouch(true);
  }

  onMove(e) {
    if (!this.drag || !this.canvas.hasPointerCapture(e.pointerId)) return;
    const secPerPx = this.span / this.canvas.clientWidth;
    const now = performance.now();
    if (this.drag.playing) {
      const dx = e.clientX - this.drag.x;
      const dt = Math.max(1, now - this.drag.t) / 1000;
      this.deck.jogScratch((-dx * secPerPx) / dt);
      this.drag.x = e.clientX;
      this.drag.t = now;
      clearTimeout(this.drag.idle);
      this.drag.idle = setTimeout(() => this.deck.jogScratch(0), 50);
    } else {
      const dx = e.clientX - this.drag.x;
      this.deck.seek(this.drag.startPos - dx * secPerPx);
    }
  }

  onUp(e) {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    clearTimeout(this.drag.idle);
    if (this.drag.playing) this.deck.jogTouch(false);
    this.drag = null;
  }

  draw() {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const g = this.g;
    const deck = this.deck;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const mid = h / 2;
    if (!deck.loaded) {
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.font = `500 ${12 * dpr}px Inter, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(deck.lineDevice ? 'INGRESSO LINEA ATTIVO' : deck.loading ? 'Caricamento…' : `Deck ${deck.id} vuoto — trascina qui un brano`, w / 2, mid + 4 * dpr);
      return;
    }
    const pos = deck.position;
    const span = this.span;
    const t0 = pos - span / 2;
    const secPerPx = span / w;
    const wf = deck.waveform;

    // loop
    if (deck.loop.out > deck.loop.in) {
      const x1 = (deck.loop.in - t0) / secPerPx;
      const x2 = (deck.loop.out - t0) / secPerPx;
      g.fillStyle = deck.loop.active ? 'rgba(48,209,88,0.16)' : 'rgba(255,255,255,0.06)';
      g.fillRect(x1, 0, x2 - x1, h);
    }

    if (wf) {
      const bps = wf.binsPerSecond;
      for (let x = 0; x < w; x++) {
        const ta = t0 + x * secPerPx;
        if (ta < 0 || ta > deck.duration) continue;
        const b0 = Math.floor(ta * bps);
        const b1 = Math.max(b0 + 1, Math.floor((ta + secPerPx) * bps));
        let pk = 0;
        let best = b0;
        for (let b = b0; b < b1 && b < wf.length; b++) {
          if (wf.peak[b] > pk) {
            pk = wf.peak[b];
            best = b;
          }
        }
        if (best >= wf.length) continue;
        const amp = pk * (mid - 2 * dpr);
        g.fillStyle = bandColor(wf, best, ta < pos ? 0.55 : 1);
        g.fillRect(x, mid - amp, 1, amp * 2);
      }
    } else {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.font = `500 ${11 * dpr}px Inter, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText('Analisi forma d\'onda…', w / 2, mid - 10 * dpr);
    }

    // beatgrid
    if (deck.bpm) {
      const beat = deck.beatLength;
      const first = Math.ceil((t0 - deck.gridOffset) / beat);
      for (let n = first; ; n++) {
        const t = deck.gridOffset + n * beat;
        if (t > t0 + span) break;
        const x = (t - t0) / secPerPx;
        const bar = ((n % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
        g.fillRect(Math.round(x), 0, bar ? 2 * dpr : 1 * dpr, bar ? h : 8 * dpr);
        if (!bar) g.fillRect(Math.round(x), h - 8 * dpr, 1 * dpr, 8 * dpr);
      }
    }

    // cue e hot cue
    const marker = (t, color, label) => {
      const x = (t - t0) / secPerPx;
      if (x < -20 || x > w + 20) return;
      g.fillStyle = color;
      g.fillRect(x, 0, 2 * dpr, h);
      if (label) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 14 * dpr, 0);
        g.lineTo(x + 14 * dpr, 10 * dpr);
        g.lineTo(x, 14 * dpr);
        g.fill();
        g.fillStyle = '#000';
        g.font = `700 ${9 * dpr}px Inter, system-ui, sans-serif`;
        g.textAlign = 'left';
        g.fillText(label, x + 3 * dpr, 9 * dpr);
      }
    };
    marker(deck.cuePoint, '#ffffff', 'C');
    deck.hotcues.forEach((c, i) => c != null && marker(c, HOTCUE_COLORS[i], String(i + 1)));

    // testina
    g.fillStyle = this.accent;
    g.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
    g.beginPath();
    g.moveTo(w / 2 - 6 * dpr, 0);
    g.lineTo(w / 2 + 6 * dpr, 0);
    g.lineTo(w / 2, 7 * dpr);
    g.fill();
  }
}

export class OverviewWaveform {
  constructor(canvas, deck, accent) {
    this.canvas = canvas;
    this.deck = deck;
    this.accent = accent;
    this.g = canvas.getContext('2d');
    this.cache = null;
    this.cacheKey = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!deck.loaded) return;
      const r = canvas.getBoundingClientRect();
      const seekTo = ((e.clientX - r.left) / r.width) * deck.duration;
      deck.seek(seekTo);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!canvas.hasPointerCapture(e.pointerId)) return;
      const r = canvas.getBoundingClientRect();
      deck.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * deck.duration);
    });
  }

  renderCache(w, h) {
    const wf = this.deck.waveform;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * wf.length);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * wf.length));
      let pk = 0;
      let best = b0;
      for (let b = b0; b < b1 && b < wf.length; b++) {
        if (wf.peak[b] > pk) {
          pk = wf.peak[b];
          best = b;
        }
      }
      g.fillStyle = bandColor(wf, Math.min(best, wf.length - 1));
      const amp = pk * (mid - 1);
      g.fillRect(x, mid - amp, 1, amp * 2);
    }
    return off;
  }

  draw() {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const g = this.g;
    const deck = this.deck;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    if (!deck.loaded) return;
    const key = deck.waveform ? `${w}x${h}:${deck.track && deck.track.id}:${deck.waveform.length}` : null;
    if (key && key !== this.cacheKey) {
      this.cache = this.renderCache(w, h);
      this.cacheKey = key;
    }
    if (key && this.cache) g.drawImage(this.cache, 0, 0);
    const px = (t) => (t / deck.duration) * w;
    const x = px(deck.position);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, x, h);
    if (deck.loop.out > deck.loop.in) {
      g.fillStyle = deck.loop.active ? 'rgba(48,209,88,0.32)' : 'rgba(255,255,255,0.12)';
      g.fillRect(px(deck.loop.in), 0, Math.max(2, px(deck.loop.out) - px(deck.loop.in)), h);
    }
    deck.hotcues.forEach((c, i) => {
      if (c == null) return;
      g.fillStyle = HOTCUE_COLORS[i];
      g.fillRect(px(c), 0, 2 * dpr, h);
    });
    g.fillStyle = '#fff';
    g.fillRect(px(deck.cuePoint), h - 5 * dpr, 2 * dpr, 5 * dpr);
    // avviso di fine brano
    const warn = deck.remaining < 30 && deck.playing && Math.floor(performance.now() / 400) % 2 === 0;
    g.fillStyle = warn ? '#ff453a' : this.accent;
    g.fillRect(x - dpr, 0, 2 * dpr, h);
  }
}
