// Scorciatoie da tastiera.

export const SHORTCUTS = [
  ['Q / W', 'Deck A: CUE / PLAY-PAUSA'],
  ['E', 'Deck A: SYNC'],
  ['1 – 4', 'Deck A: hot cue 1–4 (Shift = cancella)'],
  ['A / S', 'Deck A: nudge − / +'],
  ['Z / X', 'Deck A: loop 4 battute / esci dal loop'],
  ['I / O', 'Deck B: CUE / PLAY-PAUSA'],
  ['P', 'Deck B: SYNC'],
  ['7 – 0', 'Deck B: hot cue 1–4 (Shift = cancella)'],
  ['K / L', 'Deck B: nudge − / +'],
  ['N / M', 'Deck B: loop 4 battute / esci dal loop'],
  ['← / →', 'Crossfader verso A / B'],
  ['↓', 'Crossfader al centro'],
  ['Shift + ← / →', 'Carica il brano selezionato su A / B'],
  ['F5 – F12', 'Pad del sampler 1–8'],
  ['Spazio', 'Microfono on air (tieni premuto)'],
  ['Ctrl/Cmd + F', 'Cerca nella libreria'],
  ['Ctrl/Cmd + R', 'Avvia/ferma registrazione'],
  ['Ctrl/Cmd + M', 'Automix on/off'],
  ['Ctrl/Cmd + ,', 'Impostazioni'],
  ['F1', 'Questa guida'],
];

export function installKeyboard(app) {
  const [A, B] = app.decks;
  const held = new Set();
  const down = {
    KeyQ: () => A.cueDown(),
    KeyW: () => A.togglePlay(),
    KeyE: () => A.sync(B),
    KeyA: () => A.bend(-4),
    KeyS: () => A.bend(4),
    KeyZ: () => A.autoLoop(4),
    KeyX: () => A.loop.active && A.setLoopActive(false),
    KeyI: () => B.cueDown(),
    KeyO: () => B.togglePlay(),
    KeyP: () => B.sync(A),
    KeyK: () => B.bend(-4),
    KeyL: () => B.bend(4),
    KeyN: () => B.autoLoop(4),
    KeyM: () => B.loop.active && B.setLoopActive(false),
    ArrowDown: () => app.engine.setCrossfader(0),
    Space: () => app.mic.setOnAir(true),
  };
  const up = {
    KeyQ: () => A.cueUp(),
    KeyI: () => B.cueUp(),
    KeyA: () => A.bend(0),
    KeyS: () => A.bend(0),
    KeyK: () => B.bend(0),
    KeyL: () => B.bend(0),
    Space: () => app.mic.setOnAir(false),
  };
  const hot = { Digit1: [A, 0], Digit2: [A, 1], Digit3: [A, 2], Digit4: [A, 3], Digit7: [B, 0], Digit8: [B, 1], Digit9: [B, 2], Digit0: [B, 3] };

  const typing = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyF') {
      e.preventDefault();
      app.library.focusSearch();
      return;
    }
    if (mod && e.code === 'Comma') {
      e.preventDefault();
      app.openSettings();
      return;
    }
    if (!app.api.isElectron && mod && e.code === 'KeyR') {
      e.preventDefault();
      app.toggleRecording();
      return;
    }
    if (mod && e.code === 'KeyM' && !app.api.isElectron) {
      e.preventDefault();
      app.automix.setEnabled(!app.automix.enabled);
      return;
    }
    if (e.code === 'F1') {
      e.preventDefault();
      app.openSettings('keys');
      return;
    }
    if (typing(e) || mod || e.altKey) return;
    if (/^F([5-9]|1[0-2])$/.test(e.code)) {
      e.preventDefault();
      if (!e.repeat) app.sampler.trigger(Number(e.code.slice(1)) - 5);
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      if (e.shiftKey) {
        const t = app.library.selectedTracks()[0];
        if (t) app.loadTrack(t, e.code === 'ArrowLeft' ? 'A' : 'B');
      } else {
        app.engine.setCrossfader(app.engine.crossfader + (e.code === 'ArrowLeft' ? -0.1 : 0.1));
      }
      return;
    }
    if (e.repeat) {
      if (e.code === 'Space') e.preventDefault();
      return;
    }
    if (hot[e.code]) {
      const [deck, i] = hot[e.code];
      if (e.shiftKey) deck.deleteHotcue(i);
      else deck.hotcue(i);
      return;
    }
    const fn = down[e.code];
    if (fn) {
      e.preventDefault();
      held.add(e.code);
      fn();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    const fn = up[e.code];
    if (fn) fn();
  });
  window.addEventListener('blur', () => {
    for (const code of held) if (up[code]) up[code]();
    held.clear();
  });
}
