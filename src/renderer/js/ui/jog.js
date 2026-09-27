// Jog wheel: piatto rotante con scratch (modalità vinile) o pitch bend.
const SECONDS_PER_REV = 1.8; // 33⅓ giri/min

export class JogWheel {
  constructor(canvas, deck, accent) {
    this.canvas = canvas;
    this.deck = deck;
    this.accent = accent;
    this.g = canvas.getContext('2d');
    this.coverImg = null;
    this.drag = null;
    deck.addEventListener('cover', (e) => this.setCover(e.detail));
    deck.addEventListener('loaded', () => this.setCover(null));
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      deck.jogTurn(-Math.sign(e.deltaY) * (e.shiftKey ? 0.02 : 0.1));
    }, { passive: false });
  }

  setCover(src) {
    if (!src) {
      this.coverImg = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.coverImg = img;
    };
    img.src = src;
  }

  angleOf(e) {
    const r = this.canvas.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  }

  onDown(e) {
    if (e.button !== 0 || !this.deck.loaded) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { a: this.angleOf(e), t: performance.now(), scratch: this.deck.vinyl };
    if (this.drag.scratch) this.deck.jogTouch(true);
  }

  onMove(e) {
    if (!this.drag || !this.canvas.hasPointerCapture(e.pointerId)) return;
    const a = this.angleOf(e);
    let da = a - this.drag.a;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    const now = performance.now();
    const dt = Math.max(1, now - this.drag.t) / 1000;
    const revs = da / (2 * Math.PI);
    if (this.drag.scratch) {
      this.deck.jogScratch((revs * SECONDS_PER_REV) / dt);
      clearTimeout(this.drag.idle);
      this.drag.idle = setTimeout(() => this.deck.jogScratch(0), 45);
    } else {
      this.deck.jogTurn(revs * 2);
    }
    this.drag.a = a;
    this.drag.t = now;
  }

  onUp(e) {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    clearTimeout(this.drag.idle);
    if (this.drag.scratch) this.deck.jogTouch(false);
    this.drag = null;
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(this.canvas.clientWidth * dpr);
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    const g = this.g;
    const c = size / 2;
    g.clearRect(0, 0, size, size);
    const deck = this.deck;
    const R = c - 3 * dpr;
    // anello esterno con avanzamento del brano
    g.lineWidth = 4 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.stroke();
    if (deck.loaded) {
      const prog = deck.position / deck.duration;
      g.strokeStyle = deck.remaining < 30 ? '#ff3b3b' : this.accent;
      g.beginPath();
      g.arc(c, c, R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      g.stroke();
    }
    // piatto
    const grad = g.createRadialGradient(c, c, R * 0.2, c, c, R * 0.92);
    grad.addColorStop(0, '#262a33');
    grad.addColorStop(1, '#101217');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(c, c, R * 0.9, 0, Math.PI * 2);
    g.fill();
    // solchi
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    for (let r = R * 0.45; r < R * 0.88; r += 4 * dpr) {
      g.beginPath();
      g.arc(c, c, r, 0, Math.PI * 2);
      g.stroke();
    }
    const angle = deck.loaded ? ((deck.position / SECONDS_PER_REV) % 1) * Math.PI * 2 : 0;
    g.save();
    g.translate(c, c);
    g.rotate(angle);
    // etichetta centrale / copertina
    const labelR = R * 0.4;
    g.beginPath();
    g.arc(0, 0, labelR, 0, Math.PI * 2);
    g.closePath();
    if (this.coverImg) {
      g.save();
      g.clip();
      g.drawImage(this.coverImg, -labelR, -labelR, labelR * 2, labelR * 2);
      g.restore();
    } else {
      g.fillStyle = this.accent;
      g.globalAlpha = 0.85;
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = '#0d0f14';
      g.font = `bold ${Math.round(labelR * 0.8)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(deck.id, 0, 0);
    }
    // indicatore di rotazione
    g.fillStyle = '#fff';
    g.fillRect(-1.5 * dpr, -R * 0.88, 3 * dpr, R * 0.3);
    g.restore();
    g.fillStyle = '#0d0f14';
    g.beginPath();
    g.arc(c, c, 4 * dpr, 0, Math.PI * 2);
    g.fill();
    if (this.drag && this.drag.scratch) {
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(c, c, R * 0.9, 0, Math.PI * 2);
      g.stroke();
    }
  }
}
