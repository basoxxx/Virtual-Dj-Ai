// Finestra impostazioni: periferiche audio locali, preferenze mixer/deck, MIDI learn, tastiera, info.
import { el, button, select, toast } from './controls.js';
import { AudioEngine } from '../audio/engine.js';
import { SHORTCUTS } from '../keyboard.js';

export async function openSettings(app, initialTab = 'audio') {
  document.querySelectorAll('.settings-overlay').forEach((o) => o.remove());
  const overlay = el('div', { class: 'modal-overlay settings-overlay' });
  const modal = el('div', { class: 'modal settings' });
  const tabs = el('div', { class: 'tabs' });
  const body = el('div', { class: 'settings-body' });
  const close = () => {
    app.midi.cancelLearn();
    overlay.remove();
    document.removeEventListener('keydown', onEsc, true);
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onEsc, true);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });

  const pages = {
    audio: { label: 'Audio I/O', render: () => audioPage(app) },
    mixer: { label: 'Mixer & Deck', render: () => mixerPage(app) },
    midi: { label: 'Controller MIDI', render: () => midiPage(app) },
    keys: { label: 'Tastiera', render: () => keysPage() },
    about: { label: 'Informazioni', render: () => aboutPage(app) },
  };
  const tabBtns = {};
  const show = async (id) => {
    for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle('on', k === id);
    body.replaceChildren(el('div', { class: 'hint' }, 'Caricamento…'));
    body.replaceChildren(await pages[id].render());
  };
  for (const [id, p] of Object.entries(pages)) {
    tabBtns[id] = button(p.label, { className: 'tab', onClick: () => show(id) });
    tabs.append(tabBtns[id]);
  }
  modal.append(el('div', { class: 'modal-head' }, el('div', { class: 'modal-title' }, 'Impostazioni'), button('✕', { className: 'tiny ghost', onClick: close })), tabs, body);
  overlay.append(modal);
  document.body.append(overlay);
  show(initialTab);
}

function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control, hint ? el('span', { class: 'field-hint' }, hint) : null);
}

async function audioPage(app) {
  const s = app.settings.audio;
  let { outputs, inputs } = await AudioEngine.devices();
  const hasLabels = [...outputs, ...inputs].some((d) => d.label);
  const wrap = el('div', { class: 'settings-page' });
  const outOpts = () => [{ value: '', label: 'Predefinita di sistema' }, ...outputs.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Uscita ${i + 1}` }))];
  const inOpts = () => [{ value: 'default', label: 'Predefinito di sistema' }, ...inputs.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Ingresso ${i + 1}` }))];

  const apply = async () => {
    await app.engine.applyRouting({ mode: s.mode, masterDevice: s.masterDevice, headphoneDevice: s.headphoneDevice });
    app.saveSettings();
  };
  const mode = select([
    { value: 'single', label: 'Master e cuffia su uscite separate (o solo master)' },
    { value: 'split', label: 'Una sola scheda: Master a SINISTRA, Cuffia a DESTRA (mono)' },
  ], s.mode, (v) => {
    s.mode = v;
    apply();
  });
  const master = select(outOpts(), s.masterDevice, (v) => {
    s.masterDevice = v;
    apply();
  });
  const hp = select([{ value: '', label: 'Nessuna (preascolto disattivato)' }, ...outOpts().slice(1)], s.headphoneDevice, (v) => {
    s.headphoneDevice = v;
    apply();
  });
  const mic = select(inOpts(), s.micDevice || 'default', async (v) => {
    s.micDevice = v;
    app.saveSettings();
    if (app.mic.stream) {
      try {
        await app.mic.open(v);
        if (app.mic.onAir) app.mic.setOnAir(true);
      } catch (err) {
        toast(`Microfono: ${err.message}`, 'error');
      }
    } else {
      app.mic.deviceId = v;
    }
  });
  const latency = select([
    { value: 'interactive', label: 'Bassa (consigliata per DJ)' },
    { value: 'balanced', label: 'Bilanciata' },
    { value: 'playback', label: 'Alta (PC lenti, massima stabilità)' },
  ], s.latency, (v) => {
    s.latency = v;
    app.saveSettings();
    toast('La latenza verrà applicata al prossimo avvio');
  });
  const refresh = button('Rileva periferiche', { className: 'small', onClick: async () => {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach((t) => t.stop());
    } catch {
      // permesso negato: si mostrano comunque le periferiche senza nome
    }
    ({ outputs, inputs } = await AudioEngine.devices());
    master.setOptions(outOpts(), s.masterDevice);
    hp.setOptions([{ value: '', label: 'Nessuna (preascolto disattivato)' }, ...outOpts().slice(1)], s.headphoneDevice);
    mic.setOptions(inOpts(), s.micDevice || 'default');
    app.refreshInputs();
  } });
  const ctx = app.engine.ctx;
  wrap.append(
    el('div', { class: 'section-title' }, 'Uscite'),
    field('Modalità di uscita', mode, 'Con una scheda DJ a 4 canali scegli uscite diverse per master e cuffia. Con la scheda del PC usa lo split con un cavo sdoppiatore.'),
    field('Uscita master (casse)', master),
    field('Uscita cuffia (preascolto)', hp),
    el('div', { class: 'section-title' }, 'Ingressi'),
    field('Microfono', mic, 'Usato dal canale MIC del mixer (on air, talkover, eco).'),
    el('div', { class: 'field-hint' }, 'Per mixare giradischi, lettori CD o strumenti esterni scegli "Linea: …" nel selettore sorgente in basso a ogni deck.'),
    el('div', { class: 'section-title' }, 'Motore'),
    field('Latenza', latency),
    el('div', { class: 'field-hint' }, `Frequenza di campionamento: ${ctx.sampleRate} Hz · Latenza di uscita: ${(app.engine.outputLatency * 1000).toFixed(1)} ms`),
    el('div', { class: 'row' }, refresh, hasLabels ? null : el('span', { class: 'field-hint' }, 'Premi "Rileva periferiche" per vedere i nomi delle schede audio.')),
  );
  return wrap;
}

function checkbox(label, value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(value);
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check' }, input, label);
}

function mixerPage(app) {
  const m = app.settings.mixer;
  const save = () => {
    app.applyMixerSettings();
    app.saveSettings();
  };
  const range = (min, max, step, value, fmt, onChange) => {
    const out = el('span', { class: 'range-val' }, fmt(value));
    const input = el('input', { type: 'range', class: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      onChange(Number(input.value));
    });
    return el('div', { class: 'row tight' }, input, out);
  };
  return el('div', { class: 'settings-page' },
    el('div', { class: 'section-title' }, 'Mixer'),
    field('Curva crossfader', select([{ value: 'smooth', label: 'Morbida (mix)' }, { value: 'linear', label: 'Lineare' }, { value: 'cut', label: 'Taglio netto (scratch)' }], m.xfCurve, (v) => {
      m.xfCurve = v;
      save();
    })),
    checkbox('Auto-gain: normalizza il volume dei brani (in base all\'analisi)', m.autoGain, (v) => {
      m.autoGain = v;
      save();
    }),
    checkbox('Limiter sul master (evita distorsioni)', m.limiter, (v) => {
      m.limiter = v;
      save();
    }),
    el('div', { class: 'section-title' }, 'Deck'),
    field('Range pitch predefinito', select([8, 16, 25, 50, 100].map((r) => ({ value: String(r), label: `±${r}%` })), String(m.pitchRange), (v) => {
      m.pitchRange = Number(v);
      save();
    })),
    checkbox('Keylock attivo di default', m.keylock, (v) => {
      m.keylock = v;
      save();
    }),
    checkbox('Quantize (cue e loop agganciati alla battuta)', m.quantize, (v) => {
      m.quantize = v;
      save();
    }),
    checkbox('Modalità vinile (scratch col jog)', m.vinyl, (v) => {
      m.vinyl = v;
      save();
    }),
    checkbox('Impedisci di caricare un brano su un deck in riproduzione', m.lockPlaying, (v) => {
      m.lockPlaying = v;
      save();
    }),
    field('Frenata allo stop (effetto vinile)', range(0, 2, 0.05, m.brakeTime, (v) => (v ? `${v.toFixed(2)} s` : 'immediato'), (v) => {
      m.brakeTime = v;
      save();
    })),
    field('Partenza del piatto', range(0, 1.5, 0.05, m.startTime, (v) => (v ? `${v.toFixed(2)} s` : 'immediata'), (v) => {
      m.startTime = v;
      save();
    })),
  );
}

function midiPage(app) {
  const midi = app.midi;
  const wrap = el('div', { class: 'settings-page' });
  if (!midi.supported || !midi.access) {
    wrap.append(el('div', { class: 'hint' }, 'MIDI non disponibile su questo sistema o nessun permesso concesso.'));
    return wrap;
  }
  const devices = el('div', { class: 'midi-devices' });
  const renderDevices = () => {
    devices.replaceChildren(...(midi.inputs.length ? midi.inputs.map((i) => el('div', { class: 'midi-dev' }, `🎛 ${i.name} ${i.manufacturer ? `(${i.manufacturer})` : ''}`)) : [el('div', { class: 'hint' }, 'Nessun controller collegato. Collegalo via USB: verrà rilevato automaticamente.')]));
  };
  renderDevices();
  midi.addEventListener('devices', renderDevices);
  const monitor = el('div', { class: 'midi-monitor' }, 'Ultimo messaggio: —');
  midi.addEventListener('message', (e) => {
    monitor.textContent = `Ultimo messaggio: ${e.detail.key} = ${e.detail.raw}`;
  });
  const table = el('div', { class: 'midi-table' });
  const rows = new Map();
  for (const [id, action] of app.actions) {
    const keyEl = el('span', { class: 'midi-key' }, midi.keyFor(id) || '—');
    const learn = button('Learn', { className: 'small', onClick: () => {
      if (midi.learning === id) midi.cancelLearn();
      else midi.learn(id);
    } });
    const clear = button('×', { className: 'tiny ghost', title: 'Rimuovi mappatura', onClick: () => midi.clear(id) });
    const row = el('div', { class: 'midi-row' }, el('span', { class: 'midi-label' }, action.label), el('span', { class: 'midi-kind' }, action.kind), keyEl, learn, clear);
    rows.set(id, { row, keyEl, learn });
    table.append(row);
  }
  const refresh = () => {
    for (const [id, r] of rows) {
      r.keyEl.textContent = midi.keyFor(id) || '—';
      r.learn.classList.toggle('on', midi.learning === id);
      r.learn.textContent = midi.learning === id ? 'Muovi un controllo…' : 'Learn';
    }
  };
  midi.addEventListener('learning', refresh);
  midi.addEventListener('mapping', () => {
    refresh();
    app.saveSettings();
  });
  wrap.append(
    el('div', { class: 'section-title' }, 'Dispositivi'), devices, monitor,
    el('div', { class: 'section-title' }, 'Mappature (MIDI learn)'),
    el('div', { class: 'hint' }, 'Premi "Learn" e muovi il pulsante/manopola del controller. Per i jog usa encoder relativi.'),
    table);
  return wrap;
}

function keysPage() {
  return el('div', { class: 'settings-page' },
    el('div', { class: 'section-title' }, 'Scorciatoie da tastiera'),
    el('div', { class: 'keys-table' }, SHORTCUTS.map(([k, d]) => el('div', { class: 'key-row' }, el('kbd', {}, k), el('span', {}, d)))));
}

async function aboutPage(app) {
  const info = await app.api.appInfo();
  return el('div', { class: 'settings-page about' },
    el('div', { class: 'about-logo' }, 'VIRTUAL DJ AI'),
    el('div', {}, `Versione ${info.version}`),
    el('div', { class: 'field-hint' }, `${info.platform} ${info.arch} · Electron ${info.electron}`),
    el('p', {}, 'Software DJ open source: 2 deck con scratch, keylock e sync, mixer a 3 bande con filtri, 2 effetti per deck, sampler, microfono, ingressi linea dalla scheda audio, uscita cuffia separata, controller MIDI, registrazione del mix e automix.'),
    el('p', { class: 'field-hint' }, 'Le nuove versioni vengono pubblicate automaticamente su GitHub Releases a ogni aggiornamento del ramo main.'));
}
