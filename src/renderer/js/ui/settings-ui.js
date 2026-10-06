// Finestra impostazioni: periferiche audio locali, preferenze mixer/deck, MIDI learn, tastiera, info.
import { el, button, select, toast } from './controls.js';
import { AudioEngine } from '../audio/engine.js';
import { SHORTCUTS } from '../keyboard.js';
import { PRESETS, TIERS } from '../controllers/presets.js';
import { GAMEPAD_LAYOUT } from '../controllers/gamepad.js';
import { icon, withIcon } from './icons.js';
import { configureAnalysis, BEAT_MODEL } from '../audio/analyzer-client.js';
import { CHAT_MODEL } from '../ai/chat-model.js';
import { SEARCH_SITES, DEFAULT_REQUESTS } from './requests-ui.js';
import { api } from '../api.js';

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
    ai: { label: 'AI', render: () => aiPage(app) },
    midi: { label: 'Console DJ', render: () => midiPage(app) },
    requests: { label: 'Richieste', render: () => requestsPage(app) },
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
  modal.append(el('div', { class: 'modal-head' }, el('div', { class: 'modal-title' }, 'Impostazioni'), button(icon('close', 14), { className: 'tiny ghost', title: 'Chiudi', onClick: close })), tabs, body);
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

  const outInfo = el('span', { class: 'field-hint' });
  const showOutputs = (outputs, quad) => {
    outInfo.textContent = `Uscite della scheda master: ${outputs}${quad ? ' · cuffia sulle uscite 3-4 ✓' : ''}`;
  };
  const maxOut = app.engine.ctx.destination.maxChannelCount;
  showOutputs(maxOut, s.mode === 'quad' && maxOut >= 4);
  const apply = async () => {
    const res = await app.engine.applyRouting({ mode: s.mode, masterDevice: s.masterDevice, headphoneDevice: s.headphoneDevice });
    hpField.style.display = s.mode === 'single' ? '' : 'none';
    if (res) showOutputs(res.outputs, res.quad);
    app.saveSettings();
  };
  const mode = select([
    { value: 'single', label: 'Master e cuffia su uscite separate (o solo master)' },
    { value: 'quad', label: 'Console con scheda a 4 uscite (es. Hercules Inpulse): Master 1-2, Cuffia 3-4' },
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
  const hpField = field('Uscita cuffia (preascolto)', hp);
  hpField.style.display = s.mode === 'single' ? '' : 'none';
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
    field('Modalità di uscita', mode, 'Con una console che ha la scheda audio a 4 uscite (Hercules Inpulse 300/500/T7…) scegli "Master 1-2, Cuffia 3-4" e come uscita master la console. Con la scheda del PC usa lo split con un cavo sdoppiatore.'),
    field('Uscita master (casse)', master),
    hpField,
    outInfo,
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
    checkbox('Hot cue a deck fermo: salta e parte subito (come CDJ, Serato, rekordbox)', m.hotcuePlay !== false, (v) => {
      m.hotcuePlay = v;
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

function aiPage(app) {
  const ai = app.settings.ai;
  const save = () => {
    app.saveSettings();
    app.sideUI.refreshAutomix();
  };
  const engineStatus = el('div', { class: 'ai-test' });
  const showEngineStatus = async () => {
    if (ai.analysisEngine !== 'ai') {
      engineStatus.textContent = '';
      return;
    }
    let installed = false;
    try {
      installed = (await fetch(`models/${BEAT_MODEL}`, { method: 'HEAD' })).ok;
    } catch {
      installed = false;
    }
    engineStatus.textContent = installed ? 'Modello Segueo Analisi battute installato' : 'Modello Segueo Analisi battute non installato: si usa l\'analisi classica';
    engineStatus.className = `ai-test ${installed ? 'ok' : 'warn'}`;
  };
  const engine = select([
    { value: 'ai', label: 'AI (Segueo Analisi battute)' },
    { value: 'classic', label: 'Classico' },
  ], ai.analysisEngine, (v) => {
    ai.analysisEngine = v;
    configureAnalysis({ engine: v });
    save();
    showEngineStatus();
    // con l'AI i brani già analizzati vengono rifiniti in background
    if (v === 'ai' && ai.autoAnalyze && app.analyzer && app.library) app.analyzer.run(app.library.lib.tracks);
  });
  showEngineStatus();
  const refine = select([
    { value: 'library', label: 'Su tutta la libreria, in background' },
    { value: 'deck', label: 'Solo quando il brano va su un deck (molto più veloce)' },
  ], ai.refine || 'library', (v) => {
    ai.refine = v;
    configureAnalysis({ refine: v });
    save();
    if (v === 'library' && ai.autoAnalyze && app.analyzer && app.library && !app.analyzer.running) app.analyzer.run(app.library.lib.tracks);
    if (app.sideUI) app.sideUI.refreshAnalysis();
  });
  const chatStatus = el('div', { class: 'ai-test' });
  fetch(`models/${CHAT_MODEL}`, { method: 'HEAD' }).then((r) => r.ok, () => false).then((ok) => {
    chatStatus.textContent = ok ? 'Modello Segueo Chat installato' : 'Modello Segueo Chat non installato: SegueoChat capisce solo i comandi dell\'interprete';
    chatStatus.className = `ai-test ${ok ? 'ok' : 'warn'}`;
  });
  const auto = el('input', { type: 'checkbox' });
  auto.checked = ai.autoAnalyze;
  auto.addEventListener('change', () => {
    ai.autoAnalyze = auto.checked;
    save();
  });
  return el('div', { class: 'settings-page' },
    el('div', { class: 'section-title' }, 'AI DJ integrata'),
    el('p', { class: 'field-hint' }, 'L\'AI DJ funziona sempre, anche offline: analizza BPM, tonalità, energia e struttura dei brani, sceglie il successivo in modo armonico, trova il punto di mix sulle frasi musicali e crea transizioni (bass swap, filtro, echo out, dissolvenza, tagli a raffica o con il modello AI, in stile dance o techno) muovendo mixer ed effetti. Si attiva dal pannello "AI DJ" o con Ctrl+M.'),
    el('label', { class: 'check' }, auto, 'Analizza automaticamente i nuovi brani della libreria in background'),
    field('Motore di analisi', engine, 'L\'analisi classica dà subito BPM e forma d\'onda; con l\'AI, Segueo Analisi battute (una rete neurale che gira sul computer, solo con la CPU) rifinisce poi in background battute, battuta forte e struttura. Se il modello manca o dà errore resta l\'analisi classica. Le griglie corrette a mano non vengono toccate.'),
    engineStatus,
    field('Rifinitura AI delle battute', refine, 'La rete neurale è la parte lenta dell\'analisi (circa 3/4 del tempo). Su tutta la libreria è pronta prima della serata; "solo sui deck" la fa quando il brano viene caricato (l\'AI DJ prepara il prossimo con minuti di anticipo): con migliaia di brani su un computer lento l\'analisi della libreria diventa circa 4 volte più breve. BPM, tonalità ed energia ci sono comunque per tutti i brani.'),
    el('div', { class: 'section-title' }, 'Vista'),
    field('Vista all\'avvio', select([
      { value: 'last', label: 'L\'ultima usata' },
      { value: 'console', label: 'Console classica' },
      { value: 'ai', label: 'Vista AI (mix automatico e mashup)' },
    ], app.settings.ui.startView || 'last', (v) => {
      app.settings.ui.startView = v;
      app.saveSettings();
    }), 'La vista si cambia in ogni momento con Console | AI in alto o con Ctrl+Shift+A. L\'AI DJ si accende solo quando lo decidi tu, in qualsiasi vista.'),
    el('div', { class: 'section-title' }, 'SegueoChat'),
    el('p', { class: 'field-hint' }, 'Nella scheda CHAT (o con Ctrl+K) dici all\'AI DJ come suonare. I comandi li capisce un interprete integrato, i tanti altri modi di dirlo il modello Segueo Chat: entrambi girano sul computer, senza internet, e nessun messaggio esce dal PC.'),
    chatStatus);
}

function requestsPage(app) {
  const r = app.requests ? app.requests.settings : (app.settings.requests = { ...DEFAULT_REQUESTS, ...(app.settings.requests || {}) });
  const save = () => app.saveSettings();
  const custom = el('input', { type: 'text', placeholder: 'https://sito.com/cerca?q={q}', value: r.custom || '' });
  custom.addEventListener('keydown', (e) => e.stopPropagation());
  custom.addEventListener('change', () => {
    r.custom = custom.value.trim();
    save();
  });
  const customRow = field('Indirizzo di ricerca', custom, 'Apri il sito dove scarichi i brani, cerca qualcosa e copia qui l\'indirizzo della pagina dei risultati, mettendo {q} al posto del testo cercato.');
  customRow.hidden = r.site !== 'custom';
  const site = select(SEARCH_SITES, r.site, (v) => {
    r.site = v;
    customRow.hidden = v !== 'custom';
    save();
  });
  const folderLabel = el('span', { class: 'field-hint' }, '');
  const showFolder = async () => {
    folderLabel.textContent = r.folder || `${await api.defaultDownloadFolder()} (cartella Download del sistema)`;
  };
  showFolder();
  const folderBtns = el('div', { class: 'row tight' },
    button('Cambia…', { className: 'small', onClick: async () => {
      const f = await api.pickDownloadFolder();
      if (f) {
        r.folder = f;
        save();
        showFolder();
      }
    } }),
    button('Predefinita', { className: 'small', onClick: () => {
      r.folder = '';
      save();
      showFolder();
    } }));
  return el('div', { class: 'settings-page' },
    el('div', { class: 'section-title' }, 'Richieste dal pubblico'),
    el('p', { class: 'field-hint' }, 'Ti chiedono un brano che non hai? Scrivilo nella ricerca della libreria e premi "Cerca online": si apre il browser e Segueo aspetta nella cartella dei download. Ogni file audio che scarichi (da qualsiasi sito, anche da Google Drive) entra da solo in libreria, viene analizzato subito e lo metti come prossimo, in coda o su un deck con un clic. Usa siti da cui hai il diritto di scaricare: negozi, record pool per DJ, i tuoi file.'),
    field('Cerca su', site, 'Il sito che si apre con "Cerca online". Va bene qualsiasi browser: si usa quello predefinito del computer.'),
    customRow,
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Cartella dei download'), folderLabel, folderBtns));
}

function midiPage(app) {
  const midi = app.midi;
  const wrap = el('div', { class: 'settings-page' });

  // --- console collegate
  const devices = el('div', { class: 'midi-devices' });
  const renderDevices = () => {
    const list = midi.devices();
    const pads = app.gamepad ? app.gamepad.pads : [];
    const rows = list.map((d) => el('div', { class: 'midi-dev' },
      el('span', { class: 'dev-name' }, icon('sliders', 15), d.name),
      d.preset
        ? el('span', { class: `tier-badge ${d.preset.tier}`, title: d.preset.verified ? 'Mappa verificata sul modello' : d.preset.community ? 'Mappa della comunità misurata sulla console, ancora in prova' : 'Profilo generico della marca: se un comando non risponde correggilo con Learn' },
          `${d.preset.brand} ${d.preset.name} · ${TIERS[d.preset.tier]}${d.preset.verified ? ' · ✓ mappa verificata' : d.preset.community ? ' · mappa della comunità' : ''}`)
        : el('span', { class: 'tier-badge none' }, 'profilo non trovato: usa la procedura guidata')));
    for (const p of pads) rows.push(el('div', { class: 'midi-dev' }, el('span', { class: 'dev-name' }, icon('gamepad', 15), p.id), el('span', { class: 'tier-badge home' }, 'Gamepad')));
    if (!rows.length) {
      rows.push(el('div', { class: 'hint' }, midi.access
        ? 'Nessuna console collegata. Collegala via USB: verrà riconosciuta automaticamente.'
        : 'MIDI non disponibile su questo sistema (i gamepad funzionano comunque).'));
    }
    devices.replaceChildren(...rows);
  };
  renderDevices();
  midi.addEventListener('devices', renderDevices);

  // --- profilo
  const groups = Object.keys(TIERS).map((tier) => ({ tier, items: PRESETS.filter((p) => p.tier === tier) }));
  const presetSel = el('select', {});
  presetSel.append(el('option', { value: 'auto' }, 'Automatico (riconosce la console collegata)'));
  presetSel.append(el('option', { value: 'none' }, 'Nessuno (solo mappature personali)'));
  for (const g of groups) {
    const og = el('optgroup', { label: TIERS[g.tier] });
    for (const p of g.items) og.append(el('option', { value: p.id }, `${p.brand} ${p.name}`));
    presetSel.append(og);
  }
  presetSel.value = midi.presetMode;
  presetSel.addEventListener('change', () => {
    midi.setPresetMode(presetSel.value);
    app.saveSettings();
    app.updateMidiBadge();
    refresh();
  });

  // --- procedura guidata
  const wizardBox = el('div', { class: 'wizard-box' });
  const renderWizard = (info) => {
    if (!midi.wizard) {
      wizardBox.replaceChildren(
        button(withIcon('compass', 'Procedura guidata di mappatura'), { className: 'small primary', onClick: () => midi.startWizard() }),
        el('span', { class: 'field-hint' }, info && info.done ? '✓ Mappatura completata e salvata' : 'Per qualsiasi console non in elenco: ti chiede un controllo alla volta.'));
      return;
    }
    const id = midi.learning;
    const action = app.actions.get(id);
    wizardBox.replaceChildren(
      el('div', { class: 'wizard-step' }, `Passo ${midi.wizard.index + 1}/${midi.wizard.steps.length}: `, el('b', {}, action ? action.label : id),
        el('span', { class: 'field-hint' }, action && action.kind === 'button' ? ' — premi il pulsante' : ' — muovi il controllo')),
      button('Salta', { className: 'small', onClick: () => midi.skipWizardStep() }),
      button('Fine', { className: 'small', onClick: () => midi.stopWizard(true) }));
  };
  renderWizard();
  midi.addEventListener('wizard', (e) => renderWizard(e.detail));

  // --- import / export
  const exportBtn = button('Esporta mappatura', { className: 'small', onClick: () => {
    const blob = new Blob([midi.exportMapping()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mappatura-console.segueo.json';
    a.click();
  } });
  const importBtn = button('Importa…', { className: 'small', onClick: () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      try {
        const n = midi.importMapping(await input.files[0].text());
        presetSel.value = midi.presetMode;
        toast(`Mappatura importata: ${n} controlli`, 'ok');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    input.click();
  } });
  const resetBtn = button('Azzera personalizzazioni', { className: 'small', onClick: () => {
    midi.clearAll();
    refresh();
  } });
  // correzioni messe da parte quando il profilo della console è stato aggiornato
  const restoreBtn = button('Ripristina correzioni', { className: 'small', title: 'Rimette le correzioni fatte prima dell\'aggiornamento del profilo della console', onClick: () => {
    const backup = app.settings.midi.backup;
    if (!backup) return;
    midi.mapping = { ...backup, ...midi.mapping };
    app.settings.midi.backup = null;
    midi.dispatchEvent(new CustomEvent('mapping', { detail: midi.mapping }));
    restoreBtn.style.display = 'none';
    toast('Correzioni ripristinate', 'ok');
  } });
  if (!app.settings.midi.backup) restoreBtn.style.display = 'none';

  // --- gamepad
  const gp = el('input', { type: 'checkbox' });
  gp.checked = app.gamepad ? app.gamepad.enabled : true;
  gp.addEventListener('change', () => {
    if (app.gamepad) app.gamepad.enabled = gp.checked;
    app.saveSettings();
  });

  const monitor = el('div', { class: 'midi-monitor' }, 'Ultimo messaggio: —');
  midi.addEventListener('message', (e) => {
    monitor.textContent = `Ultimo messaggio: ${e.detail.key} = ${e.detail.raw}${e.detail.device ? ` (${e.detail.device})` : ''}`;
  });

  // --- tabella mappature
  const table = el('div', { class: 'midi-table' });
  const rows = new Map();
  for (const [id, action] of app.actions) {
    const keyEl = el('span', { class: 'midi-key' });
    const learn = button('Learn', { className: 'small', onClick: () => {
      if (midi.learning === id) midi.cancelLearn();
      else midi.learn(id);
    } });
    const inv = button('⇅', { className: 'tiny ghost', title: 'Inverti il verso (per manopole, fader e jog appresi)', onClick: () => midi.toggleInvert(id) });
    if (action.kind === 'button') inv.style.visibility = 'hidden';
    const clear = button('×', { className: 'tiny ghost', title: 'Rimuovi la mappatura personale', onClick: () => midi.clear(id) });
    const row = el('div', { class: 'midi-row' }, el('span', { class: 'midi-label' }, action.label), el('span', { class: 'midi-kind' }, action.kind), keyEl, learn, inv, clear);
    rows.set(id, { keyEl, learn, inv });
    table.append(row);
  }
  const refresh = () => {
    for (const [id, r] of rows) {
      const user = midi.userEntry(id);
      const pk = midi.presetKeyFor(id);
      r.keyEl.textContent = user ? `${user.key}${user.invert ? ' ⇅' : ''}` : pk ? `${pk} (profilo)` : '—';
      r.keyEl.classList.toggle('from-preset', !user && Boolean(pk));
      r.inv.classList.toggle('on', Boolean(user && user.invert));
      r.learn.classList.toggle('on', midi.learning === id);
      r.learn.textContent = midi.learning === id ? 'Muovi un controllo…' : 'Learn';
    }
  };
  refresh();
  midi.addEventListener('learning', refresh);
  midi.addEventListener('mapping', () => {
    refresh();
    app.saveSettings();
  });
  midi.addEventListener('devices', refresh);

  // --- console supportate
  const supported = el('div', { class: 'supported' }, groups.map((g) => el('div', { class: 'supported-col' },
    el('div', { class: `tier-title ${g.tier}` }, TIERS[g.tier]),
    g.items.map((p) => el('div', { class: 'supported-item', title: p.verified ? 'Mappa verificata sul modello' : p.community ? 'Mappa della comunità, in prova' : 'Profilo generico della marca' }, el('b', {}, p.brand), ` ${p.name}`, p.verified ? el('span', { class: 'verified' }, ' ✓') : p.community ? el('span', { class: 'verified' }, ' ◇') : null)))));

  wrap.append(
    el('div', { class: 'section-title' }, 'Console collegate'), devices,
    field('Profilo console', presetSel, 'Il profilo si attiva da solo quando colleghi una console in elenco. Le tue correzioni con Learn hanno sempre la precedenza.'),
    wizardBox,
    el('div', { class: 'row tight' }, exportBtn, importBtn, resetBtn, restoreBtn),
    monitor,
    el('div', { class: 'section-title' }, 'Gamepad (Xbox, PlayStation, Switch…)'),
    el('label', { class: 'check' }, gp, 'Usa il gamepad come console DJ'),
    el('div', { class: 'keys-table' }, GAMEPAD_LAYOUT.map(([k, d]) => el('div', { class: 'key-row' }, el('kbd', {}, k), el('span', {}, d)))),
    el('div', { class: 'section-title' }, 'Console supportate'),
    el('div', { class: 'field-hint' }, '✓ = mappa verificata sul singolo modello (mappature Mixxx o documenti MIDI del produttore); ◇ = mappa della comunità misurata sulla console, ancora in prova. Le altre usano il profilo generico della marca: se un comando non risponde correggilo con Learn.'),
    el('div', { class: 'field-hint' }, 'Le console che non hanno un canale MIDI (es. Traktor Kontrol S2/S3/S4 MK3 in modalità HID) vanno messe in modalità MIDI con il software del produttore, poi mappate con la procedura guidata. Lettori CDJ/XDJ e mixer DJM si possono usare anche come sorgenti audio tramite gli ingressi linea dei deck.'),
    supported,
    el('div', { class: 'section-title' }, 'Mappature'),
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
    el('div', { class: 'about-logo' }, 'SEGUEO'),
    el('div', {}, `Versione ${info.version}`),
    el('div', { class: 'field-hint' }, `${info.platform} ${info.arch} · Electron ${info.electron}`),
    el('p', {}, 'Software DJ open source con AI DJ che mixa in automatico e SegueoChat per dirgli come suonare: 2 deck con scratch, keylock e sync, mixer a 3 bande con filtri, 2 effetti per deck, sampler, microfono, ingressi linea dalla scheda audio, uscita cuffia separata, controller MIDI e registrazione del mix.'),
    el('p', { class: 'field-hint' }, 'Modelli AI di Segueo: Analisi battute (basato su Beat This!, Institute of Computational Perception, JKU Linz, licenza MIT), Transizioni dance e techno (modelli di Segueo), Separazione voce (basato su Demucs v4, Meta, codice con licenza MIT), eseguiti con ONNX Runtime Web (Microsoft, licenza MIT).'),
    updatesSection(app));
}

function updatesSection(app) {
  const u = app.updateUI;
  const wrap = el('div', { class: 'update-settings' }, el('div', { class: 'section-label' }, 'AGGIORNAMENTI'));
  if (!u || !u.supported) {
    wrap.append(el('p', { class: 'field-hint' }, 'Le nuove versioni vengono pubblicate su GitHub Releases a ogni aggiornamento del ramo main.'));
    return wrap;
  }
  const auto = el('input', { type: 'checkbox' });
  auto.checked = u.auto;
  auto.addEventListener('change', () => u.setAuto(auto.checked));
  const status = el('span', { class: 'field-hint' });
  const action = el('div', { class: 'row' });
  const render = () => {
    const i = u.info;
    if (u.state === 'checking') status.textContent = 'Controllo in corso…';
    else if (u.state === 'error') status.textContent = `Controllo non riuscito: ${u.error}`;
    else if (i && i.available) status.textContent = `Disponibile la versione ${i.latest}`;
    else if (i) status.textContent = `Hai l'ultima versione (${i.current})`;
    else status.textContent = '';
    action.replaceChildren(
      button('Verifica ora', { className: 'small', onClick: () => u.check(true) }),
      i && i.available ? button(`Installa ${i.latest}`, { className: 'small primary', onClick: () => u.openDialog() }) : null,
      status);
  };
  u.onChange = () => { if (wrap.isConnected) render(); };
  render();
  wrap.append(
    el('label', { class: 'check' }, auto, 'Controlla e proponi gli aggiornamenti automaticamente'),
    action,
    el('p', { class: 'field-hint' }, 'Il pacchetto viene scaricato da GitHub Releases, verificato con la sua impronta SHA-256 e installato al riavvio.'));
  return wrap;
}
