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
  (pre-release, così il sito continua a leggere l'ultima versione dell'app), con SHA-256 in `src/main/models.json`.
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

---

## Giorno 2 — 27 settembre 2026 (Settimana 2: primo "cervello DJ")

### Fatto

- **Licenze.** DJ Mix Dataset, pacchetto `djmix` e djmix-analysis non hanno licenza: su tua decisione metadati e
  audio si usano **solo in locale** (`ml/data/`, mai committati o ridistribuiti) e il codice non è stato copiato:
  allineamento e stima di fader/EQ sono riscritti da zero dagli articoli (ISMIR 2020, DAFx 2022). DJtransGAN è MIT:
  ne ho ripreso le idee (curve di fader/EQ, mixer differenziabile), non il codice.
- **Dati** (`ml/transitions/djmix_subset.py`, `download.py`): sottoinsieme deterministico di 200 mix di musica da club
  (5095 transizioni, 5495 brani). I mix (SoundCloud/Mixcloud) si scaricano; i brani da YouTube sono stati bloccati
  dalla verifica anti-bot dopo circa 100 download anche con 2 download in parallelo e pause di 4-10 s. Su tua
  indicazione ho proseguito con i dati disponibili: 18 mix e 98 brani, di cui utili 5 mix del 1994-95 (vinile)
  con 62 coppie di brani consecutivi.
- **Caratteristiche e allineamento** (`features.py`, `align.py`): battute con Beat This! final0, caratteristiche per
  battuta, diagonali nella matrice di somiglianza brano × mix e programmazione dinamica sull'ordine della tracklist.
- **Curve reali** (`gains.py`, `build_dataset.py`): guadagni per banda dell'EQ dell'app stimati dal mix con minimi
  quadrati vincolati su 64 sotto-bande, convertiti in crossfader (curva "smooth"), EQ -1..0 e filtri.
- **Modello C** (`model.py`, `synth.py`, `train.py`): transformer bidirezionale da **6,43M parametri**; per ogni battuta
  della finestra (fino a 128) prevede crossfader, EQ basso/medio/alto dei due deck e filtri. Perdita: curve + mixer
  differenziabile (i controlli applicati alle bande dei due brani devono ridare il mix) + regolarità.
  Pre-addestramento su **transizioni sintetiche legate alla musica** (bass swap sul primo confine di frase di 8 battute
  dopo l'entrata dei bassi di B, blend, dissolvenza, taglio) generate da brani veri; la rifinitura sui mix reali è
  pronta (`--cv`, `--final`) ma **non usata**: i dati reali disponibili non sono affidabili (vedi sotto).
- **Export ONNX** (`export_onnx.py`): fp32 e int8, nella release `models-v1`; nell'app l'int8 (6,8 MB).
- **Nell'app:** Transizioni → **Modello AI (sperimentale)** nel pannello AI DJ. Il piano (sync, durata) si decide come
  in automatico, poi un worker dedicato calcola le curve battuta per battuta; se il modello manca, dà errore o i brani
  non sono analizzati in 30 s, si usano le regole e il diario lo dice.
- **Ascolto:** tre transizioni reali rese in `ml/data/listening/` (solo in locale): mix del DJ, regole, modello.
- **La tua musica (chiavetta):** inventario dei 1146 file, confronto dei BPM tra analisi classica e AI sui brani
  con tag (`ml/eval/usb_bpm.py`), caratteristiche per battuta per il generatore sintetico (`usb_features.py`,
  letti dalla chiavetta, salvate solo le caratteristiche) e prova di pre-addestramento con 5 volte i brani.

### Numeri misurati

#### 1. Stima dei guadagni su una transizione sintetica nota (`gains.py`)

64 battute, A esce con i bassi tagliati a metà (-26 dB), B entra gradualmente; errore medio sui guadagni d'ampiezza.

| Metodo | Errore A | Errore B | Bassi di A dopo lo scambio |
|---|---|---|---|
| 3 bande, regolarità quadratica | 0,105 | 0,139 | circa -9 dB (scambio smussato) |
| 3 bande, variazione totale | 0,15-0,35 | 0,17-0,35 | -6/-10 dB |
| **64 sotto-bande, guadagno condiviso per banda** | **0,03** | **0,03** | **-20/-60 dB** |

Con una sola potenza per banda il problema non è identificabile (due casse a tempo sommate): servono le sotto-bande.

#### 2. Allineamento e dati reali (`align.py`, `build_dataset.py`)

| | |
|---|---|
| Brani cercati nei 5 mix / allineati | 97 / 86 |
| Allineamenti affidabili (z ≥ 6, oppure z ≥ 5 con ≤ 3 tratti e ≥ 96 battute) | 18 |
| Coppie consecutive entrambe affidabili | **1** |
| Transizioni costruite da tutte le coppie allineate | 13 (lunghezza mediana 79 battute) |
| Errore relativo mediano del fit dei guadagni | **0,54** (sulle transizioni sintetiche: 0,04) |

Il primo metodo (senza centrare la matrice di somiglianza) non trovava nessuna diagonale; il secondo trova i brani
nell'ordine giusto, ma sui mix su vinile del 1994-95 (pitch dei giradischi, registrazioni radio, versioni YouTube
diverse) la somiglianza è troppo debole. Il livello metrico non c'entra: mix e brani hanno tempi coerenti.
**Queste 13 transizioni non sono affidabili come esempi da imitare** e non sono state usate per addestrare.

#### 3. Addestramento (Apple M1 Pro, MPS)

Pre-addestramento: 4000 passi da 32 transizioni sintetiche in 13 min (0,2 s a passo); alla fine errore sulle curve
0,055 e mixer 0,8 dB.

#### 4. Valutazione su brani mai visti (`train.py --synth-eval`)

Modello addestrato su 77 brani, valutato su 256 transizioni sintetiche da 22 brani mai visti, contro il motore a
regole attuale (`selector.js`) sulla stessa finestra. "Scontro dei bassi": battute con entrambi i bassi pieni;
"buchi": volume oltre 6 dB sotto il livello dei brani da soli; "eventi": crossfader a metà, bassi di A tagliati,
bassi di B aperti, su una battuta forte / su un inizio di frase di 8 battute del brano uscente.

| | Errore crossfader | Errore EQ | Errore del mix | Scontro bassi | Buchi | Eventi su battuta forte | Eventi su frase |
|---|---|---|---|---|---|---|---|
| **Modello C** | **0,088** | **0,056** | **0,88 dB** | 0,1% | 5,0% | 93% | **71%** |
| Regole: bass swap | 0,099 | 0,082 | 1,21 dB | 0% | 4,6% | 89% | 15% |
| Regole: dissolvenza | 0,093 | 0,128 | 1,36 dB | 12,4% | 3,9% | 89% | 15% |
| Obiettivo (sintetico) | — | — | — | 2,8% | 5,7% | 93% | 67% |

Il modello impara quello che gli insegna il generatore (frasi, entrata dei bassi) e lo applica a brani nuovi; non
è ancora "stile umano".

Sulle 13 transizioni reali poco affidabili: errore del mix 7,5 dB (modello) contro 7,45 (bass swap) e 7,2 (dissolvenza),
cioè indistinguibili, con eventi su inizio frase 67% (modello) contro 23% (regole).

#### 5. ONNX e app

| | |
|---|---|
| File | fp32 25,8 MB, int8 6,8 MB |
| ONNX fp32 contro PyTorch | errore massimo 1·10⁻⁵ |
| ONNX int8 contro PyTorch | errore medio 0,0017, massimo 0,28; metriche della tabella 4 identiche (0,078/0,036/0,67 dB su 128 transizioni) |
| onnxruntime-web (int8) contro Python | entro 0,05; creazione della sessione + inferenza 0,3 s in Node (1 thread) |
| Prova nell'app vera (`ml/eval/electron/autodj-model.js`) | piano "modello", bass swap eseguito dal modello (bassi A 0 → -1, bassi B -1 → 0), filtri non usati |

La prova nell'app ha trovato un errore reale, corretto: il piano chiedeva le curve prima che l'analisi dei brani
appena caricati fosse finita (con l'AI circa 8 s) e ripiegava sempre sulle regole.

#### 6. Ascolto

`ml/data/listening/` (in locale): per 3 transizioni `_1_reale.wav` (mix del DJ), `_2_regole.wav`, `_3_modello.wav`,
8 battute prima e dopo. Livelli controllati (nessun silenzio o saturazione). **Il giudizio d'ascolto è da fare**:
non posso ascoltare; le transizioni vengono da mix su vinile allineati male, quindi valgono come prova qualitativa.

#### 7. Beat This! sulla tua musica (chiavetta, `ml/eval/usb_bpm.py`)

1146 file audio (8,9 GB) letti dalla chiavetta senza copiarli. 282 hanno un tag BPM; 120 di questi sono tag fasulli
di un convertitore da YouTube (sempre 90 BPM sui file "(MP3_320K)", su cui i due motori concordano tra loro con
valori noti, es. Avicii "Wake Me Up" 124). Restano **162 brani con tag affidabile**, analizzati nell'app vera:

| Motore | ±0,5 BPM | a meno di metà/doppio | Secondi a brano (mediana) |
|---|---|---|---|
| Classico | 142/162 (87,7%) | 156/162 (96,3%) | 1,6 |
| AI (Beat This! small0 int8) | 141/162 (87,0%) | 158/162 (97,5%) | 7,6 |

Per genere (±0,5 BPM, classico / AI): elettronica 25 / 28 su 31, techno 22 / 22 su 23, house 17 / 17, trance 12 / 12,
senza genere 41 / 37 su 48. **Sul BPM della tua musica i due motori sono alla pari**; le differenze sono quasi tutte
di ottava (75 contro 150, 70 contro 140, 85,5 contro 171: "Blinding Lights" è a 171, quindi lì il tag è l'errore).
Il vantaggio dell'AI misurato sul set CC (fase della griglia, battuta forte 23/25 contro 14/25) con i tag non si
può verificare. Nessun ripiego al classico su 282 brani.

#### 8. Più brani per il pre-addestramento (chiavetta, `train.py --synth-eval --compare`)

Stesso test per entrambi: 256 transizioni sintetiche da 94 brani della chiavetta mai visti da nessuno dei due modelli.

| | Brani per l'addestramento | Errore crossfader | Errore EQ | Errore del mix | Eventi su frase |
|---|---|---|---|---|---|
| v1 (in uso) | 98 (DJ Mix Dataset) | 0,090 | 0,063 | 0,94 dB | 65% |
| v1.1 | 435 (DJ Mix Dataset + chiavetta) | 0,090 | 0,062 | 0,92 dB | 66% |
| Regole: bass swap | — | 0,098 | 0,084 | 1,15 dB | 9% |

Cinque volte i brani non cambiano nulla: la v1 generalizza già a musica di altri generi e il limite è il "maestro"
sintetico. **Resta la v1**; il prossimo passo utile sono dati di transizioni umane.

### Problemi aperti

- **Dati reali per il modello C.** Serve un insieme di mix digitali recenti con i brani originali. Strade possibili:
  (a) download lento da YouTube su più giorni (1 brano ogni 30-60 s); (b) cookie del browser (più veloce ma usa il
  tuo account); (c) **registrare le tue transizioni** nell'app: quando mixi a mano, l'app salva per battuta
  crossfader, EQ e filtri con le caratteristiche dei due brani, in locale; sarebbero dati puliti (niente
  allineamento né stima) e nel tuo stile.
- **Filtro:** con 3 bande non si distingue dall'EQ; la v1 non lo usa. Servirebbero più bande nella stima o le tue
  transizioni registrate.
- **Ingressi del modello:** mancano tonalità ed energia (1-10); il 3/4 non è gestito (l'app ragiona in battute da 4).
- **Tempo dell'analisi AI:** sulla tua musica non migliora il BPM e costa 5 volte il classico; resta utile per la
  battuta forte (aggancio delle frasi dell'AI DJ). Da decidere se tenerla come predefinita.
- **Remix e mashup** (richiesta nuova): vedi sotto.

### Prossimi passi

- **Mashup:** separare voce e base con Demucs e sovrapporre la voce di un brano alla base di un altro compatibile
  (tonalità e tempo, sulla griglia di battute). Prima di usarlo va chiarita la **licenza dei pesi**: il codice è MIT,
  ma htdemucs è addestrato anche su MUSDB18-HQ (solo ricerca non commerciale) e il README non parla dei pesi.
  Poi: fattibilità dell'export ONNX, tempo e RAM su CPU da misurare, risultati salvati su disco come per l'analisi.
- **Remix dal vivo:** l'AI DJ può già usare loop, beat jump, effetti e filtri sulla griglia: un "modo remix" che
  suona un brano ricomponendone le sezioni (intro, build-up, drop) non richiede modelli nuovi.
- Registrazione delle transizioni dell'utente e rifinitura del modello C sui dati reali.

---

## Giorno 3 — 27 settembre 2026 (remix, mashup, analisi ibrida, dati in zip)

### Fatto

- **Analisi ibrida** (punto 3): il classico dà subito BPM, tonalità, forma d'onda e struttura; con il motore AI
  Beat This! rifinisce poi in background griglia, battuta forte e struttura. Un deck in riproduzione cambia solo
  fase e battuta forte (chi è in sync non salta); la libreria passa prima tutta dal classico, poi dalla rifinitura;
  l'AI DJ aspetta la rifinitura del brano entrante prima di pianificare; le griglie corrette a mano non si toccano.
- **Mashup** (punto 2): Demucs v4 (`htdemucs`) esportato in ONNX senza STFT (`ml/mashup/export_demucs.py`), STFT,
  ISTFT e divisione in blocchi di `apply_model` riscritte in JavaScript (`src/renderer/js/dsp/demucs.js`), worker di
  separazione che si chiude a fine brano, voce e base salvate su disco (`userData/stems`). Il modello (174 MB) non è
  nell'installer: si scarica dal pannello AI DJ la prima volta, con verifica SHA-256. Deck: pulsante **STEM**
  (completo / solo voce / solo base, scambio senza fermare il brano). AI DJ: opzione **Mashup**.
- **Remix dal vivo** (punto 2): opzione dell'AI DJ; pianificatore puro (`src/renderer/js/ai/remix.js`) con loop
  roll, eco, filtro in salita e ripetizione della frase, sui confini di frase, mai nelle 2 frasi prima di un mix.
- **Pacchetti in zip per le transizioni umane** (punto 1): vedi sotto.

### Numeri misurati

#### 1. Analisi ibrida nell'app vera (`ml/eval/electron/hybrid.js`)

Brano non analizzato caricato sul deck (con altri processi pesanti in esecuzione): brano pronto 0,5 s, **BPM classico
a 2,2 s**, rifinitura AI a 11,1 s (offset spostato da 0,393 alla battuta forte vera 1,016 s, struttura ricalcolata).

#### 2. Demucs in ONNX

| | File | Differenza da PyTorch (SDR) | Tempo per blocco di 7,8 s |
|---|---|---|---|
| fp32 (ONNX Runtime Python, CPU) | 174 MB | 65-87 dB (errore relativo 1,4·10⁻⁸) | 2,06 s |
| int8 (ONNX Runtime Python, CPU) | 85 MB | voce 19,1 dB, altre 38-45 dB | 1,48 s |

PyTorch su CPU (con carico in background): 130 s per un brano di 310 s (0,42× tempo reale), picco 3,6 GB.

Separazione completa in JavaScript (`demucs.js` + onnxruntime-web, Node, 4 thread) di 30 s di "Realizer", contro
`demucs.apply_model` di PyTorch (`ml/mashup/bench_separate.mjs`):

| Modello | Opzioni di memoria | Tempo (× tempo reale) | SDR voce / base contro PyTorch | Picco RAM |
|---|---|---|---|---|
| **fp32** | predefinite | 21,5 s (0,72×) | **43,2 / 75,9 dB** | 3004 MB |
| fp32 | senza arena né piani di memoria | 21,5 s (0,72×) | 43,2 / 75,9 dB | 3026 MB |
| int8 | predefinite | 21,6 s (0,72×) | 25,4 / 59,4 dB | 2777 MB |

In WASM l'int8 non è più veloce e peggiora la voce: si usa l'fp32. La memoria WASM non si restringe: per questo
la separazione gira in un worker per brano che poi si chiude.

STFT/ISTFT JavaScript contro Demucs (`test/demucs.test.js`): spettro entro 1·10⁻⁴ relativo; ISTFT esatta al centro
del blocco (1·10⁻⁵) e identica a Demucs ai bordi (dove anche Demucs non ricostruisce il segnale: frame scartati da
`_spec`, errore 0,185 sia in Python che in JS).

#### 3. Pacchetti in zip con transizioni (punto 1)

| Pacchetto | Contenuto | Licenza | Utilità |
|---|---|---|---|
| [dj_mix_ground_truth_extractor_dataset.zip](https://github.com/werthen/dj-mix-ground-truth-extractor) (6,4 GB, tesi Università di Gand 2018) | 5 mix (4 Mixotic + 1 NCS) in WAV, 62 brani originali, progetti Ableton, JSON con posizione, stretch e **automazioni del crossfader** | codice MIT, dataset non dichiarata | ~50 transizioni umane esatte (niente allineamento), ma **solo crossfader** (nei progetti non c'è EQ); mix ricreati dall'autore della tesi |
| [UnmixDB](https://zenodo.org/records/1422385) (6 zip, 4,2 GB) | estratti di 20 s di inizio/fine dei brani Mixotic e mix rigenerati con dissolvenze lineari | CC BY-NC-ND 4.0 | nessun gesto umano; non commerciale e senza opere derivate |
| [Mixotic.net DJ Set archive](https://archive.org/details/mixotic.net_202209) (297 mix, 36 GB) | mix umani in MP3 | Creative Commons (per il sito) | mix umani con licenza pulita, ma i brani originali vanno cercati uno per uno sulle netlabel |

Scaricato in locale solo il primo (in `ml/data/werthen`, fuori da git).

#### 4. Mashup nell'app vera (`ml/eval/electron/mashup.js`)

Sessione realistica: coda Miami Viceroy (268 s, 124 BPM) → Electro Cabello (191 s, 117 BPM), tonalità fissata a La
minore per entrambi; il primo brano separato prima di partire (in una sessione vera lo si fa quando è "il prossimo"),
il secondo mentre il primo suona. Volume master a zero.

| | |
|---|---|
| Separazione Miami Viceroy (268 s) | 157 s (0,59× tempo reale) |
| Separazione Electro Cabello (191 s) | 112 s (0,59×) |
| Download del modello dall'app (174 MB, SHA-256 verificato, prova a parte) | 10,8 s |
| Sequenza eseguita | base del primo + voce del secondo dal punto 32,9 s (prima frase cantata), crossfader al centro per 16 battute (31,0 s), poi il secondo torna completo e il primo sfuma in 8 battute (fine a 46,4 s); deck di nuovo "completo" alla fine |

RAM di tutti i processi dell'app:

| Fase | Totale | Renderer (con i worker) |
|---|---|---|
| Separazione senza mix | 3853 MB | 3506 MB |
| **Mix + separazione del brano successivo** | **5241 MB** | 4881 MB |
| Mashup (dopo la separazione) | 4086 MB | 3674 MB |

La separazione sta dentro il tetto di 6 GB ma lo avvicina: è l'unica fase oltre i 4 GB. Con la versione precedente
del codice (copia normalizzata dell'intero brano, separazione anche del brano in onda) il picco era 5732 MB.

Prima prova senza tonalità fissata: la stima classica della tonalità ha dato valori diversi dalla misura precedente
sugli stessi brani (la tonalità dipende dalla frequenza di campionamento del contesto audio) e il piano ha scelto
il filtro: il mashup non è partito, correttamente. Seconda prova senza pre-separazione: voce e base non pronte in
tempo, transizione normale con avviso nel diario (il ripiego funziona).

### Problemi aperti

- **RAM della separazione:** 5,2 GB in tutto durante il mix. Su computer da 8 GB conviene preparare i mashup prima
  del set (pulsante STEM sui brani della coda) invece che durante. Si potrebbe ridurre il picco dividendo il modello
  in due parti ONNX: da provare.
- **Primo brano della sessione:** non è stato "il prossimo" di nessuno, quindi non è separato in anticipo; il primo
  mashup possibile è tra il secondo e il terzo brano, a meno di premere STEM prima.
- **Tonalità:** la stima classica non è stabile (vedi sopra) e decide se il mashup è possibile; un modello di
  tonalità con licenza MIT/Apache migliorerebbe mashup e scelta dei brani.
- **Licenze:** pesi di Demucs e dataset della tesi di Gand senza licenza dichiarata (uso deciso dall'utente, solo in
  locale per il dataset).
- **Ascolto:** remix e mashup sono provati nel funzionamento, non nel risultato musicale: serve il tuo orecchio.

### Prossimi passi

- Rifinire il modello C sul crossfader con le ~50 transizioni umane del pacchetto di Gand (serve il tuo via, licenza
  non dichiarata) e, meglio ancora, con le tue transizioni registrate nell'app.
- Ridurre la RAM della separazione e aggiungere "prepara i mashup della coda" prima del set.
- Scelta dei brani per il mashup guidata dalla presenza della voce (energia della parte vocale).

---

## Giorno 4 — 27 settembre 2026 (modello C v2: crossfader umano dal dataset di Gand)

### Fatto

- Su tua indicazione ho usato il dataset della tesi di Gand (Werthen-Brabants 2018) **solo in locale**
  (`ml/data/werthen`, licenza non dichiarata). Unità verificate sui dati: tempi in secondi (l'ultima clip finisce
  esattamente alla durata del mix), crossfader 0 = lato A, 1 = lato B, e tempo nel brano = offset + (t - inizio
  clip) × stretch (BPM del brano × stretch = BPM del set, scarto medio 0,9-1,9 BPM contro 3,3-10,8 dell'ipotesi
  opposta).
- Caratteristiche per battuta dei 62 brani originali (`gand_features.py`), 26 transizioni con finestra entro 128
  battute (`gand_dataset.py`; 20 escluse perché più lunghe, tutto il set 281 è fatto di fusioni lunghissime).
- Rifinitura (`train.py --gand-cv / --gand-final`) partendo dalla v1: lotti di 16 transizioni umane + 16
  sintetiche; sulle umane la perdita guarda **solo il crossfader** (EQ e filtri non ci sono e non si forzano a zero,
  il mixer differenziabile è spento), sulle sintetiche tutto come prima. Così il modello non disimpara il bass swap.
- **v2** esportata in ONNX, nella release `models-v1` e nell'app al posto della v1.

### Numeri misurati

Validazione incrociata, un set tenuto da parte alla volta (4 set con transizioni, 26 in tutto, media pesata):

| | Errore crossfader | Errore inizio (0,1) | Errore metà (0,5) | Errore fine (0,9) | Metà su battuta forte |
|---|---|---|---|---|---|
| **Rifinito (400 passi, lr 1e-4, 16 sintetiche)** | **0,113** | **3,1 battute** | **12,2** | 3,8 | 77% |
| Rifinito (1000 passi, lr 2e-4, 8 sintetiche) | 0,119 | 2,7 | 12,7 | 3,8 | 81% |
| v1 | 0,120 | 4,2 | 13,0 | 3,9 | 77% |
| Regole: bass swap | 0,117 | 3,9 | 12,2 | 3,5 | 66% |
| Regole: dissolvenza | 0,124 | 6,9 | 12,2 | 4,2 | 66% |
| Umano | — | — | — | — | 85% |

Scelto il primo assetto: migliora la v1 su tutte le misure del crossfader senza peggiorarne nessuna. Il guadagno è
**piccolo** e, con 26 transizioni fatte con il solo crossfader, dentro il rumore statistico: l'errore sul momento a
metà resta di circa 12 battute per tutti (le persone muovono il crossfader in modo asimmetrico: aspettano e poi
chiudono in fretta).

Controllo che la v2 non abbia perso il resto (256 transizioni sintetiche da 94 brani della chiavetta mai visti):

| | Errore crossfader | Errore EQ | Errore del mix | Scontro bassi | Eventi su battuta forte | su frase |
|---|---|---|---|---|---|---|
| v1 | 0,082 | 0,060 | 0,85 dB | 0,1% | 90% | 67% |
| v2 | 0,085 | 0,061 | 0,89 dB | 0,1% | 93% | 65% |

ONNX v2: fp32 identico a PyTorch; int8 errore medio 0,0021. Prova nell'app vera (`autodj-model.js`): transizione
del modello eseguita con bass swap.

### Problemi aperti e prossimi passi

- I dati umani sono pochi e solo di crossfader: la strada migliore resta **registrare le tue transizioni**
  nell'app (crossfader, EQ e filtri per battuta), che darebbe anche gli EQ.
- Le 20 transizioni lunghe (oltre 128 battute) richiederebbero una finestra più lunga o un modello a passi.
