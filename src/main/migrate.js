// Migrazione dal vecchio nome dell'app ("Virtual DJ AI") al nuovo ("Segueo").
const fs = require('node:fs');
const path = require('node:path');
const { renameRetry } = require('./store');

const LEGACY_NAME = 'Virtual DJ AI';
const LEGACY_BUNDLE = `${LEGACY_NAME}.app`;

// File di Chromium che non vanno copiati: cache rigenerabili e lock della vecchia istanza.
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'Crashpad', 'logs',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

// libreria e impostazioni: se ci sono già, la cartella nuova è in uso (o migrata da una versione precedente)
const GUARD = ['settings.json', 'library.json'];
// esito della migrazione nella cartella nuova: { ok, error, at }
const MARKER = 'migrazione-da-virtual-dj-ai.json';

function readMarker(newDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(newDir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(newDir, state) {
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, MARKER), JSON.stringify({ ...state, at: new Date().toISOString() }));
}

/** Cartella nuova per ogni tentativo, accanto a quella dei dati: quello che ci finisce non si cancella mai. */
function asideDir(newDir) {
  const base = `${newDir}.prima-della-migrazione-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copia la cartella dati del vecchio nome in quella nuova (libreria, impostazioni, mappature MIDI, localStorage).
 * Si copia prima in una cartella temporanea e poi si sposta voce per voce, libreria e impostazioni per ultime: una
 * copia interrotta (permessi, disco pieno) non lascia mezzi dati che sembrano una migrazione finita. Dopo un errore
 * si riprova al prossimo avvio, e quello che la sessione intanto ha scritto si mette da parte (non si cancella).
 * Non fa nulla se la nuova cartella contiene già dati dell'app o se la vecchia non esiste.
 * Restituisce false se non ha copiato, { aside } se ha copiato (aside: dove sono i dati della sessione messi da parte,
 * null se non ce n'erano); lancia l'errore se non ci è riuscita.
 */
function migrateUserData(oldDir, newDir) {
  if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) return false;
  const state = readMarker(newDir);
  if (state && state.ok) return false;
  const retry = Boolean(state);
  if (!retry && GUARD.some((f) => fs.existsSync(path.join(newDir, f)))) return false;
  const tmp = `${newDir}.migrazione`;
  const moved = []; // voci della sessione messe da parte in questo tentativo
  let aside = null;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of fs.readdirSync(oldDir)) {
      if (SKIP.has(name)) continue;
      fs.cpSync(path.join(oldDir, name), path.join(tmp, name), { recursive: true });
    }
    fs.mkdirSync(newDir, { recursive: true });
    const names = fs.readdirSync(tmp).sort((a, b) => GUARD.includes(a) - GUARD.includes(b));
    for (const name of names) {
      const dest = path.join(newDir, name);
      if (fs.existsSync(dest)) {
        if (!retry) continue;
        // scritto dalla sessione dopo il tentativo non riuscito: si sostituisce intero (due database localStorage
        // mescolati si rovinano) e si tiene da parte
        if (!aside) aside = asideDir(newDir);
        const kept = path.join(aside, name);
        renameRetry(dest, kept);
        moved.push({ dest, kept });
      }
      renameRetry(path.join(tmp, name), dest);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    writeMarker(newDir, { ok: true });
    return { aside };
  } catch (err) {
    // le voci della sessione messe da parte tornano al loro posto, se è rimasto vuoto: la sessione riparte con i suoi dati
    for (const { dest, kept } of moved) {
      if (fs.existsSync(dest)) continue;
      try {
        renameRetry(kept, dest);
      } catch (restoreErr) {
        console.error(`Migrazione: ${kept} resta da parte, non sono riuscito a rimetterlo in ${dest}:`, restoreErr);
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      writeMarker(newDir, { ok: false, error: err.message });
    } catch {
      // nemmeno questo si scrive (disco pieno): senza libreria e impostazioni nella cartella nuova si riprova comunque
    }
    throw err;
  }
}

/**
 * macOS: l'aggiornamento dalla vecchia versione sostituisce "Virtual DJ AI.app" mantenendo il vecchio nome.
 * Se l'app in esecuzione si trova lì, restituisce il percorso di destinazione (<cartella>/<nuovo>.app)
 * e il nuovo eseguibile; null se non serve rinominare o non si può.
 */
function macBundleRename(execPath, productName) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (path.basename(bundle) !== LEGACY_BUNDLE) return null;
  const target = path.join(path.dirname(bundle), `${productName}.app`);
  if (fs.existsSync(target)) return null;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return null;
  }
  return { from: bundle, to: target, execPath: path.join(target, path.relative(bundle, execPath)) };
}

module.exports = { LEGACY_NAME, migrateUserData, macBundleRename };
