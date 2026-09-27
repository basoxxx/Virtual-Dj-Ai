// Gamepad (Xbox, PlayStation, Switch Pro, 8BitDo…) come console DJ tramite la Gamepad API.
// Layout "standard": A/✕ play A, B/○ play B, X/□ cue A, Y/△ cue B, LB/RB sync A/B,
// grilletti = crossfader, stick = jog, croce = libreria/caricamento, Start = AI DJ, Select = mixa ora.

export const GAMEPAD_LAYOUT = [
  ['A / ✕', 'Play/Pausa deck A'],
  ['B / ○', 'Play/Pausa deck B'],
  ['X / □', 'Cue deck A'],
  ['Y / △', 'Cue deck B'],
  ['LB / L1 · RB / R1', 'Sync deck A · deck B'],
  ['LT / L2 ↔ RT / R2', 'Crossfader (A ↔ B)'],
  ['Stick sinistro / destro', 'Jog deck A / B (pitch bend o ricerca)'],
  ['Pressione stick', 'Loop 4 battute A / B'],
  ['Croce ↑ ↓', 'Scorri la libreria'],
  ['Croce ← →', 'Carica il brano selezionato su A / B'],
  ['Start / Options', 'AI DJ on/off'],
  ['Select / Share', 'AI DJ: mixa ora'],
];

// indici del layout "standard" della Gamepad API
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export class GamepadController extends EventTarget {
  constructor(actions) {
    super();
    this.actions = actions;
    this.enabled = true;
    this.prev = new Map();
    this.lastXf = null;
    this.repeat = 0;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
    if (this.supported) {
      window.addEventListener('gamepadconnected', (e) => this.dispatchEvent(new CustomEvent('connected', { detail: e.gamepad.id })));
      window.addEventListener('gamepaddisconnected', () => this.dispatchEvent(new CustomEvent('disconnected')));
    }
  }

  get pads() {
    if (!this.supported) return [];
    return [...navigator.getGamepads()].filter(Boolean);
  }

  run(id, ...args) {
    const a = this.actions.get(id);
    if (a) a.run(...args);
  }

  /** Da chiamare a ogni frame. */
  poll() {
    if (!this.enabled) return;
    for (const pad of this.pads) {
      const prev = this.prev.get(pad.index) || [];
      const pressed = pad.buttons.map((b) => b.pressed);
      const edge = (i) => pressed[i] && !prev[i];
      const release = (i) => !pressed[i] && prev[i];

      if (edge(BTN.A)) this.run('A.play', true);
      if (edge(BTN.B)) this.run('B.play', true);
      if (edge(BTN.X)) this.run('A.cue', true);
      if (release(BTN.X)) this.run('A.cue', false);
      if (edge(BTN.Y)) this.run('B.cue', true);
      if (release(BTN.Y)) this.run('B.cue', false);
      if (edge(BTN.LB)) this.run('A.sync', true);
      if (edge(BTN.RB)) this.run('B.sync', true);
      if (edge(BTN.LS)) this.run('A.loop4', true);
      if (edge(BTN.RS)) this.run('B.loop4', true);
      if (edge(BTN.LEFT)) this.run('A.load', true);
      if (edge(BTN.RIGHT)) this.run('B.load', true);
      if (edge(BTN.START)) this.run('automix', true);
      if (edge(BTN.SELECT)) this.run('aiMixNow', true);

      // scorrimento libreria con ripetizione quando si tiene premuto
      const dir = pressed[BTN.DOWN] ? 1 : pressed[BTN.UP] ? -1 : 0;
      if (dir) {
        if (edge(BTN.DOWN) || edge(BTN.UP) || ++this.repeat > 12) {
          this.run('browse', dir);
          if (this.repeat > 12) this.repeat = 9;
        }
      } else {
        this.repeat = 0;
      }

      // grilletti analogici: crossfader
      const lt = pad.buttons[BTN.LT] ? pad.buttons[BTN.LT].value : 0;
      const rt = pad.buttons[BTN.RT] ? pad.buttons[BTN.RT].value : 0;
      if (lt > 0.02 || rt > 0.02) {
        const xf = (rt - lt + 1) / 2;
        if (this.lastXf === null || Math.abs(xf - this.lastXf) > 0.004) {
          this.run('xfader', xf);
          this.lastXf = xf;
        }
      } else {
        this.lastXf = null;
      }

      // stick: jog
      const lx = pad.axes[0] || 0;
      const rx = pad.axes[2] || 0;
      if (Math.abs(lx) > 0.2) this.run('A.jog', Math.round(lx * 6));
      if (Math.abs(rx) > 0.2) this.run('B.jog', Math.round(rx * 6));

      this.prev.set(pad.index, pressed);
    }
  }
}
