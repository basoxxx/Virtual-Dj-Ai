// Persistenza JSON semplice e atomica nella cartella dati dell'utente.
// Un file danneggiato (es. blackout durante la scrittura) o illeggibile non si sovrascrive mai in silenzio: si copia
// da parte, si recupera l'ultima copia buona (.bak) e l'errore arriva all'utente (loadError).
const fs = require('node:fs');
const path = require('node:path');
const { fsErrorText } = require('./errors');

// rinomina bloccata per un attimo: su Windows antivirus e indicizzatore tengono aperto il file appena scritto
// (renameRetry serve anche alla migrazione dal vecchio nome)
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetry(from, to, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !RETRY_CODES.has(err.code)) throw err;
      sleepSync(50 * i);
    }
  }
}

function parse(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('contenuto non valido');
  return data;
}

class JsonStore {
  /**
   * delay: attesa (ms) prima di scrivere; più lunga per file grandi aggiornati spesso (libreria).
   * label: nome nei messaggi all'utente ("Libreria"). onError(err): salvataggio in background non riuscito,
   * segnalato una volta sola finché un salvataggio non riesce di nuovo.
   */
  constructor(file, defaults, { delay = 400, label = path.basename(file), onError = null } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.delay = delay;
    this.label = label;
    this.onError = onError;
    this.data = structuredClone(defaults);
    this.timer = null;
    this.loadError = null; // messaggio per l'utente se all'avvio il file non era leggibile
    this.readOnly = false; // file presente ma né letto né copiato da parte: non si sovrascrive
    this.fileGood = false; // sul disco c'è una versione buona: al prossimo salvataggio diventa la copia .bak
    this.failing = false;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      this.data = structuredClone(this.defaults);
      if (err.code === 'ENOENT') return; // prima volta
      // il file c'è ma non si legge (permessi, disco): sovrascriverlo lo perderebbe per sempre
      this.readOnly = true;
      this.loadError = `${this.label}: il file ${this.file} non si legge (${fsErrorText(err)}). Non lo sovrascrivo: le modifiche di questa sessione non verranno salvate. Controlla disco e permessi, poi riapri Segueo`;
      return;
    }
    try {
      this.data = { ...structuredClone(this.defaults), ...parse(raw) };
      this.fileGood = true;
      return;
    } catch (err) {
      // file danneggiato: prima di tutto se ne salva una copia, poi si prova l'ultima versione buona
      const copy = `${this.file}.corrotto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const backup = this.readBackup();
      this.data = backup || structuredClone(this.defaults);
      try {
        fs.copyFileSync(this.file, copy);
      } catch (copyErr) {
        this.readOnly = true;
        this.loadError = `${this.label}: il file ${this.file} è danneggiato e non sono riuscito a copiarlo da parte (${fsErrorText(copyErr)}). Non lo sovrascrivo: le modifiche di questa sessione non verranno salvate`;
        return;
      }
      this.loadError = backup
        ? `${this.label}: il file era danneggiato (${err.message}), ho recuperato l'ultima copia buona. Il file danneggiato è in ${copy}`
        : `${this.label}: il file era danneggiato (${err.message}) e non c'è una copia buona, si riparte da zero. Il file danneggiato è in ${copy}`;
    }
  }

  readBackup() {
    try {
      return { ...structuredClone(this.defaults), ...parse(fs.readFileSync(`${this.file}.bak`, 'utf8')) };
    } catch {
      return null; // nessuna copia, o illeggibile anche quella
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), this.delay);
  }

  /** Salvataggio in background: un errore (disco pieno, permessi) non deve far cadere il processo, si segnala. */
  saveNow() {
    try {
      this.flush();
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        console.error(`Salvataggio di ${this.file} non riuscito:`, err);
        if (this.onError) this.onError(err);
      }
      this.failing = true;
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.readOnly) return; // illeggibile all'avvio: già segnalato, non si sovrascrive
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data));
        // su disco davvero prima della rinomina: dopo un blackout resta il file vecchio o quello nuovo, intero
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (this.fileGood) this.keepBackup();
      renameRetry(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // resta un .tmp: si riscrive al prossimo salvataggio
      }
      throw err;
    }
    this.fileGood = true;
  }

  /** La versione buona sul disco diventa la copia di riserva (.bak): un collegamento, senza copiare decine di MB. */
  keepBackup() {
    const bak = `${this.file}.bak`;
    try {
      fs.rmSync(bak, { force: true });
      try {
        fs.linkSync(this.file, bak);
      } catch {
        fs.copyFileSync(this.file, bak); // file system senza collegamenti (es. FAT)
      }
    } catch (err) {
      // la copia di riserva aiuta ma non è indispensabile: il salvataggio va avanti
      console.error(`Copia di riserva di ${this.file} non riuscita:`, err);
    }
  }
}

module.exports = { JsonStore, renameRetry };
