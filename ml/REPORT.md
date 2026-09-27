# Report ML: AI DJ con modelli locali

Obiettivo: modelli open source (solo licenze MIT/Apache) che girano sulla CPU di Windows, Mac Intel e Apple Silicon,
con al massimo 4–6 GB di RAM in tutto durante il mix in tempo reale. Il motore a regole resta sempre il ripiego.

Tutti i numeri di questo file sono misurati; per ognuno sono indicati la macchina e lo script usati.

**Macchina di misura:** MacBook Pro Apple M1 Pro (8 core, 16 GB), macOS 27.0, Node 26.0, Electron 38.8,
onnxruntime-web 1.30.0, onnxruntime-node 1.30.0 (solo per il confronto), Python 3.12.13, PyTorch 2.8.0 (MPS disponibile).

---

## Giorno 1 — 27 settembre 2026 (Settimana 1, punti 1–7)

### Fatto

- **Ambiente** (`ml/requirements.txt`, venv in `ml/.venv` con uv). Mac Apple Silicon: per l'addestramento della
  settimana 2 si userà MPS.
- **Licenza di Beat This!:** codice MIT; per i pesi i maintainer hanno chiarito nella issue
  [CPJKU/beat_this#16](https://github.com/CPJKU/beat_this/issues/16) che vale la stessa licenza MIT (con nota nel README).
  Il testo della licenza è in `src/renderer/licenses/beat-this-MIT.txt` e nella pagina *Informazioni* dell'app.
- **Export ONNX** (`ml/beat_this/export_onnx.py`): checkpoint ufficiali `final0` e `small0`, ingresso fisso
  1 × 1500 × 128 (blocchi da 1500 frame come beat_this), opset 17, più una versione int8 con quantizzazione dinamica
  dei MatMul/Gemm (pesi costanti, per canale). Salva i riferimenti per i test in `test/fixtures/beat-this/`.
- **Frontend e post-processing in JavaScript** (`src/renderer/js/dsp/beat-this.js`): spettrogramma log-mel identico a
  `preprocessing.py`, blocchi e ricomposizione come `inference.py`, post-processing "minimal" di `postprocessor.py`,
  poi griglia a tempo costante (BPM, prima battuta forte, confidenza).
- **Nell'app:** il worker di analisi esegue Beat This! con onnxruntime-web (WASM, solo CPU, fino a 4 thread grazie
  all'isolamento cross-origin del protocollo `app://`). L'audio a 22050 Hz si ottiene nel renderer decodificando il
  file con un `OfflineAudioContext` a 22050 Hz. In *Impostazioni → AI locale* c'è il selettore
  **Motore di analisi: AI (Beat This!) / Classico**; se il modello manca o dà errore si usa l'analisi classica
  (verificato: con il modello non caricabile il banco di prova ha restituito il BPM classico e il messaggio d'errore).
- **Distribuzione dei modelli:** i file `.onnx` non sono in git; stanno nella GitHub Release `models-v1`
  (pre-release, così il sito continua a leggere l'ultima versione dell'app), con SHA-256 in `scripts/models.json`.
  `npm run models` li scarica; CI e rilascio lo fanno prima di test e build. I file di onnxruntime-web vengono copiati
  in `src/renderer/vendor/` dal `postinstall`.

### Numeri misurati

#### 1. Parità ONNX ↔ PyTorch (`ml/beat_this/export_onnx.py`, `ml/eval/beat_parity.py`)

25 brani reali (vedi *Set di valutazione*), logit dell'intero brano e battute con il post-processing "minimal".
F-measure con finestra ±70 ms rispetto a PyTorch dello stesso modello.

| Modello | File | Errore max logit | Mediana errore max | F battute (media / min) | F battute forti (media / min) |
|---|---|---|---|---|---|
| final0 fp32 | 81,7 MB | 0,0003 | 0,0001 | 1,000 / 1,000 | 1,000 / 1,000 |
| final0 int8 | 22,2 MB | 3,38 | 1,25 | 0,9993 / 0,9959 | 0,9979 / 0,9733 |
| small0 fp32 | 9,0 MB | 0,0001 | 0,0001 | 1,000 / 1,000 | 1,000 / 1,000 |
| small0 int8 | 3,9 MB | 2,39 | 0,98 | 0,9981 / 0,9759 | 0,9967 / 0,9756 |

L'int8 sposta molto i logit lontani dalla soglia, ma quasi mai le battute.

#### 2. Parità del frontend JavaScript (`test/beat-this.test.js`)

- Spettrogramma log-mel JS contro torchaudio sul brano sintetico di prova (6 s, `test/helpers/music.js`):
  **errore massimo 1,04·10⁻⁴, medio 3,6·10⁻⁶** su valori fino a 8,06 (JS in float64, torchaudio in float32).
- Blocchi: identici a `split_piece` per 300, 1488, 1489, 1490, 1494, 1495, 3000 e 4464 frame.
- Post-processing: battute e battute forti identiche a `postprocessor.py` per tutti e quattro i modelli.
- Catena completa JS + onnxruntime-web contro onnxruntime Python: logit **fp32 entro 4·10⁻⁵**; **int8 fino a 0,35**
  anche partendo dallo stesso spettrogramma (i kernel int8 di WASM arrotondano diversamente da quelli nativi ARM64);
  battute e battute forti identiche in tutti i casi.

#### 3. Ricampionamento a 22050 Hz (`ml/eval/resample_check.py`, small0)

Battute ottenute da audio ricampionato in modi diversi, confrontate con soxr (il ricampionatore di beat_this):

| Metodo | F battute (media / min) | F battute forti (media / min) |
|---|---|---|
| interpolazione lineare senza filtro (AudioBufferSourceNode di Chromium) | 0,986 / **0,770** | 0,978 / 0,806 |
| sinc di qualità (come `decodeAudioData` su un OfflineAudioContext a 22050 Hz) | 0,999 / 0,987 | 0,996 / 0,976 |

Per questo l'app decodifica il file una seconda volta a 22050 Hz invece di ricampionare il buffer già decodificato.

#### 4. Tempo e RAM per un brano di 5 minuti, in Node (`ml/eval/bench.mjs`)

Brano "Realizer" (300 s, mono 22050 Hz già pronto), un processo per misura. Tempo totale = caricamento del modello
+ spettrogramma (0,30–0,32 s in tutti i casi) + inferenza + post-processing. RAM = picco di RSS del processo
(48 MB all'avvio, audio compreso).

| Motore | Modello | 1 thread | 4 thread | Picco RAM |
|---|---|---|---|---|
| web (WASM) | small0 int8 | 24,1 s | 7,6 s | 761–782 MB |
| web (WASM) | small0 fp32 | 23,7 s | 7,4 s | 783–827 MB |
| web (WASM) | final0 int8 | 46,9 s | 13,6 s | 818–825 MB |
| web (WASM) | final0 fp32 | 46,7 s | 13,5 s | 1052–1084 MB |
| node (nativo) | small0 int8 | 9,7 s | 3,6 s | 632–642 MB |
| node (nativo) | small0 fp32 | 11,5 s | 4,0 s | 698–702 MB |
| node (nativo) | final0 int8 | 15,9 s | 5,3 s | 687–688 MB |
| node (nativo) | final0 fp32 | 22,1 s | 7,0 s | 921–930 MB |

Tutte le configurazioni trovano 125 BPM con confidenza 1.

**Scelta: onnxruntime-web nel worker.** È circa 2 volte più lento del nativo, ma:
- onnxruntime-node 1.30 non ha binari per **macOS Intel** (solo darwin-arm64, win32 x64/arm64, linux x64/arm64), che è
  una piattaforma richiesta;
- non servono moduli nativi da impacchettare (il pacchetto node pesa 288 MB con i binari di tutte le piattaforme);
- 8 s per un brano di 5 minuti in background sono accettabili: la libreria viene analizzata prima di suonare.

In WASM l'int8 non è più veloce dell'fp32, ma occupa meno disco e un po' meno RAM.
Il picco di RAM viene quasi tutto dall'attenzione lungo il tempo nel frontend (matrici 1500 × 1500 per ciascuna delle
32/16/8 bande di frequenza).

#### 5. Nell'app reale: accuratezza, tempo e RAM (`ml/eval/electron/main.js`, `ml/eval/summarize.py`)

Banco di prova Electron con gli stessi file del renderer: decodifica a 44,1 kHz, decodifica a 22050 Hz, worker,
onnxruntime-web con 4 thread (`crossOriginIsolated: true`), poi tonalità, energia e struttura come per la libreria.
25 brani, uno alla volta.

- **bpm ±0,5:** BPM entro 0,5 da quello dichiarato dall'autore.
- **acc2:** entro il 4%, ammettendo metà, doppio, triplo e terzo.
- **griglia F:** F-measure (±70 ms) della griglia `offset + k·60/BPM` contro le battute di riferimento
  (Beat This! final0 fp32 in Python, `ml/eval/reference_beats.py`). Non sono annotazioni umane, quindi il confronto
  favorisce Beat This!.
- **battuta forte:** l'offset cade (±70 ms) su una battuta forte di riferimento, cioè la griglia è allineata alle
  battute da 4.

| Motore | bpm ±0,5 | acc2 | griglia F | battuta forte | s per 5 min (mediana / max) | Picco RAM renderer | Picco RAM app |
|---|---|---|---|---|---|---|---|
| Classico | 19/25 | 23/25 | 0,642 | 14/25 | 1,9 / 1,9 | 737 MB | 1088 MB |
| **AI small0 int8** (incluso) | **23/25** | **25/25** | 0,943 | **23/25** | 7,9 / 8,6 | 1243 MB | 1585 MB |
| AI small0 fp32 | 23/25 | 25/25 | 0,941 | 23/25 | 7,9 / 8,9 | 1376 MB | 1719 MB |
| AI final0 int8 | 21/25 | 23/25 | 0,984 | 23/25 | 13,8 / 15,1 | 1404 MB | 1736 MB |
| AI final0 fp32 | 21/25 | 23/25 | 0,984 | 23/25 | 13,4 / 14,5 | 1585 MB | 1957 MB |

Prima di ogni brano il renderer occupa 80 MB e l'app 341 MB. La RAM comprende l'audio decodificato del brano
(circa 100 MB per 5 minuti in stereo). Nessun ripiego al classico in tutte le prove AI.

Casi da notare:
- Il classico sbaglia l'ottava su 4 brani (77,5 contro 155, 89 contro 178, 80 contro 120, 120 contro 180) e ha la fase
  sbagliata su molti brani (es. "Realizer": offset 0,393 s contro la battuta forte vera a 1,016 s).
- Con small0 gli unici BPM fuori da ±0,5 sono i due valzer in 3/4 (175 contro 177, 90 contro 177): l'app ragiona in
  battute da 4 e per questi la confidenza scende a 0,7.
- final0 legge "Captain Scurvy" a 120 (autore 180) e "Bummin on Tremelo" a 80 (autore 120): battute regolarissime
  ma a un altro livello metrico (2/3, tipico dei brani in 12/8). small0 dà 179,77 con confidenza 0,26 sul primo
  (battute irregolari, risultato in parte fortunato) e 120 sul secondo.
- La griglia F di final0 è più alta anche perché il riferimento è final0 stesso.

**Scelta del modello incluso: small0 int8.** Rispetto a final0 è 1,7 volte più veloce, usa 160–340 MB in meno,
pesa 3,9 MB invece di 22–82 MB e sul BPM dichiarato dagli autori va meglio (23/25 contro 21/25).
Le altre varianti restano nella release `models-v1` (`npm run models -- --all`).

#### 6. Tempo per un brano di 5 minuti nell'app, a macchina ferma (`ml/eval/electron/main.js --files Realizer.mp3`)

Brano di 310 s, due ripetizioni per variante, nessun altro processo pesante. Il tempo comprende la seconda
decodifica a 22050 Hz, Beat This!, tonalità, energia e struttura.

| Motore | Tempo (2 prove) | Picco RAM renderer | Picco RAM app |
|---|---|---|---|
| Classico | 1,58 / 1,57 s | 642 MB | 974–979 MB |
| AI small0 int8 | 8,49 / 8,50 s | 1193–1199 MB | 1517–1521 MB |
| AI small0 fp32 | 8,38 / 8,35 s | 1226–1247 MB | 1556–1583 MB |
| AI final0 int8 | 14,60 / 14,51 s | 1220–1233 MB | 1577–1591 MB |
| AI final0 fp32 | 14,61 / 14,60 s | 1486–1490 MB | 1824–1826 MB |

#### 7. RAM dell'app completa durante un mix (`ml/eval/electron/mix-ram.js`)

App vera (`src/main/main.js`, cartella dati temporanea): due brani sui deck in riproduzione (volume master a zero)
e analisi in background dei 25 brani della libreria. Somma del working set di tutti i processi.

| Motore | App pronta | Mix + analisi (picco) | Mix, subito dopo l'analisi | Mix, worker chiuso | Durata analisi 25 brani |
|---|---|---|---|---|---|
| Classico | 577 MB | 1771 MB | 1367 MB | 1115 MB | 41 s |
| AI small0 int8 | 583 MB | **2167 MB** | 1584 MB | 918 MB | 170 s |

Un secondo run AI senza la fase finale ha dato un picco di 2073 MB. Il **picco resta sotto 2,2 GB**, ben dentro il
tetto di 4–6 GB. Chiudendo il worker dopo 20 s di inattività la memoria WASM torna libera.

### Set di valutazione

25 brani di Kevin MacLeod (incompetech.com, **CC BY 4.0**) con BPM dichiarato dall'autore: elettronica, pop, funk,
rock, hip hop e reggae tra 84 e 178 BPM, 2–5,5 minuti (`ml/eval/fetch_cc_music.py`, selezione deterministica dal
catalogo). I file restano in `ml/data/` (fuori da git).

### Problemi aperti

- **Metro diverso da 4/4:** la griglia dell'app assume battute da 4 tempi; nei valzer le battute forti di Beat This!
  non si allineano (coerenza 0,26–0,28). Si potrebbe riconoscere il 3/4 dai residui modulo 3.
- **Confidenza bassa:** oggi il risultato AI si tiene sempre, anche con confidenza 0,26. Da decidere se sotto una
  soglia conviene il classico o un avviso nella libreria.
- **RAM dell'analisi:** +0,4–0,6 GB di picco rispetto al classico (sezioni 6 e 7), quasi tutto per l'attenzione lungo il tempo del
  frontend. Se servisse ridurla si possono provare blocchi più corti (da valutare l'effetto sulla precisione).
- **Tempo:** con l'AI l'analisi della libreria è circa 4 volte più lenta del classico (170 s contro 41 s per 25 brani);
  un brano caricato su un deck senza analisi mostra il BPM dopo circa 8 s invece di 1,6 s.
- **Brani già analizzati** tengono il BPM classico: manca un comando "Rianalizza con l'AI".
- **Tempi su Windows e Mac Intel** non ancora misurati (solo M1 Pro). Senza SIMD veloce o con meno core il tempo
  WASM può crescere parecchio: da misurare sugli installer della PR.

### Prossimi passi

- Misurare tempo e RAM su Windows e Mac Intel con gli installer di prova della CI.
- Comando per rianalizzare con l'AI i brani già in libreria; decidere cosa fare con confidenza bassa e 3/4.
- Settimana 2: dati del DJ Mix Dataset (sottoinsieme di circa 200 mix), studio di DJtransGAN, estrazione delle curve
  per transizione e primo addestramento del modello C con MPS.
