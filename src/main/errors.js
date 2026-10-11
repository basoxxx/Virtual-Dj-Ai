// Errori del file system in parole, per i messaggi all'utente (i codici di Node sono in inglese e poco chiari).
const FS_ERRORS = {
  ENOSPC: 'disco pieno',
  EDQUOT: 'spazio esaurito',
  EACCES: 'permesso negato',
  EPERM: 'operazione non permessa (file bloccato o permessi)',
  EROFS: 'disco di sola lettura',
  EIO: 'errore di lettura o scrittura del disco',
  ENOENT: 'file o cartella non trovati',
  ENOTDIR: 'percorso non valido',
  EISDIR: 'al posto del file c\'è una cartella',
  EBUSY: 'file in uso',
  EMFILE: 'troppi file aperti',
};

function fsErrorText(err) {
  if (!err) return 'errore sconosciuto';
  return FS_ERRORS[err.code] || err.message || String(err);
}

module.exports = { fsErrorText };
