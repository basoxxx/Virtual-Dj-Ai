// Richieste dal pubblico: dopo "Cerca online" si guarda la cartella dei download e ogni file audio nuovo
// (da qualsiasi sito, anche da Drive) si importa appena il browser ha finito di scriverlo.
const fs = require('node:fs');
const path = require('node:path');
const { fsErrorText } = require('./errors');

// file ancora in scaricamento: Chrome/Edge, Firefox, Safari, Opera e altri programmi
const PARTIAL = /\.(crdownload|part|partial|download|opdownload|tmp|temp)$/i;

function isPartialDownload(name) {
  return PARTIAL.test(name) || name.startsWith('.') || name.startsWith('~$');
}

/** Cosa non va nel modello dell'indirizzo di ricerca (null = va bene). Lo chiede anche la pagina Richieste (requests:checkSite). */
function searchTemplateProblem(template) {
  const t = String(template || '').trim();
  if (!t) return 'scrivi l\'indirizzo della pagina dei risultati';
  if (!/^https?:\/\/[^/\s]/i.test(t)) return 'l\'indirizzo deve iniziare con https://';
  try {
    new URL(t.replace('{q}', 'x'));
  } catch {
    return 'indirizzo non valido';
  }
  if (!t.includes('{q}')) return 'manca {q}, il posto del testo cercato';
  return null;
}

/** Indirizzo di ricerca: {q} nel modello diventa il testo cercato. */
function searchUrl(template, query) {
  const problem = searchTemplateProblem(template);
  if (problem) throw new Error(`Indirizzo di ricerca non valido: ${problem} (Impostazioni → Richieste)`);
  const t = String(template).trim();
  const q = encodeURIComponent(String(query || '').trim());
  return q ? t.replace('{q}', q) : new URL(t.replace('{q}', '')).origin;
}

class DownloadWatcher {
  /**
   * @param {object} o
   * @param {(file: string) => boolean} o.accept file da importare (es. solo audio)
   * @param {(file: string) => void} o.onFile file completo, con dimensione stabile
   * @param {(file: string) => void} [o.onIgnored] file completo che non si importa (es. un .zip)
   * @param {number} [o.settleMs] quanto deve restare uguale la dimensione prima di considerarlo finito
   * @param {number} [o.timeoutMs] dopo quanto smette di guardare da solo
   * @param {(info: { reason: 'stop'|'timeout'|'error', message?: string }) => void} [o.onStop]
   */
  constructor({ accept, onFile, onIgnored = () => {}, settleMs = 1200, timeoutMs = 30 * 60 * 1000, onStop = () => {} }) {
    this.accept = accept;
    this.onFile = onFile;
    this.onIgnored = onIgnored;
    this.settleMs = settleMs;
    this.timeoutMs = timeoutMs;
    this.onStop = onStop;
    this.watcher = null;
    this.folder = null;
    this.known = new Map(); // nome -> mtime al momento dell'avvio (i file già presenti non contano)
    this.pending = new Map(); // nome -> timer del controllo di stabilità
    this.done = new Set();
  }

  get active() {
    return Boolean(this.watcher);
  }

  start(folder) {
    this.stop(false);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Cartella dei download non trovata: ${folder}`);
    this.folder = folder;
    this.known.clear();
    this.done.clear();
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch (err) {
      const mac = process.platform === 'darwin' && (err.code === 'EPERM' || err.code === 'EACCES')
        ? ': su macOS consenti l\'accesso a Segueo in Impostazioni di Sistema → Privacy e sicurezza → File e cartelle'
        : '';
      throw new Error(`Non riesco a leggere la cartella dei download ${folder} (${fsErrorText(err)})${mac}`);
    }
    for (const name of names) {
      try {
        this.known.set(name, fs.statSync(path.join(folder, name)).mtimeMs);
      } catch {
        // file sparito nel frattempo
      }
    }
    this.watcher = fs.watch(folder, (_event, name) => name && this.check(String(name)));
    this.watcher.on('error', (err) => this.stop({
      reason: 'error',
      message: `Ho smesso di guardare i download: la cartella ${folder} non si legge più (${fsErrorText(err)}). Premi di nuovo Cerca online`,
    }));
    // alcuni sistemi non segnalano le rinomine: un giro di controllo ogni tanto
    this.sweep = setInterval(() => {
      try {
        for (const name of fs.readdirSync(folder)) this.check(name);
      } catch {
        // cartella non leggibile per un attimo
      }
    }, 2000);
    this.armTimeout();
    return folder;
  }

  armTimeout() {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.stop({
      reason: 'timeout',
      message: `Ho smesso di guardare i download (${Math.round(this.timeoutMs / 60000)} minuti senza file nuovi): premi di nuovo Cerca online`,
    }), this.timeoutMs);
  }

  check(name) {
    if (!this.watcher || this.done.has(name) || this.pending.has(name) || isPartialDownload(name)) return;
    const file = path.join(this.folder, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (this.known.has(name) && this.known.get(name) === st.mtimeMs) return; // c'era già prima
    const wanted = this.accept(file);
    let last = -1;
    const poll = () => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        this.pending.delete(name);
        return;
      }
      if (size > 0 && size === last) {
        this.pending.delete(name);
        this.done.add(name);
        this.armTimeout();
        // un file che non si importa (es. un album in .zip) si segnala: l'interfaccia promette che arriva tutto
        if (wanted) this.onFile(file);
        else this.onIgnored(file);
        return;
      }
      last = size;
      this.pending.set(name, setTimeout(poll, this.settleMs));
    };
    this.pending.set(name, setTimeout(poll, this.settleMs));
  }

  /** why: perché si ferma (per chi aspetta i brani); false = fermata dall'utente, nessun avviso. */
  stop(why = { reason: 'stop' }) {
    const was = this.active;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    clearInterval(this.sweep);
    clearTimeout(this.timeout);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    if (was && why) this.onStop(why);
  }
}

module.exports = { DownloadWatcher, isPartialDownload, searchUrl, searchTemplateProblem };
