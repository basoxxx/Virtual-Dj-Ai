// Richieste dal pubblico: dopo "Cerca online" si guarda la cartella dei download e ogni file audio nuovo
// (da qualsiasi sito, anche da Drive) si importa appena il browser ha finito di scriverlo.
const fs = require('node:fs');
const path = require('node:path');

// file ancora in scaricamento: Chrome/Edge, Firefox, Safari, Opera e altri programmi
const PARTIAL = /\.(crdownload|part|partial|download|opdownload|tmp|temp)$/i;

function isPartialDownload(name) {
  return PARTIAL.test(name) || name.startsWith('.') || name.startsWith('~$');
}

/** Indirizzo di ricerca: {q} nel modello diventa il testo cercato. */
function searchUrl(template, query) {
  const q = encodeURIComponent(String(query || '').trim());
  const t = String(template || '').trim() || 'https://www.google.com/search?q={q}';
  if (!/^https?:\/\//i.test(t)) throw new Error('Indirizzo di ricerca non valido');
  return q ? t.replace('{q}', q) : new URL(t).origin;
}

class DownloadWatcher {
  /**
   * @param {object} o
   * @param {(file: string) => boolean} o.accept file da importare (es. solo audio)
   * @param {(file: string) => void} o.onFile file completo, con dimensione stabile
   * @param {number} [o.settleMs] quanto deve restare uguale la dimensione prima di considerarlo finito
   * @param {number} [o.timeoutMs] dopo quanto smette di guardare da solo
   * @param {() => void} [o.onStop]
   */
  constructor({ accept, onFile, settleMs = 1200, timeoutMs = 30 * 60 * 1000, onStop = () => {} }) {
    this.accept = accept;
    this.onFile = onFile;
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
    for (const name of fs.readdirSync(folder)) {
      try {
        this.known.set(name, fs.statSync(path.join(folder, name)).mtimeMs);
      } catch {
        // file sparito nel frattempo
      }
    }
    this.watcher = fs.watch(folder, (_event, name) => name && this.check(String(name)));
    this.watcher.on('error', () => this.stop());
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
    this.timeout = setTimeout(() => this.stop(), this.timeoutMs);
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
    if (!st.isFile() || !this.accept(file)) return;
    if (this.known.has(name) && this.known.get(name) === st.mtimeMs) return; // c'era già prima
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
        this.onFile(file);
        return;
      }
      last = size;
      this.pending.set(name, setTimeout(poll, this.settleMs));
    };
    this.pending.set(name, setTimeout(poll, this.settleMs));
  }

  stop(notify = true) {
    const was = this.active;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    clearInterval(this.sweep);
    clearTimeout(this.timeout);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    if (was && notify) this.onStop();
  }
}

module.exports = { DownloadWatcher, isPartialDownload, searchUrl };
