# Virtual DJ AI

Software DJ desktop per **Windows**, **macOS** e **Linux**, ispirato a VirtualDJ: due deck, mixer completo,
effetti, sampler, microfono, ingressi linea dalla scheda audio, uscita cuffia separata, controller MIDI,
registrazione del mix e automix.

Ad ogni push o merge su `main`, GitHub Actions compila e pubblica automaticamente una
**[Release](../../releases/latest)** con gli installer pronti:

| Sistema | File |
| --- | --- |
| Windows 10/11 | `Virtual-DJ-AI-<versione>-win-x64.msi` |
| macOS Apple Silicon | `Virtual-DJ-AI-<versione>-mac-arm64.dmg` |
| macOS Intel | `Virtual-DJ-AI-<versione>-mac-x64.dmg` |
| Linux | `Virtual-DJ-AI-<versione>-linux-x86_64.AppImage` |

> **macOS:** l'app non è firmata con un certificato Apple. Al primo avvio fai clic destro sull'app → **Apri**,
> oppure esegui `xattr -cr "/Applications/Virtual DJ AI.app"` nel Terminale.

## Funzionalità

**Deck (×2)**
- Caricamento di MP3, WAV, FLAC, OGG/Opus, M4A/AAC, AIFF (trascinamento dalla libreria o dal file manager)
- Analisi automatica: **BPM**, **beatgrid**, **tonalità** (con notazione Camelot), **loudness** (auto-gain)
- Forma d'onda scorrevole a colori per frequenza con beatgrid + vista d'insieme cliccabile
- Jog wheel con **scratch** (modalità vinile) o pitch bend, copertina dell'album al centro
- CUE stile CDJ (preascolto tenendo premuto), stutter, **8 hot cue** salvati per brano
- **Loop** automatici (¼ – 32 battute), loop in/out manuali, reloop, ½×/2×, spostamento loop, **beat jump**
- **Pitch** ±8/16/25/50/100 %, nudge, **keylock** (mantiene la tonalità), **SYNC** di tempo e fase
- Quantize, **slip mode**, reverse, **censor**, tap tempo, correzione beatgrid, ×2/÷2 BPM
- 2 slot effetti per deck: Echo, Ping-pong delay, Reverb, Flanger, Phaser, Filtro LFO, Bitcrusher, Trance gate (sincronizzati al BPM)
- **Ingresso linea**: ogni deck può prendere il segnale da un ingresso della scheda audio (giradischi, CD, strumenti)

**Mixer**
- Gain, EQ a 3 bande con **kill**, filtro a manopola singola (passa-basso ↔ passa-alto)
- Fader di volume, VU meter, assegnazione crossfader (A / THRU / B), 3 curve di crossfader
- Master con limiter e indicatore di clip, **preascolto in cuffia** (PFL) con mix cue/master
- **Microfono**: on air, talkover (abbassa la musica), EQ, eco, compressore

**I/O audio locale**
- Scelta della periferica di uscita master
- Uscita cuffia su una **seconda periferica** (es. scheda DJ a 4 canali) oppure modalità **split** (master a sinistra, cuffia a destra) con una sola scheda
- Scelta dell'ingresso microfono e degli ingressi linea
- Latenza configurabile

**Altro**
- Libreria con cartelle musicali, ricerca istantanea, ordinamento, playlist, cronologia, più suonati
- Evidenziazione dei brani compatibili (BPM vicino, tonalità armonica) col deck in onda
- **Sampler** a 8 pad con suoni inclusi (air horn, sirena, riser…) e campioni personalizzabili
- **Automix** con coda, transizioni sincronizzate e durata regolabile
- **Registrazione** del mix in WAV (scritta su disco in streaming, adatta a set di ore)
- **Controller MIDI** con MIDI learn di tutte le funzioni (anche jog a encoder)
- Scorciatoie da tastiera (F1 per l'elenco)

## Sviluppo

Requisiti: Node.js 22.

```bash
npm install
npm start          # avvia l'app
npm run dev        # avvia con gli strumenti sviluppatore
npm test           # test di analisi audio (BPM, tonalità, forme d'onda)
npm run check      # controllo di sintassi
npm run dist:win   # installer .msi (su Windows)
npm run dist:mac   # installer .dmg (su macOS)
npm run dist:linux # AppImage (su Linux)
```

### Struttura

```
src/main/          processo principale Electron (finestre, libreria, file, registrazione)
src/renderer/      interfaccia e motore audio (Web Audio API + AudioWorklet)
  js/audio/        engine, deck, mixer, effetti, sampler, microfono
  js/dsp/          analisi BPM/beatgrid/tonalità/forma d'onda, WAV
  js/ui/           componenti grafici
  worklets/        riproduzione dei deck (scratch, loop, keylock) e registrazione
  workers/         analisi dei brani in background
.github/workflows/ CI e pubblicazione automatica delle release
```

### Rilascio

Il workflow `.github/workflows/release.yml` si attiva su ogni push su `main` (quindi anche su ogni merge di una
pull request): esegue i test, costruisce MSI/DMG/AppImage su runner Windows/macOS/Linux e crea la release
`v<major>.<minor>.<numero build>`. Per cambiare major/minor modifica `version` in `package.json`.
