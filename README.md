# Segueo

🌐 **Sito:** https://basoxxx.github.io/Virtual-Dj-Ai/

Software DJ desktop per **Windows**, **macOS** e **Linux** con un'**AI che mixa in automatico**
e **SegueoChat** per dirle come suonare: due deck, mixer completo,
effetti, sampler, microfono, ingressi linea dalla scheda audio, uscita cuffia separata, controller MIDI,
registrazione del mix e automix.

Ad ogni push o merge su `main`, GitHub Actions compila e pubblica automaticamente una
**[Release](../../releases/latest)** con gli installer pronti:

| Sistema | File |
| --- | --- |
| Windows 10/11 | `Segueo-<versione>-win-x64.msi` |
| macOS Apple Silicon | `Segueo-<versione>-mac-arm64.dmg` |
| macOS Intel | `Segueo-<versione>-mac-x64.dmg` |
| Linux | `Segueo-<versione>-linux-x86_64.AppImage` |

> **macOS:** l'app non è firmata con un certificato Apple. Al primo avvio fai clic destro sull'app → **Apri**,
> oppure esegui `xattr -cr "/Applications/Segueo.app"` nel Terminale.

## 🤖 AI DJ: mix automatico con AI sul computer

Premi **🤖 AI DJ** (o `Ctrl+M`) e il programma mixa da solo, come un DJ:

1. **Analizza** in background tutta la libreria: BPM, beatgrid, tonalità (Camelot), energia 1–10,
   struttura del brano (intro, outro, frasi da 8 battute) e punti di mix. Battute e battute forti vengono da
   **Segueo Analisi battute**, una rete neurale basata su Beat This! (CPJKU, licenza MIT) che gira sul computer con
   la sola CPU;
   in **Impostazioni → AI → Motore di analisi** si può tornare all'analisi classica, che resta comunque
   il ripiego automatico se il modello manca o dà errore. L'analisi è ibrida: il classico dà subito BPM e forma
   d'onda, Segueo Analisi battute rifinisce poi battute, battuta forte e struttura in background.
   Ogni brano si analizza una volta sola (i risultati restano nella libreria). Con librerie grandi l'analisi parte
   dai brani che servono subito (sui deck, in coda, nei mashup, nella playlist dell'AI DJ) e si mette in pausa mentre
   si separano voce e base, così i mashup non aspettano la fine di tutta la libreria.
2. **Sceglie il brano successivo** tra quelli compatibili: tonalità armonica, BPM vicini (anche metà/doppio tempo),
   energia coerente con la strategia scelta (*mantieni*, *crescente*, *onde*, *rilassata*, *picco*), genere, varietà.
   Nel pannello "Diario dell'AI" spiega ogni scelta.
3. **Pianifica la transizione** sul punto di uscita del brano, allineata alla battuta forte, e sceglie lo stile:
   **bass swap** con gli EQ, **filtro**, **echo out** (per tempi incompatibili), **dissolvenza** o **taglio sul beat**.
   Con **Transizioni → Tagli a raffica (stile LUM!X)** ogni brano suona 16-24 misure e il successivo entra con un
   taglio secco sul battere dopo una misura di filtro, una volta su tre direttamente dal suo drop (tempi misurati
   sui set di LUM!X).
4. **Esegue il mix**: sync di tempo e fase, crossfader, EQ, filtri ed effetti si muovono da soli (si vedono le manopole
   girare), poi riporta gradualmente il brano al suo BPM originale.
   Con **Transizioni → Modello AI** le curve di crossfader, EQ basso/medio/alto e filtri le decide, battuta per
   battuta, una rete neurale che gira sul computer (`ml/transitions/`), anche per transizioni lunghe fino a 64
   battute. Due stili: **dance** (imparato dai mix di Gabry Ponte: cambi corti e a tempo) e **techno**
   (imparato da DJ set techno e minimal: dissolvenze lunghe). Se il modello non è disponibile si usano le regole.
5. **Remix dal vivo** (opzione): mentre un brano suona da solo l'AI lo ricompone sulle frasi della griglia con loop
   roll, eco, filtro in salita e ripetizione della frase appena suonata.
6. **Mashup** (opzione): quando il brano successivo è compatibile per tonalità e tempo, il brano in onda passa alla
   sola base e la **voce** del successivo entra a tempo per 16 battute, poi il mix prosegue. Voce e base vengono
   separate sul computer con **Segueo Separazione voce**, basato su Demucs v4 (il modello, 174 MB, è già incluso
   nell'installer) e
   salvate su disco. Il pulsante **STEM** di ogni deck passa tra brano completo, solo voce e solo base.

**Mashup preparati prima del set.** Nella scheda **MASHUP** del pannello laterale scegli una **base** e una **voce**
(trascinandole dalla libreria, con il pulsante **+** sul brano selezionato o dal menu del brano → *Mashup: usa come
base/voce*), oppure lascia scegliere all'AI: **✨** in una casella sceglie il brano più compatibile con quello
nell'altra, **✨ Sceglie l'AI** propone tutta la coppia, e a ogni tocco arriva un'alternativa (mai un mashup già
salvato). L'app controlla tonalità e tempo, propone i brani compatibili e con **Salva e prepara** separa subito voce
e base e trova la frase in cui entra la voce: tutto resta salvato nella libreria, così durante il set non c'è niente da
calcolare. Ogni mashup si prova sui deck (**▶ Prova**: base sul deck A, voce sul deck B, a tempo) e si ritocca: punto
della base in cui entra la voce, punto da cui parte la voce (frecce di 4 battute, Maiusc per 1) e durata (8, 16 o 32
battute). **+ Coda** mette in coda all'AI DJ la base e poi la voce: quando i due brani vanno in onda uno dopo l'altro
l'AI DJ fa quel mashup, anche con l'opzione Mashup spenta; con l'opzione accesa, dopo una base sceglie da sola la sua
voce. Utile soprattutto sui computer con 8 GB di RAM, dove separare durante il mix è pesante.

Puoi lasciare scegliere all'AI dalla libreria o da una playlist, oppure darle una coda. I pulsanti **Mixa ora** e
**Cambia prossimo** permettono di intervenire in qualsiasi momento.

**Vista AI.** Con il selettore **Console | AI** in alto (o `Ctrl+Shift+A`) l'app passa a una vista dedicata al mix
automatico e ai mashup: brano in onda e prossimo in grande, avanzamento della transizione, crossfader, pulsanti per
AI DJ, mashup e remix, e le impostazioni dell'AI DJ in evidenza accanto a coda e diario. L'AI continua a mixare anche
tornando alla **Console**, dove puoi intervenire a mano sopra il suo mix. La vista scelta viene ricordata.

### 💬 SegueoChat: di' all'AI DJ come suonare

Nella scheda **CHAT** del pannello laterale (o con `Ctrl/Cmd+K`, o dal pulsante **SegueoChat** nella vista AI) si parla
all'AI DJ in italiano, anche mentre suona:

- **energia**: *"più energia"*, *"in crescendo"*, *"rilassata"*, *"a onde"*, *"picco"*
- **transizioni**: *"bass swap"*, *"con il filtro"*, *"echo"*, *"dissolvenze lunghe"*, *"tagli a raffica"*, *"stile dance"*,
  *"stile techno"*, *"mix da 32 battute"*
- **generi e BPM**: *"solo techno"*, *"niente house"*, *"anche un po' di deep house"*, *"tra 120 e 126 BPM"*,
  *"togli i filtri"*: l'AI DJ sceglie solo i brani che li rispettano
- **brani e coda**: *"metti Golden Hour come prossimo"*, *"aggiungi Night Drive"*, *"svuota la coda"*
- **set**: *"crea una scaletta di 20 brani house in crescendo"*, *"per i prossimi 3 brani tagli a raffica"* (poi torna
  com'era), *"chiudi il set dopo questo"*, *"fai un mashup"*, *"voce di Golden Hour sulla base di Glass City"*
- **comandi e domande**: *"parti"*, *"fermati"*, *"mixa ora"*, *"cambia il prossimo"*, *"cosa suoni?"*,
  *"qual è il prossimo?"*, *"perché?"*, *"come stai suonando?"*

I comandi li capisce subito un interprete integrato; i tanti altri modi di dirlo (*"la pista è morta, svegliala un
po'"*, *"i cambi falli durare di più"*, *"questo pezzo è brutto, cambialo"*) li capisce **Segueo Chat**, un modello
addestrato apposta su frasi generate e oltre 5.000 interazioni scritte, incluso nell'app (2 MB, pochi millisecondi,
senza internet). Su 1.098 messaggi di prova mai visti insieme capiscono l'82% delle richieste, contro il 43% del solo
interprete; sulle frasi scritte a mano il 95% contro il 60% (dettagli e limiti in `ml/REPORT.md`). Nessun messaggio
esce dal computer. Ogni risposta ha **Annulla**; filtri, cambi temporanei e chiusura del set
restano visibili (e si tolgono con un clic) nel pannello AI DJ, e ogni modifica finisce nel diario dell'AI.

### Scalette descritte a parole

Nel pannello AI DJ scrivi com'è il set (*"deep house al tramonto, poi sempre più energica"*, *"20 brani techno per
l'after"*) e premi **✨ Crea scaletta**: genere, energia e numero di brani li capisce SegueoChat (interprete e modello
Segueo Chat), il motore interno sceglie i brani compatibili e li mette in coda. Lo stesso si può chiedere in chat.

## 🎛 Console DJ supportate

Collega la console via USB: viene **riconosciuta automaticamente** e mappata, con i **LED dei pulsanti** che seguono
lo stato del programma (play, cue, sync, hot cue, loop, preascolto, effetti…).

| Casa / principianti | Semi-professionali | Professionali |
| --- | --- | --- |
| Pioneer DJ DDJ-200, DDJ-FLX2, DDJ-400, DDJ-FLX4, DDJ-SB3 | Pioneer DJ DDJ-FLX6, DDJ-SR2, DDJ-REV1/5/7, DDJ-800 | Pioneer DJ DDJ-SX3, DDJ-1000, DDJ-FLX10, XDJ-RX3/XZ, Opus Quad (modalità PC) |
| Hercules DJControl Starlight, Inpulse 200/300, Mix | Hercules Inpulse 500, Inpulse T7 | Denon DJ MC7000, SC6000/SC5000/Prime 4 (modalità PC) |
| Numark Party Mix, DJ2GO2 Touch, Mixtrack Pro FX, Mixtrack Platinum FX | Numark NS4FX, Mixstream Pro; Denon DJ MC4000, MC6000MK2 | Rane ONE, Seventy, Four; Allen & Heath Xone:K1/K2/K3 |
| | Behringer CMD, Novation Launch Control | |

- **Qualsiasi altra console MIDI** si configura in un minuto con la **procedura guidata** (Impostazioni → 🎛 Console DJ):
  ti chiede un controllo alla volta. Ogni controllo si può anche correggere con **Learn** o invertire (⇅).
- Le mappature si possono **esportare e importare** (file `.segueo.json`) per condividerle.
- I profili seguono la documentazione MIDI pubblica dei produttori; se su un modello un comando non risponde,
  basta correggerlo con Learn: le correzioni personali hanno sempre la precedenza.
- **Gamepad** Xbox, PlayStation, Switch Pro e simili funzionano come console (play, cue, sync, crossfader sui grilletti, jog sugli stick).
- Console solo HID (es. Traktor Kontrol S2/S3/S4 MK3): vanno impostate in modalità MIDI con il software del produttore.
  Lettori CDJ/XDJ e mixer DJM si possono usare anche come sorgenti audio tramite gli ingressi linea dei deck.

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
- **AI DJ** (vedi sopra) con coda, scalette automatiche, mashup preparati e SegueoChat
- **Registrazione** del mix in WAV (scritta su disco in streaming, adatta a set di ore)
- **Console DJ**: riconoscimento automatico, LED, procedura guidata, MIDI learn, gamepad (vedi sopra)
- Scorciatoie da tastiera (F1 per l'elenco)

## Sviluppo

Requisiti: Node.js 22.

```bash
npm install
npm start          # avvia l'app
npm run dev        # avvia con gli strumenti sviluppatore
npm test           # test: analisi audio, motore deck, AI DJ, console MIDI e gamepad
npm run check      # controllo di sintassi
npm run models     # scarica i modelli AI (GitHub Release models-v1) in src/renderer/models/
npm run dist:win   # installer .msi (su Windows)
npm run dist:mac   # installer .dmg (su macOS)
npm run dist:linux # AppImage (su Linux)
```

### Struttura

```
src/main/          processo principale Electron (finestre, libreria, file, registrazione)
src/renderer/      interfaccia e motore audio (Web Audio API + AudioWorklet)
  js/audio/        engine, deck, mixer, effetti, sampler, microfono
  js/dsp/          analisi BPM/beatgrid/tonalità/forma d'onda/struttura, WAV
  js/ai/           AI DJ: selezione brani, transizioni, SegueoChat, analisi libreria
  js/controllers/  profili delle console DJ, gamepad
  js/ui/           componenti grafici
  worklets/        riproduzione dei deck (scratch, loop, keylock) e registrazione
  workers/         analisi dei brani in background (Segueo Analisi battute con onnxruntime-web, solo CPU)
  vendor/          file di onnxruntime-web copiati da npm install (esclusi da git)
  models/          modelli ONNX scaricati da npm run models (esclusi da git)
ml/                modelli AI: ambiente Python, export ONNX, valutazioni e REPORT.md con le misure
  beat_this/       Beat This! in ONNX        transitions/  modello delle transizioni (dati, addestramento)
  mashup/          Demucs in ONNX (voce e base)     segueochat/  modello Segueo Chat (frasi, addestramento, prove)
.github/workflows/ CI, pubblicazione automatica delle release e del sito
site/              sito GitHub Pages (foto reali dell'interfaccia)
```

### Modelli AI

I pesi non stanno nel repository: i file `.onnx` sono asset della GitHub Release
[`models-v1`](../../releases/tag/models-v1), elencati con dimensione e SHA-256 in `src/main/models.json`.
`npm run models` scarica quelli inclusi nell'app (`--all` anche le altre varianti); CI e rilascio lo fanno
prima di test e build. Senza modello l'app funziona con l'analisi classica.

| File | Funzione | Origine |
| --- | --- | --- |
| `segueo-analisi-battute.onnx` | battute e battute forti dei brani (3,9 MB) | Beat This! small0 (CPJKU, MIT), int8 |
| `segueo-transizioni-dance-v7.onnx` | transizioni dell'AI DJ, stile dance: curve di crossfader, EQ e filtri (6,9 MB) | modello C di questo progetto (`ml/transitions/`), int8 |
| `segueo-transizioni-techno-v6.onnx` | transizioni dell'AI DJ, stile techno (6,9 MB) | modello C, int8 |
| `segueo-separazione-voce.onnx` | voce e base separate per i mashup (174 MB) | Demucs v4 htdemucs (Meta, codice MIT) |
| `segueo-chat.onnx` | capisce i messaggi di SegueoChat (2,1 MB) | modello di questo progetto (`ml/segueochat/`), int8 |

Nella release restano anche i nomi precedenti dei modelli di transizione e separazione (`transition-planner-v*.onnx`,
`segueo-transizioni-v7.onnx`, `htdemucs.onnx`), usati dalle versioni già installate.

Per rigenerarli (Python 3.12, vedi `ml/requirements.txt`):

```bash
uv venv --python 3.12 ml/.venv && uv pip install --python ml/.venv/bin/python -r ml/requirements.txt
ml/.venv/bin/python ml/beat_this/export_onnx.py   # ONNX fp32 + int8 in ml/data/onnx, riferimenti per i test
```

Misure, confronti e problemi aperti sono in [`ml/REPORT.md`](ml/REPORT.md).

### Rilascio

Il workflow `.github/workflows/release.yml` si attiva su ogni push su `main` (quindi anche su ogni merge di una
pull request): esegue i test, costruisce MSI/DMG/AppImage su runner Windows/macOS/Linux e crea la release
`v<major>.<minor>.<numero build>`. Per cambiare major/minor modifica `version` in `package.json`.

Le versioni di prova partono da un branch con un tag `v<versione>-beta.<n>` (o `-alpha.<n>`), per esempio
`git tag v1.6.0-beta.1 && git push origin v1.6.0-beta.1`: il workflow `.github/workflows/beta.yml` esegue gli stessi
test e build e pubblica una **pre-release** con le note di `docs/release-notes/<tag>.md`. Le pre-release non
diventano "latest": il sito e gli aggiornamenti automatici continuano a proporre l'ultima versione stabile.
