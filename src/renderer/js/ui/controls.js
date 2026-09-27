// Controlli grafici riutilizzabili: manopole, fader, pulsanti, VU meter.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx, cy, r, from, to) {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Manopola: trascina in verticale (Shift = fine), rotella, doppio clic = valore di default.
 */
export function knob({ label = '', min = 0, max = 1, value = 0, def = value, bipolar = false, size = 38, color = 'var(--accent)', format, onChange }) {
  const wrap = el('div', { class: 'knob', title: label });
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const track = document.createElementNS(svgNS, 'path');
  track.setAttribute('d', arc(20, 20, 16, -135, 135));
  track.setAttribute('class', 'knob-track');
  const fill = document.createElementNS(svgNS, 'path');
  fill.setAttribute('class', 'knob-fill');
  fill.style.stroke = color;
  const body = document.createElementNS(svgNS, 'circle');
  body.setAttribute('cx', 20);
  body.setAttribute('cy', 20);
  body.setAttribute('r', 11.5);
  body.setAttribute('class', 'knob-body');
  const pointer = document.createElementNS(svgNS, 'line');
  pointer.setAttribute('x1', 20);
  pointer.setAttribute('y1', 20);
  pointer.setAttribute('x2', 20);
  pointer.setAttribute('y2', 10);
  pointer.setAttribute('class', 'knob-pointer');
  svg.append(track, fill, body, pointer);
  const valueLabel = el('div', { class: 'knob-value' });
  wrap.append(svg);
  if (label) wrap.append(el('div', { class: 'knob-label' }, label));
  wrap.append(valueLabel);

  let current = value;
  const render = () => {
    const t = (current - min) / (max - min);
    const deg = -135 + t * 270;
    const startDeg = bipolar ? 0 : -135;
    if (Math.abs(deg - startDeg) < 0.5) fill.setAttribute('d', '');
    else fill.setAttribute('d', deg > startDeg ? arc(20, 20, 16, startDeg, deg) : arc(20, 20, 16, deg, startDeg));
    pointer.setAttribute('transform', `rotate(${deg} 20 20)`);
    valueLabel.textContent = format ? format(current) : '';
  };
  const set = (v, notify = true) => {
    const nv = clamp(v, min, max);
    if (bipolar && Math.abs(nv - def) < (max - min) * 0.015) current = def;
    else current = nv;
    render();
    if (notify && onChange) onChange(current);
  };

  let startY = 0;
  let startV = 0;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    wrap.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startV = current;
    wrap.classList.add('active');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!wrap.hasPointerCapture(e.pointerId)) return;
    const range = e.shiftKey ? 900 : 180;
    set(startV + ((startY - e.clientY) / range) * (max - min));
  });
  const end = (e) => {
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
    wrap.classList.remove('active');
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('dblclick', () => set(def));
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(current - Math.sign(e.deltaY) * (max - min) * (e.shiftKey ? 0.005 : 0.03));
  }, { passive: false });

  render();
  wrap.setValue = (v) => set(v, false);
  wrap.getValue = () => current;
  wrap.set = set;
  return wrap;
}

/**
 * Fader lineare verticale o orizzontale. `invert` porta il minimo in alto (pitch stile Technics).
 */
export function fader({ vertical = true, min = 0, max = 1, value = 0, def = value, invert = false, className = '', center = false, onChange }) {
  const wrap = el('div', { class: `fader ${vertical ? 'vertical' : 'horizontal'} ${className}` });
  const track = el('div', { class: 'fader-track' });
  const thumb = el('div', { class: 'fader-thumb' });
  if (center) wrap.append(el('div', { class: 'fader-center' }));
  wrap.append(track, thumb);
  let current = value;
  const ratio = () => {
    let t = (current - min) / (max - min);
    if (invert) t = 1 - t;
    return t;
  };
  const render = () => {
    const t = ratio();
    if (vertical) thumb.style.top = `${(1 - t) * 100}%`;
    else thumb.style.left = `${t * 100}%`;
  };
  const set = (v, notify = true) => {
    current = clamp(v, min, max);
    render();
    if (notify && onChange) onChange(current);
  };
  const fromEvent = (e, rect) => {
    let t = vertical ? 1 - (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
    t = clamp(t, 0, 1);
    if (invert) t = 1 - t;
    return min + t * (max - min);
  };
  let dragOffset = 0;
  let fine = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    wrap.setPointerCapture(e.pointerId);
    const rect = wrap.getBoundingClientRect();
    if (e.target === thumb) {
      dragOffset = fromEvent(e, rect) - current;
    } else {
      dragOffset = 0;
      set(fromEvent(e, rect));
    }
    fine = e.shiftKey ? { start: current, y: e.clientY, x: e.clientX } : null;
    wrap.classList.add('active');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!wrap.hasPointerCapture(e.pointerId)) return;
    const rect = wrap.getBoundingClientRect();
    if (fine) {
      const px = vertical ? fine.y - e.clientY : e.clientX - fine.x;
      const len = vertical ? rect.height : rect.width;
      set(fine.start + ((invert ? -px : px) / len) * (max - min) * 0.1);
    } else {
      set(fromEvent(e, rect) - dragOffset);
    }
  });
  const end = (e) => {
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
    wrap.classList.remove('active');
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('dblclick', () => set(def));
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = -Math.sign(e.deltaY) * (invert ? -1 : 1);
    set(current + dir * (max - min) * (e.shiftKey ? 0.002 : 0.02));
  }, { passive: false });
  requestAnimationFrame(render);
  render();
  wrap.setValue = (v) => set(v, false);
  wrap.getValue = () => current;
  wrap.set = set;
  return wrap;
}

export function button(label, { className = '', title = '', onClick, onDown, onUp, toggle = false } = {}) {
  const b = el('button', { class: `btn ${className}`, title, type: 'button' }, label);
  if (onClick) b.addEventListener('click', (e) => onClick(e));
  if (onDown) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      b.setPointerCapture(e.pointerId);
      onDown(e);
    });
  }
  if (onUp) {
    const up = (e) => {
      if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
      onUp(e);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }
  if (toggle) b.setAttribute('aria-pressed', 'false');
  b.setOn = (on) => {
    b.classList.toggle('on', Boolean(on));
    if (toggle) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  return b;
}

/** VU meter a segmenti su canvas (stereo). */
export function vuMeter({ segments = 24, width = 14, height = 160, horizontal = false } = {}) {
  const canvas = el('canvas', { class: 'vu' });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const g = canvas.getContext('2d');
  const colorAt = (t) => (t > 0.9 ? '#ff453a' : t > 0.72 ? '#ffd60a' : '#30d158');
  const toT = (lvl) => {
    const db = 20 * Math.log10(lvl + 1e-9);
    return clamp((db + 48) / 51, 0, 1); // -48 dB .. +3 dB
  };
  canvas.draw = ({ levels, peaks }) => {
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    const gap = 1 * dpr;
    for (let ch = 0; ch < 2; ch++) {
      const t = toT(levels[ch]);
      const pt = toT(peaks[ch]);
      for (let s = 0; s < segments; s++) {
        const st = (s + 0.5) / segments;
        const lit = st <= t;
        const isPeak = Math.abs(st - pt) < 0.5 / segments;
        g.fillStyle = lit || isPeak ? colorAt(st) : '#232326';
        if (horizontal) {
          const segW = (W - gap * (segments - 1)) / segments;
          const hh = (H - gap) / 2;
          g.fillRect(s * (segW + gap), ch * (hh + gap), segW, hh);
        } else {
          const segH = (H - gap * (segments - 1)) / segments;
          const ww = (W - gap) / 2;
          g.fillRect(ch * (ww + gap), H - (s + 1) * segH - s * gap, ww, segH);
        }
      }
    }
  };
  return canvas;
}

export function select(options, value, onChange, className = '') {
  const s = el('select', { class: className });
  const fill = (opts, v) => {
    s.innerHTML = '';
    for (const o of opts) s.append(el('option', { value: o.value }, o.label));
    if (v != null) s.value = v;
  };
  fill(options, value);
  s.addEventListener('change', () => onChange && onChange(s.value));
  s.setOptions = fill;
  return s;
}

export function toast(message, type = 'info', ms = 3500) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const t = el('div', { class: `toast ${type}` }, message);
  host.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

/** Finestra di input testuale (window.prompt non è disponibile in Electron). */
export function askText(title, initial = '') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', class: 'ask-input', value: initial });
    const close = (value) => {
      overlay.remove();
      resolve(value);
    };
    const overlay = el('div', { class: 'modal-overlay ask' },
      el('div', { class: 'modal small' },
        el('div', { class: 'modal-title' }, title),
        input,
        el('div', { class: 'row end' },
          button('Annulla', { onClick: () => close(null) }),
          button('OK', { className: 'primary', onClick: () => close(input.value) }))));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

export function confirmDialog(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = el('div', { class: 'modal-overlay ask' },
      el('div', { class: 'modal small' },
        el('div', { class: 'modal-title' }, message),
        el('div', { class: 'row end' },
          button('Annulla', { onClick: () => close(false) }),
          button(okLabel, { className: 'primary', onClick: () => close(true) }))));
    document.body.append(overlay);
  });
}
