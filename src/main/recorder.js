// Registrazione del mix su disco: i campioni PCM a 16 bit arrivano a blocchi e si scrivono subito, così anche set di
// ore non riempiono la memoria. Il file nasce nella cartella dati dell'utente (registrazioni-non-salvate) e lì resta
// finché non si salva altrove: annullare il salvataggio, chiudere l'app o un crash non cancellano mai un set.
const fs = require('node:fs');
const path = require('node:path');
const { fsErrorText } = require('./errors');

const RECOVERY_DIR = 'registrazioni-non-salvate';
// RIFF/WAVE (12) + JUNK riservato per ds64 (36) + fmt (24) + intestazione dei dati (8)
const HEADER_BYTES = 80;
// accanto al file finché la registrazione non è stata consegnata all'utente: se c'è all'avvio, il set è stato interrotto
const MARKER = '.incorso';

/**
 * Intestazione WAV a 16 bit. Sotto i 4 GiB è un WAV normale con un blocco JUNK (i lettori lo saltano); oltre
 * (set di più di circa 6 ore a 48 kHz) il JUNK diventa ds64 e il file RF64, così niente si tronca.
 */
function wavHeader(dataBytes, sampleRate, channels) {
  const b = Buffer.alloc(HEADER_BYTES);
  const riffSize = HEADER_BYTES - 8 + dataBytes;
  const rf64 = riffSize > 0xffffffff;
  b.write(rf64 ? 'RF64' : 'RIFF', 0);
  b.writeUInt32LE(rf64 ? 0xffffffff : riffSize, 4);
  b.write('WAVE', 8);
  b.write(rf64 ? 'ds64' : 'JUNK', 12);
  b.writeUInt32LE(28, 16);
  if (rf64) {
    b.writeBigUInt64LE(BigInt(riffSize), 20);
    b.writeBigUInt64LE(BigInt(dataBytes), 28);
    b.writeBigUInt64LE(BigInt(Math.floor(dataBytes / (channels * 2))), 36);
    b.writeUInt32LE(0, 44); // nessuna tabella
  }
  b.write('fmt ', 48);
  b.writeUInt32LE(16, 52);
  b.writeUInt16LE(1, 56);
  b.writeUInt16LE(channels, 58);
  b.writeUInt32LE(sampleRate, 60);
  b.writeUInt32LE(sampleRate * channels * 2, 64);
  b.writeUInt16LE(channels * 2, 68);
  b.writeUInt16LE(16, 70);
  b.write('data', 72);
  b.writeUInt32LE(rf64 ? 0xffffffff : dataBytes, 76);
  return b;
}

function writeAll(fd, buf, position = null) {
  let off = 0;
  while (off < buf.length) {
    off += fs.writeSync(fd, buf, off, buf.length - off, position === null ? null : position + off);
  }
}

/** Nuova registrazione in dir: Mix-<data e ora>.wav. */
function startRecording(dir, { sampleRate, channels }) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let file;
  let fd;
  for (let n = 1; fd === undefined; n++) {
    file = path.join(dir, `Mix-${stamp}${n > 1 ? `-${n}` : ''}.wav`);
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  try {
    writeAll(fd, wavHeader(0, sampleRate, channels));
    fs.writeFileSync(file + MARKER, '');
  } catch (err) {
    // es. disco pieno: niente descrittori aperti né file vuoti senza marcatore
    try {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      fs.rmSync(file + MARKER, { force: true });
    } catch {
      // resta un file vuoto: non contiene niente da perdere
    }
    throw new Error(`Non riesco a creare il file della registrazione in ${dir} (${fsErrorText(err)})`);
  }
  return { file, fd, sampleRate, channels, bytes: 0, error: null, closed: false };
}

/**
 * Scrive un blocco. Un errore (disco pieno, disco scollegato) non si lancia: la registrazione si ferma lì, il file
 * resta valido con quanto scritto e si restituisce, solo la prima volta, il messaggio per l'utente.
 */
function writeChunk(rec, buf) {
  if (rec.error || rec.closed) return null;
  try {
    writeAll(rec.fd, buf);
    rec.bytes += buf.length;
    return null;
  } catch (err) {
    rec.error = err;
    return err.code === 'ENOSPC' || err.code === 'EDQUOT'
      ? `Disco pieno: registrazione fermata. Il file contiene il mix fino a questo punto (${rec.file})`
      : `Scrittura su disco non riuscita (${fsErrorText(err)}): registrazione fermata. Il file contiene il mix fino a questo punto (${rec.file})`;
  }
}

/** Intestazione con i byte scritti davvero e chiusura. Si può chiamare più volte (stop, uscita, crash dell'interfaccia). */
function finalizeRecording(rec) {
  if (rec.closed) return;
  rec.closed = true;
  try {
    // si riscrive sopra l'intestazione iniziale: non serve spazio libero
    writeAll(rec.fd, wavHeader(rec.bytes - (rec.bytes % (rec.channels * 2)), rec.sampleRate, rec.channels), 0);
  } finally {
    fs.closeSync(rec.fd);
  }
}

/** La registrazione è stata consegnata all'utente (salvata, o gli si è detto dove resta): non va più segnalata. */
function clearMarker(rec) {
  fs.rmSync(rec.file + MARKER, { force: true });
}

/** Rifà l'intestazione dalla dimensione del file (dopo un crash l'intestazione dice 0 byte). */
function repairHeader(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (head.toString('ascii', 48, 52) !== 'fmt ') throw new Error('intestazione sconosciuta');
    const channels = head.readUInt16LE(58);
    const sampleRate = head.readUInt32LE(60);
    let bytes = Math.max(0, fs.fstatSync(fd).size - HEADER_BYTES);
    bytes -= bytes % (channels * 2); // un blocco scritto a metà non si suona
    fs.ftruncateSync(fd, HEADER_BYTES + bytes);
    writeAll(fd, wavHeader(bytes, sampleRate, channels), 0);
  } finally {
    fs.closeSync(fd);
  }
}

/** All'avvio: registrazioni interrotte (uscita durante la registrazione, crash) rese di nuovo ascoltabili. */
function recoverInterrupted(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // nessuna registrazione finora
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(MARKER)).sort()) {
    const file = path.join(dir, name.slice(0, -MARKER.length));
    try {
      repairHeader(file);
      out.push(file);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Recupero della registrazione ${file} non riuscito:`, err);
        out.push(file); // c'è comunque: meglio dirlo
      }
    }
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return out;
}

/** Sposta la registrazione dove l'ha scelta l'utente. Se non riesce, il file resta dov'è e l'errore lo dice. */
function saveRecording(file, dest) {
  try {
    fs.renameSync(file, dest);
    return dest;
  } catch {
    // altro disco: si copia, e l'originale si toglie solo a copia riuscita
  }
  try {
    fs.copyFileSync(file, dest);
  } catch (err) {
    try {
      fs.rmSync(dest, { force: true }); // copia a metà
    } catch {
      // resta la copia incompleta, ma l'originale è intatto
    }
    throw new Error(`Non sono riuscito a salvare la registrazione in ${dest} (${fsErrorText(err)}): è ancora in ${file}`);
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error(`Copia di ${file} non tolta dopo il salvataggio:`, err);
  }
  return dest;
}

module.exports = {
  RECOVERY_DIR, HEADER_BYTES, wavHeader, startRecording, writeChunk, finalizeRecording, clearMarker, recoverInterrupted, saveRecording,
};
