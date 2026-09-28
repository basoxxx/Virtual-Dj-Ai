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

---

## Giorno 5 — 27 settembre 2026 (modello C v3: "addestrala meglio")

### Fatto

- **La chiavetta:** le "Zarro Mix" non sono mix continui (ai confini tra tracce c'è silenzio, fino a -180 dB), quindi
  niente transizioni già fatte; l'unico DJ mix vero ("Noblemo – MIX Electro night spirit", 24,5 min) usa brani che
  non sono sulla chiavetta (le "corrispondenze" trovate cadono tutte negli stessi due punti del mix: falsi
  positivi). I remix e i brani da club servono però al generatore: **344 brani "da DJ"** (remix, club/extended mix,
  cartelle Techno/House/CROSSFADER/Zarro Mix, generi elettronici, più quelli del DJ Mix Dataset) pesano 3 volte gli
  altri, dimezzati se il tempo è irregolare; il brano uscente esce spesso sul suo **outro vero** (calo di energia
  finale, trovato su 178 brani).
- **Stile "umano" nel generatore:** in 1 transizione su 3 il crossfader ha la forma e la durata di una delle 45 curve
  umane di Gand (anche quelle lunghe, prima escluse), parte su una battuta forte (spesso a inizio frase) e il bass swap
  cade dove l'umano passa la metà (6 volte su 10).
- **Finestre variabili sui dati umani:** ogni transizione anche con la finestra anticipata di 4, 8, 16 e 32 battute e
  allungata di 8 (119 finestre): il modello deve decidere *quando* muoversi guardando la musica, come nell'app.
- **v3:** v1 + 1500 passi sul nuovo sintetico + rifinitura sulle finestre umane. Nella validazione incrociata le
  forme umane del set di test non entrano nel generatore.

### Numeri misurati (validazione incrociata, 26 transizioni, media pesata)

| Finestra | | v3 | v2 (ricalcolata per fold) | v1 | Regole: bass swap | Regole: dissolvenza |
|---|---|---|---|---|---|---|
| Stretta (dal movimento) | errore crossfader | **0,111** | 0,117 | 0,120 | 0,117 | 0,124 |
| | errore fine | 3,8 | 3,9 | 3,9 | 3,5 | 4,2 |
| | metà su battuta forte | 77% | 73% | 77% | 66% | 66% |
| **Larga** (16 battute prima, 8 dopo: come nell'app) | errore crossfader | **0,088** | 0,120 | 0,111 | 0,117 | 0,092 |
| | errore inizio | **7,1** | 11,5 | 11,1 | 10,9 | 7,1 |
| | errore fine | **2,3** | 2,6 | 2,9 | 2,8 | 2,5 |
| | metà su battuta forte | 84% | 84% | 60% | 88% | 88% |

Con la finestra stretta le differenze sono nel rumore (la stessa v2 ha dato 0,113 in un'altra esecuzione). Con la
finestra larga la v3 riduce l'errore del **27% rispetto alla v2** e fa meglio di entrambe le regole: sa aspettare e
poi muoversi. Il momento a metà resta difficile (8,9 battute di errore contro 7,6 della dissolvenza).

Sul vecchio test sintetico (256 transizioni da brani mai visti) la v3 conserva gli EQ: errore EQ 0,059 (v1 0,060),
mix 0,88 dB (v1 0,86), scontro dei bassi 0,6% (v1 0,1%); eventi su inizio frase 60% contro 68%, perché segue di più i
tempi umani (le persone di Gand partono raramente a inizio frase).

ONNX v3: fp32 identico a PyTorch, int8 errore medio 0,0021. Nell'app vera (`autodj-model.js`) la transizione del
modello esegue bass swap e crossfader completo. **La v3 sostituisce la v2 nell'app.**

### Problemi aperti

- Tutti i dati umani sono di una sola persona, con il solo crossfader: gli EQ restano quelli del maestro sintetico.
  Le tue transizioni registrate nell'app resterebbero la fonte migliore.

## Giorno 6 — 27 settembre 2026 (modello C v4: "cerca esempi di DJ veri e copiali")

### Fatto

- **DJ set veri con i brani originali:** su Internet Archive ([mixotic.net_202209](https://archive.org/details/mixotic.net_202209),
  Creative Commons) ci sono i mix **originali** dei quattro set Mixotic ricreati nella tesi di Gand (044, 123, 281,
  286: 77,8 + 55,7 + 60,0 + 52,7 min). I loro brani sono i "refsongs" del dataset di Gand, gli stessi file digitali:
  per la prima volta ci sono DJ veri con crossfader, fader **ed EQ**, e brani originali esatti. Mix scaricati e usati
  solo in locale (`ml/data/mixotic/`), come il dataset di Gand.
- **Allineamento** (`align_mixotic.py`): la ricostruzione di Gand segue la timeline dei mix originali; da inizio clip,
  punto di partenza e stretch si ricava la diagonale attesa di ogni brano e la si cerca solo entro ±64 battute. Senza
  questo indizio i set 281 e 286 mettevano metà dei brani nei primi 8 minuti; con l'indizio **45 brani su 55**
  allineati, quasi tutti a 0-2 battute dalla diagonale attesa nei set 044 e 286 (fino a 30-50 battute nel 123 e nel 281:
  la ricostruzione deriva leggermente).
- **Tratto suonato:** il riconoscimento per somiglianza trova spesso solo parte del brano (break, dissolvenze lunghe) e
  le coppie non risultano contigue (14 transizioni). Con le clip di Gand spostate sulla diagonale trovata: 24.
- **Curve del DJ** (`mixotic_dataset.py`, stessa stima di `gains.py` su 64 sotto-bande): con la levigatura di prima
  le curve degli EQ saltavano da una battuta all'altra (due casse techno simili sono ambigue). Su set 044 + 286:

  | Levigatura | Errore del fit | Variazione crossfader per battuta | Variazione EQ per battuta |
  |---|---|---|---|
  | 1 (prima) | 0,138 | 0,056 | 0,106 |
  | 4 | 0,153 | 0,023 | 0,065 |
  | **16** (scelta) | 0,176 | 0,007 | 0,028 |
  | 64 | 0,193 | 0,005 | 0,010 |

  Nei grafici (`ml/data/mixotic/plots/`) si vedono bass swap veri: bassi di B tagliati mentre suona A, poi scambio.
- **Dataset:** 22 transizioni con errore del fit ≤ 0,5 (mediana 0,265; il DJ Mix Dataset aveva 0,537). Sono
  **lunghe**: mediana 192 battute (min 33, max 276), 17 su 22 oltre le 128 dell'app. Finestre: dall'entrata di B
  (anche anticipata di 4/8/16 battute) e, per quelle lunghe, quella che finisce con l'uscita di A: 59 finestre.
  Pesi: crossfader 1, EQ 0,5 scalato sull'udibilità del proprio deck, filtri 0 (non stimati); mixer differenziabile
  attivo (le potenze del mix sono note).
- **Controllo indipendente:** l'istante in cui il crossfader stimato dal mix vero passa metà corsa dista da quello
  della ricostruzione di Gand **12 s in mediana** su 15 transizioni (set 044: 0,3-10 s).
- **v4** (`train.py --v4-cv --v4-final`): v3 + 800 passi, lr 1e-4, lotti da 20 reali (metà Gand, metà Mixotic) +
  12 sintetici con le forme umane. 12 minuti in tutto per 4 fold + modello finale (M1 Pro, MPS).

### Numeri misurati

Validazione incrociata: un set tenuto da parte alla volta (anche dai dati di Gand), finestre dall'entrata di B e
finali, 39 finestre in tutto, media pesata (`ml/data/runs/v4-cv.json`).

| Sui DJ set veri tenuti da parte | **v4** | v3 | Regole: bass swap | Regole: dissolvenza | DJ vero |
|---|---|---|---|---|---|
| Errore crossfader | **0,208** | 0,227 | 0,235 | 0,261 | |
| Errore EQ | **0,153** | 0,202 | 0,206 | 0,104¹ | |
| Errore del suono rispetto al mix (dB) | **2,07** | 2,11 | 2,22 | 2,15 | |
| Errore d'inizio (battute) | **10,5** | 16,8 | 18,0 | 25,8 | |
| Errore di fine (battute) | **19,7** | 25,3 | 23,6 | 27,7 | |
| Scontro dei bassi | 9,2% | 0,9% | 0% | 18,1% | 12,3% |
| Eventi a inizio frase | 34% | 68% | 8% | 8% | 9% |

¹ La dissolvenza non tocca gli EQ e il DJ li tocca poco quando il proprio deck è pieno: l'errore EQ medio favorisce
chi li lascia fermi, per questo conta di più l'errore del suono.

La v4 è più vicina ai DJ veri in tutte le misure d'imitazione: -8% sul crossfader, -24% sugli EQ, 6 battute in meno
d'errore sull'inizio. Sovrappone di più i bassi, come fanno davvero questi DJ techno nelle loro dissolvenze lunghe.

Sul test sintetico di sempre (256 transizioni da brani mai visti, tutti i generi, `v3-v4-synth.json`) la v4 resta
pulita: errore crossfader 0,097 (v3 0,093), EQ 0,057 (0,056), mix 0,93 dB (0,92), scontro dei bassi 0,9% (0,4%;
maestro sintetico 2,2%), eventi a inizio frase 60% (62%).

Sul crossfader di Gand, finestra larga, set tenuti da parte: 0,097 su 17 finestre di 3 set. La v3 aveva 0,088 nella
sua validazione (26 transizioni di 4 set): non è lo stesso sottoinsieme, ma è un possibile piccolo peggioramento sul
singolo DJ di Gand.

ONNX v4: fp32 identico a PyTorch, int8 errore medio 0,003 (massimo 0,20). Nell'app vera (`autodj-model.js`): piano
"del modello AI", crossfader completo e bass swap. `npm run check` 64/64, `npm test` 88/88. **La v4 sostituisce la v3
nell'app** (6,8 MB, nella release `models-v1`).

### Beta 1.6.0

Nuovo workflow `.github/workflows/beta.yml`: un tag `v1.6.0-beta.1` sul branch costruisce gli stessi installer e
pubblica una **pre-release** (non "latest": sito e aggiornamenti automatici restano sulla 1.5.6), con le note di
`docs/release-notes/v1.6.0-beta.1.md` su come funziona l'AI e com'è fatto il modello. Versione in `package.json`
portata a 1.6.0, così la 1.6 stabile aggiornerà anche chi ha la beta.

### Problemi aperti

- Solo 4 DJ, tutti techno/minimal, e 22 transizioni: la v4 imita le dissolvenze lunghe di questo genere. Altri set
  Mixotic su Internet Archive (222, 230, 275) non hanno i brani originali.
- Il tratto suonato viene dalla ricostruzione di Gand: dove la ricostruzione sbaglia, sbaglia anche la finestra.
- Le transizioni vere durano spesso più di 128 battute: l'app per ora ne pianifica al massimo 32 (128 battute).

## Giorno 7 — 28 settembre 2026 (modello C v5 nel cloud: più generi, transizioni lunghe, crossfader di Gand)

Addestramento in un container cloud (4 CPU Xeon con AVX-512, 15 GB, niente GPU), con 2 ore di tempo in tutto.
**Esito: la v5 non sostituisce la v4 nell'app.** Toglie quasi del tutto lo scontro dei bassi, ma imita i DJ veri
peggio della v4 (vedi i numeri). Codice e dati sono pronti per rifarla meglio sul Mac (v6).

### Fatto

- **Pesi da ONNX** (`onnx_to_pt.py`): i checkpoint della v3 e della v4 ricavati dai file fp32 della release `models-v1`
  (uscita identica a onnxruntime entro 1·10⁻⁶), così si riparte dalla v4 anche senza i `.pt` originali.
- **Ricostruzione verificata:** con gli stessi dati scaricati da zero (dataset di Gand da Google Drive, mix Mixotic da
  Internet Archive) i dataset tornano identici a quelli della v4: Gand 26 transizioni e 119 finestre (20 escluse
  oltre 128 battute); Mixotic 22 transizioni, 59 finestre, fit mediano 0,265, metà crossfader contro Gand 12,0 s.
- **Finestra da 256 battute** (obiettivo 2): `model.py` (i checkpoint da 128 si allargano al caricamento, stesse uscite
  sulle finestre corte), `--window 128|256` nei costruttori dei dataset, lunghezze sintetiche fino a 256; l'ingresso
  "lunghezza" resta L/128. Con 256 le transizioni di Gand diventano **41** (5 escluse invece di 20).
- **Set Mixotic nuovi** (`mixotic_new_dataset.py`): tracklist dei set 222, 230, 275, 278, 282, 285 dai tag MP3 dei mix;
  37 brani originali su 82 trovati su Internet Archive (netlabel, Creative Commons, molti non commerciali; il set 278
  nessuno). Senza la ricostruzione di Gand l'allineamento è debole: **solo 3 transizioni affidabili** (set 285, fit
  0,22-0,28). Negli altri set quasi nessun brano supera z ≥ 6; allargare le soglie (z ≥ 5) non ne aggiunge.
  I link del "mixotic set" della JKU (Sonnleitner et al. 2016, tutti i brani originali) su Google Drive chiedono il login.
- **Più generi** (obiettivo 1, `jamendo_features.py`): 40 brani MTG-Jamendo completi, 4 per gruppo (pop, rock, hip hop,
  funk/soul, reggae/latin, house/techno, dance/trance, bass, chill, elettronica), più i 62 brani di Gand e i 37 dei set
  nuovi nel generatore. Fuori dai generi da club la curva "umana" del generatore scambia sempre i bassi.
- **App** (senza cambiare modello): finestra per versione del modello (`TRANSITION_MODEL_BEATS`, 128 per la v4, 256 per
  la v5); 48 e 64 battute nel pannello AI DJ; con il modello, se le battute superano la finestra la transizione si
  accorcia e il diario lo dice.
- **v5** (`train.py --v5-final`): v4 + 400 passi (la v4 ne aveva 800: limite di tempo), lr 1e-4, lotti da 20 reali
  (un terzo Gand, un terzo Mixotic, un terzo set nuovi) + 12 sintetici. 30 minuti su 2 thread.

### Numeri misurati

Validazione su **un solo gruppo** (`train.py --v5-cv --v5-held set044,set285 --v5-steps 400`, `v5-cv.json`): la v5 è
addestrata senza i set 044 e 285; la v4 è quella rilasciata, che il 044 (Gand e Mixotic) lo **ha visto** in
addestramento: il confronto la favorisce. Non c'è stato tempo per `--v4-baseline` (v4 rifatta senza il gruppo).

| Mixotic tenuti da parte, finestre da 128 (17) | v5 | v4 | Regole: bass swap | Regole: dissolvenza | DJ vero |
|---|---|---|---|---|---|
| Errore crossfader | 0,186 | **0,137** | 0,190 | 0,211 | |
| Errore EQ | 0,156 | **0,092** | 0,194 | 0,092 | |
| Errore del suono (dB) | 1,60 | **1,53** | 1,71 | 1,68 | |
| Errore d'inizio / fine (battute) | 18,0 / 13,5 | **7,5 / 6,3** | 20,8 / 15,9 | 27,7 / 23,0 | |
| Scontro dei bassi | **4,3%** | 15,3% | 0% | 18,7% | 12,7% |
| Eventi a inizio frase | 47% | 36% | 6% | 6% | 6% |

Transizioni intere oltre 128 battute (7, fino a 256): errore crossfader v5 0,199, v4 0,180 (con la finestra
allargata), scontro dei bassi v5 7,6%, v4 24,7%, DJ vero 13%.

Crossfader di Gand, finestra larga, set 044 (9 finestre): v5 0,082, v4 0,055, dissolvenza 0,078. **L'obiettivo 3 non è
raggiunto** (anche tenendo conto del vantaggio della v4 su questo set).

Generi (`ml/eval/genre_eval.py`, 96 transizioni sintetiche per gruppo; brani anche nel generatore della v5, quindi è
un controllo di comportamento): scontro dei bassi fuori dai generi da club **v5 0,8%**, v4 2,4% (dissolvenza 13,8%);
generi da club v5 0,7%, v4 4,2%. Errore EQ contro il maestro sintetico: v5 0,052, v4 0,066.

ONNX v5 (256 × 35 → 256 × 9): fp32 identico a PyTorch, int8 errore medio 0,0023 (massimo 0,17), 6,9 MB. Con la v5 al
posto della v4 in `transition-planner.js` il test di parità con onnxruntime-web passa (7/7). `npm run check` 64/64,
`npm test` 88 (82 passati, 6 saltati senza modelli scaricati, 0 falliti).

### Lettura

La v5 ha imparato le due regole nuove (scambiare i bassi, stare sulle frasi) ma ha perso i tempi dei DJ veri: parte
circa 10 battute più lontano dal momento giusto. Cause probabili, da verificare sul Mac: metà dei passi della v4; un
terzo delle estrazioni reali su sole 4 finestre dei set nuovi (ripetute moltissimo); il generatore con le lunghezze
lunghe, che sposta il peso verso curve sintetiche.

### Per la v6 (sul Mac)

- Partire dalla v4 (`planner-v4.pt`, o `onnx_to_pt.py` dal file della release) con 800+ passi e `--v4-baseline` su tutti
  i gruppi (`--v5-cv` senza `--v5-held`): serve il confronto giusto.
- Quote delle fonti proporzionali ai dati (`V5_SHARES` in `train.py`): i set nuovi con 3 transizioni non devono pesare
  un terzo.
- Allineamento dei set nuovi: guardare le matrici di somiglianza (z tra 4 e 6) e usare le tracklist con i tempi, se si
  trovano; cercare il "mixotic set" della JKU con i brani originali di tutti i 10 set.
- Più generi con transizioni vere: servono mix non techno con i brani originali (per esempio le tue transizioni
  registrate nell'app).
- Per passare l'app alla v5 (o v6): caricare i file ONNX nella release `models-v1`, aggiungerli a
  `src/main/models.json`, cambiare `TRANSITION_MODEL` e `TRANSITION_MODEL_BEATS` in `transition-planner.js` e
  rigenerare `test/fixtures/transition-model/reference.json` con `export_onnx.py`.

I file della v5 (ONNX fp32 e int8, riferimenti per i test, risultati) sono sul branch `modello-v5-scartato`, in
`ml/modello-scartato/v5`, fuori dalla beta; il checkpoint PyTorch si ricava con
`onnx_to_pt.py ml/modello-scartato/v5/transition-planner-v5.onnx ml/data/runs/planner-v5.pt`.

## Giorno 8 — 28 settembre 2026 (modello C v6 sul Mac)

Punto di partenza: `main` (Segueo 1.6.10) con il codice della v5 (#13). I file della v5 scartata (ONNX, riferimenti,
risultati) sono sul branch `modello-v5-scartato`, fuori da `main`.

### Fatto

- **Dati ricostruiti sul Mac** con il codice della v5: Gand 41 transizioni e 204 finestre fino a 256 battute (26 e 119
  fino a 128), Mixotic 22 transizioni (46 finestre fino a 256, 59 fino a 128). Identici a quelli del cloud.
- **"Mixotic set" della JKU** (Sonnleitner et al. 2016: 10 set, 723 brani originali, confini dei brani annotati,
  CC BY-NC-ND 3.0): approvato da te per l'uso in locale, ma i tre link Google Drive della pagina
  [cp.jku.at/datasets/fingerprinting](https://www.cp.jku.at/datasets/fingerprinting/) negano l'accesso anche con il
  login (link vecchi senza chiave: servono i permessi del proprietario). Su tua decisione non ho chiesto l'accesso.
  Non ho rifatto nemmeno i set Mixotic nuovi della v5 (3 transizioni, tracklist e brani messi insieme a mano nel cloud).
- **Più generi:** 159 brani MTG-Jamendo (16 per gruppo, 15 per "bass") invece di 40. Un brano su 4 per gruppo (39)
  resta fuori dal generatore (`split: test` in `selection.json`): il test dei generi ora è su brani mai visti.
  12 minuti di estrazione delle caratteristiche.
- **Correzioni:**
  - generatore: con le finestre da 256 un brano uscente più corto della finestra mandava gli indici fuori dal brano;
  - `genre_eval.py` sul dispositivo dell'addestramento (MPS);
  - `export_onnx.py`: il controllo di parità con il dataset da 128 battute ora funziona anche sul modello da 256;
  - `autodj-model.js`: `BARS=64` per provare le transizioni lunghe nell'app vera.
- **Ricetta v6** (`train.py --v5-cv --v5-final --v4-baseline --tag v6 --v5-steps 1000 --v5-synth-share 8
  --v5-shares gand=1,mixotic=1`), con le correzioni suggerite dal giorno 7:
  - parte dalla v4 con 1000 passi (la v5 ne aveva 400);
  - lotti da 24 transizioni reali, metà Gand e metà Mixotic, più 8 sintetiche (la v5 ne aveva 12);
  - finestre fino a 256 battute;
  - generatore con lunghezze fino a 256 e 10 gruppi di genere.
  
  Il confronto è finalmente giusto: per ogni gruppo tenuto da parte si rifà anche la v4 (stessa ricetta e stessi
  dati della v4, senza quei set). 4 gruppi (044, 123, 281, 286 + NCS), 7,7 minuti per gruppo più 5 per il modello
  finale (M1 Pro, MPS).

### Numeri misurati

Mixotic tenuti da parte, stesse finestre della valutazione della v4 (fino a 128 battute, 39 finestre; `v6-cv.json`):

| | **v6** | v4 rifatta | Regole: bass swap | Regole: dissolvenza | DJ vero |
|---|---|---|---|---|---|
| Errore crossfader | **0,193** | 0,201 | 0,235 | 0,261 | |
| Errore EQ | 0,154 | **0,150** | 0,206 | 0,104 | |
| Errore del suono rispetto al mix (dB) | **1,96** | 2,05 | 2,22 | 2,15 | |
| Errore d'inizio / fine (battute) | 12,3 / **21,7** | **9,1** / 22,4 | 18,0 / 23,6 | 25,8 / 27,7 | |
| Scontro dei bassi | 7,1% | 8,2% | 0% | 18,1% | 12,3% |

Transizioni intere:
- **Corte** (fino a 128 battute, 5): crossfader **0,148** contro 0,192, EQ **0,159** contro 0,181, suono
  **1,99** contro 2,13 dB.
- **Lunghe** (129-256 battute, 17): crossfader **0,192** contro 0,198, EQ 0,150 contro **0,131**, suono 1,97 contro
  **1,92** dB, fine 30,8 contro **26,6** battute, scontro dei bassi 12,3% contro 14,7% (DJ vero 12,1%).

Crossfader di Gand con la finestra larga, set tenuti da parte (23 finestre): v6 **0,065**, v4 rifatta 0,099,
dissolvenza 0,098, bass swap 0,120. Con finestre fino a 256 battute (41): **0,125** contro 0,154.
L'obiettivo mancato dalla v5 (non peggiorare sul crossfader di Gand) ora è raggiunto.

La v4 rilasciata sugli stessi dati ha 0,066 di errore del crossfader: ha visto tutti questi set in addestramento, quindi
il confronto con lei non vale. Era anche il limite del confronto del giorno 7.

Generi (`genre_eval.py`, 39 brani Jamendo **mai visti**, 96 transizioni sintetiche per gruppo; `genre-eval.json`):

| Fuori dai generi da club / generi da club | **v6** | v4 | Regole: dissolvenza |
|---|---|---|---|
| Scontro dei bassi | **0,6% / 0,6%** | 2,3% / 3,7% | 12,6% / 13,5% |
| Errore crossfader | **0,097 / 0,090** | 0,113 / 0,102 | |
| Errore del suono (dB) | **1,10 / 0,98** | 1,33 / 1,08 | |
| Buchi di volume | 4,3% / 4,8% | 3,4% / 4,9% | 4,2% / 3,1% |

ONNX v6 (256 × 35 → 256 × 9): fp32 identico a PyTorch, int8 errore medio 0,0026 (massimo 0,24), 6,9 MB.

Tempo e memoria per transizione (onnxruntime-web WASM, 1 thread, Node, mediana di 10):

| Modello | Finestra | Tempo | Memoria (con il runtime) |
|---|---|---|---|
| v6 | 256 battute | 108 ms | +166 MB |
| v4 | 128 battute | 50 ms | +163 MB |

Si calcola una volta per transizione. `npm run check` 68/68, `npm test` 92/92.

Nell'app vera (`ml/eval/electron/autodj-model.js`):

| Transizione | Piano | Crossfader | EQ |
|---|---|---|---|
| 8 misure | "del modello AI" | completo, metà corsa al 28% della transizione | bass swap |
| 64 misure (256 battute, impossibile con la v4) | "del modello AI" di 64 battute | completo, metà corsa al 43% | bass swap |

**La v6 sostituisce la v4 nell'app** (`TRANSITION_MODEL_BEATS` 256: transizioni del modello fino a 64 misure).

### Problemi aperti

- Rispetto alla v4 rifatta la v6 è più lenta a partire sulle finestre da 128 battute (3 battute in più di errore) e
  un po' peggio sugli EQ delle transizioni lunghe.
- I DJ veri restano 4, tutti techno/minimal. La fonte migliore resta il set della JKU (serve che il proprietario dia
  l'accesso), oppure le tue transizioni registrate nell'app.
- Il branch `claude/modest-allen-h4hn41` ha un commit non unito ("Repository rinominato in Segueo") che punta a
  `basoxxx/Segueo`: il repository su GitHub si chiama ancora `Virtual-Dj-Ai`, quindi il download dei modelli dà 404 e
  la CI fallisce. Prima di unirlo va rinominato il repository su GitHub.

## Giorno 9 — 28 settembre 2026 (modello C v7: le transizioni di Gabry Ponte)

### Fatto

- **Richiesta:** imparare dai DJ set di Gabry Ponte (mashup o mix live). Su tua decisione: audio con copyright solo in
  locale (`ml/data/gabry`), solo per le caratteristiche; nel repository e nella release solo i pesi.
- **Tracklist** da 1001tracklists (388 tracklist di Gabry Ponte), lette dal browser:
  - scartati i live (San Siro 2025: ospiti sul palco, niente tempi né audio);
  - dopo 6 pagine il sito ha chiesto la verifica "umana" e mi sono fermato;
  - SPUTNIK Club, Record Club Guest Mix 135 e DJ Mag Brasil 031 sono lo stesso mix, quindi i mix distinti sono 4:

  | Mix | Durata | Brani | Tempi (cue) |
  |---|---|---|---|
  | 1001Tracklists Spotlight Mix (2026) | 2 h | 34 | sì |
  | EDM Identity Summer Sessions 2026 | 2 h | 36 | no |
  | Tomorrowland Friendship Mix (2026) | 1 h | 19 | sì |
  | SPUTNIK / Ibiza Series 031 (2025) | 1 h | 19 | no |

- **Audio** (`gabry_download.py`):
  - mix dai canali SoundCloud ufficiali;
  - 83 brani su 103 da YouTube, scegliendo la versione con la durata della tracklist (entro 25 s) e il titolo;
  - 20 non trovati, 2 rifiutati (HTTP 403);
  - nessun login né cookie; pause di 6-15 s e arresto automatico ai rifiuti ripetuti.
- **Allineamento** (`gabry_dataset.py`): con i tempi della tracklist ogni brano si cerca solo vicino al suo cue.
  Nello Spotlight Mix 28 brani su 34 sono allineati, quasi tutti a pochi secondi dal cue. Soglie di z provate:
  4/4 → 21 transizioni, 3/3,5 (con e senza tempi) → 27, con errore del fit mediano 0,161 invece di 0,177.
- **Dataset:** 27 transizioni (36 finestre), fit mediano 0,161, metà crossfader a 9 s dal cue (mediana su 13).
  Sono **corte**: mediana 68 battute (min 17, max 104), contro le 192 dei DJ techno di Mixotic. È lo stile
  radiofonico di Gabry Ponte: circa 3 minuti per brano, cambi veloci e a tempo.
- **v7** (`train.py --v5-cv --v5-final --tag v7 --v5-init planner-v6.pt --v5-steps 1000 --v5-synth-share 8
  --v5-shares gand=1,mixotic=1,gabry=1`):
  - parte dalla v6, 1000 passi;
  - lotti da 24 transizioni reali (un terzo Gand, un terzo Mixotic, un terzo Gabry Ponte) più 8 sintetiche;
  - 4 gruppi, ognuno con un set Mixotic e un mix di Gabry Ponte tenuti da parte;
  - 5,2 minuti per gruppo più 5 per il modello finale.

### Numeri misurati

Mix di Gabry Ponte tenuti da parte (27 transizioni). Il confronto con la v6 è giusto: la v6 non ha mai sentito Gabry
Ponte.

| | **v7** | v6 | Regole: bass swap | Regole: dissolvenza | Gabry Ponte |
|---|---|---|---|---|---|
| Errore crossfader | **0,195** | 0,216 | 0,209 | 0,240 | |
| Errore EQ | **0,112** | 0,184 | 0,195 | 0,100 | |
| Errore del suono rispetto al mix (dB) | **1,63** | 1,79 | 2,04 | 1,79 | |
| Errore d'inizio / fine (battute) | **3,2 / 2,2** | 10,3 / 8,2 | 9,1 / 7,5 | 12,5 / 10,5 | |
| Scontro dei bassi | 10,4% | 0,3% | 0,1% | 13,4% | 10,2% |
| Buchi di volume | 2,5% | 3,7% | 3,7% | 2,8% | 4,7% |

**Il prezzo.** Per Mixotic e Gand la v6 qui ha visto tutti i set in addestramento, quindi i suoi numeri di oggi non
valgono. Si confronta la v7 (senza il set tenuto da parte nella rifinitura, ma partita dalla v6) con la
validazione giusta della v6 del giorno 8:

| | v7 | v6 (validazione del giorno 8) |
|---|---|---|
| Mixotic (finestre fino a 128), errore crossfader | 0,199 | 0,193 |
| Mixotic, errore EQ | 0,165 | 0,154 |
| Mixotic, errore del suono (dB) | 2,05 | 1,96 |
| Crossfader di Gand, finestra larga | 0,089 | 0,065 |

La v7 ha preso i cambi più veloci di Gabry Ponte e perde un po' sulle dissolvenze lunghe della techno e sul DJ di Gand.

Generi (39 brani Jamendo mai visti), fuori dai generi da club / generi da club:

| | v7 | v6 |
|---|---|---|
| Scontro dei bassi | 0,7% / 0,7% | 0,6% / 0,6% |
| Errore crossfader | 0,092 / 0,089 | 0,097 / 0,090 |
| Errore del suono (dB) | 1,07 / 0,97 | 1,10 / 0,98 |

ONNX v7: fp32 identico a PyTorch, int8 errore medio 0,0024 (massimo 0,39), 6,9 MB. Stessa architettura e finestra
della v6 (108 ms per transizione, misurati il giorno 8). `npm run check` 68/68, `npm test` 92/92.

Nell'app vera, con i file rinominati:
- transizioni del modello da 8 e da 64 misure, crossfader completo e bass swap;
- mashup con `segueo-separazione-voce.onnx`: separazione in 155 s e 112 s (come prima), sequenza dei deck
  completo → base → base + voce del successivo, RAM di tutta l'app 5,27 GB durante mix e separazione (prima 5,24).

**La v7 sostituisce la v6 nell'app.** È stata scelta per la musica dell'app (dance commerciale e italo dance, lo stile
di Gabry Ponte); chi mixa techno a transizioni lunghe perde un po' (vedi sopra).

### Nomi dei modelli

Su tua richiesta i modelli dell'app hanno il nome dell'app e la funzione:

| Prima | Ora | Funzione |
|---|---|---|
| `beat_this-small0-int8.onnx` | `segueo-analisi-battute.onnx` | battute e battute forti |
| `transition-planner-v6-int8.onnx` | `segueo-transizioni-v7.onnx` | curve delle transizioni dell'AI DJ (ora la v7) |
| `htdemucs.onnx` | `segueo-separazione-voce.onnx` | voce e base per i mashup |

- Byte identici, stesso SHA-256.
- Crediti e licenze (Beat This! e Demucs, MIT) restano in `models.json` e nelle licenze dell'app.
- Nella release `models-v1` restano anche i file con i nomi vecchi: le versioni già installate li scaricano ancora
  così.

### Problemi aperti

- Le transizioni sono 27, di un solo DJ e da 4 mix radiofonici. Per i live (San Siro, mashup con cantanti sul palco)
  servono tempi e audio migliori.
- 1001tracklists blocca dopo poche pagine: per altri mix le tracklist vanno lette a mano.
- Si potrebbero tenere v6 (techno, transizioni lunghe) e v7 (stile Gabry Ponte) come due stili da scegliere nel
  pannello AI DJ.

## Giorno 10 — 28 settembre 2026 (due stili nel pannello; LUM!X)

### Fatto

- **Scelta dello stile nel pannello AI DJ** (Transizioni):
  - "Modello AI · dance (Gabry Ponte)" usa `segueo-transizioni-dance-v7.onnx`;
  - "Modello AI · techno, mix lunghi" usa `segueo-transizioni-techno-v6.onnx`;
  - i file sono la v7 e la v6 con i nomi nuovi (byte identici);
  - `TRANSITION_STYLES` in `transition-planner.js` dà a ogni stile file e finestra;
  - il worker tiene una sessione per modello: cambiare stile non ricarica nulla;
  - il diario dice quale stile ha usato;
  - lo stile dance mantiene il valore `model`, quindi le impostazioni salvate restano valide.
- **LUM!X come DJ di addestramento** (`dj_sets_download.py` e `dj_sets_dataset.py`, generalizzati da quelli di Gabry
  Ponte con `--dj gabry|lumix`; il dataset di Gabry Ponte torna identico: 27 transizioni, fit 0,161):
  - 1001tracklists ora chiede un CAPTCHA, e non lo risolvo;
  - le tracklist vengono dai capitoli YouTube del set all'ADE (SLAM!, 41 min, solo titoli) e dalle descrizioni di
    4 episodi di Spinnin' Sessions con il suo guest mix (468, 492, 537, 542: circa 30 minuti ciascuno);
  - audio dai canali ufficiali (SoundCloud di Spinnin' Sessions, SLAM!) o dall'archivio YouTube di Spinnin';
  - 39 brani su 49 da YouTube (6 titoli dell'ADE non trovati, 4 rifiutati con 403, nessun blocco anti-bot).
- **Risultato: una sola transizione affidabile di LUM!X** (su 10 trovate: 4 con l'ordine incoerente, le altre con
  errore del fit tra 0,6 e 0,8; con la soglia a 0,7 sarebbero 4). Il motivo è lo stile:
  - nei guest mix i brani durano 20-40 s e si sovrappongono a raffica (nell'episodio 468 sette brani cadono tutti tra
    41,7 e 42,7 minuti);
  - molti sono VIP, edit e remix suoi non pubblicati, diversi dalle versioni su YouTube;
  - la stima delle curve richiede tratti in cui ogni brano suona da solo e versioni uguali a quelle suonate.

  **Non ho addestrato una v8** su una transizione ripetuta: avrebbe insegnato rumore. La fonte `lumix` resta in
  `train.py` con quota 0, pronta.
- **Prove:**
  - `npm run check` 68/68, `npm test` 94/94: nuovi test sugli stili del pannello e parità con onnxruntime-web di
    entrambi i modelli;
  - app vera, 16 misure (`STYLE=model|model-techno` in `autodj-model.js`):

  | Stile | Crossfader a metà corsa | Bassi |
  |---|---|---|
  | dance | al 44% della transizione | scambio tra il 63% e il 69% |
  | techno | al 55% | A tagliati al 63%, B mai aperti del tutto |

  - l'etichetta lunga dello stile techno veniva troncata nel pannello: accorciata e ricontrollata in uno screenshot
    dell'app.

### Per LUM!X (se si vuole riprovare)

- Servono set in cui suona brani interi pubblicati, con tracklist a tempi: festival o club, non i guest mix
  radiofonici a raffica.
- Su 1001tracklists si possono leggere se risolvi tu il CAPTCHA nel browser.
- In alternativa si può imparare il suo stile come "tagli a raffica": una transizione corta sul beat, senza curve,
  cioè un nuovo tipo di transizione per l'AI DJ invece di un altro modello.

### Seguito: altri set di LUM!X e DJ Matrix

- **LUM!X:** la ricerca su 1001tracklists ora funziona di nuovo e ha dato 3 mix nuovi con la tracklist completa
  (Record Club Guest Mix 085 e 128, Lizard Print Guest Mix). L'audio però non è pubblico: Record Club va in onda su
  Radio Record e il Lizard Print non si trova su SoundCloud, YouTube o Mixcloud. Su YouTube non ci sono altri suoi
  set con la tracklist (SLAM! aprile 2023, Live from Amsterdam: né capitoli né descrizione).
- **DJ Matrix** (su tua richiesta, stesse condizioni): nessuna tracklist su 1001tracklists (la ricerca trova il club
  Matrix di Brescia e il duo drum & bass Matrix & Futurebound) né nei video. Ho scaricato il suo set per DAPP (2021,
  62 min, audio in streaming) e scritto **`identify_tracks.py`**, che riconosce i brani di un mix senza tracklist
  confrontandolo con i brani già analizzati:
  - 8 campioni da 32 battute per brano, cercati in tutto il mix con un solo prodotto tra matrici;
  - un brano è riconosciuto con il campione migliore a z ≥ 5 e un secondo a z ≥ 3,5 sulla stessa diagonale;
  - tarato sul mix Spotlight di Gabry Ponte, che ha la tracklist: **20 brani su 30 trovati, nessun falso** su 453
    che non ci sono (83 di Gabry Ponte e 400 della chiavetta);
  - sul set di DJ Matrix, contro circa 1.300 brani (chiavetta, Gabry Ponte, LUM!X), trova **un solo brano**
    ("Sono arrivati i caramba", dubbio). I brani che suonava nel 2021 non sono tra quelli che abbiamo.

  Senza tracklist e senza i suoi brani non si possono ricavare le sue transizioni.
- **Nessuna v8:** non sono arrivati dati affidabili nuovi. Lo stile dance resta la v7 (Gabry Ponte).

Per andare avanti con LUM!X o DJ Matrix servirebbe una di queste cose:
1. i loro set in audio con la tracklist (per esempio le registrazioni dei loro programmi radio);
2. i brani che suonano, per esempio da una tua playlist, da confrontare con `identify_tracks.py`;
3. le tue transizioni registrate nell'app sulla stessa musica.

## Giorno 11 — 28 settembre 2026 (tagli a raffica, stile LUM!X)

Le transizioni di LUM!X non si possono imparare con crossfader ed EQ (giorno 10), ma dai suoi set allineati si
misurano i **tempi** del suo stile. Misure sulle 31 coppie consecutive del suo guest mix (seconda metà degli episodi
di Spinnin' Sessions) e del set all'ADE:

| | LUM!X | Gabry Ponte (per confronto) |
|---|---|---|
| Battute suonate per brano (tratto riconosciuto, mediana) | **86** (circa 21 misure, 40 s) | 416 (circa 3 minuti) |
| Entrata del brano successivo dopo il primo 20% | **32%** (spesso intorno alla misura 35) | 11% |
| Entrata sulla battuta forte | 45% | |

(I confini dei tratti riconosciuti sono approssimati: contano l'ordine di grandezza e la quota di entrate "dentro" il
brano.)

### Fatto

- **Nuova transizione "Tagli a raffica (stile LUM!X)"** nel pannello AI DJ (`src/renderer/js/ai/rapid.js`):
  - il brano in onda suona **16 o 24 misure** (in media 20, come le 21 di LUM!X) dal punto in cui è entrato;
  - il cambio dura **1 misura**: l'uscente sale di filtro e perde i bassi nelle ultime 2 battute, poi taglio netto
    sul battere;
  - **una volta su tre** il successivo parte dal suo **drop**. Il drop è la prima frase da 8 misure, dopo la prima,
    con energia della forma d'onda ≥ 85% della frase più forte e un salto rispetto alla precedente; se non c'è, il
    brano parte dal punto di mix normale;
  - il successivo parte una misura prima del taglio, così al taglio è esattamente sul suo punto d'ingresso;
  - il diario dice le misure e il tipo di entrata.
- **Prove:**
  - `test/rapid.test.js`: drop su forma d'onda sintetica, 16/24 misure sulla griglia, entrata sul drop, filtro,
    bassi e taglio, piano dell'AI DJ;
  - `npm run check` 70/70, `npm test` 98/98;
  - app vera (`ml/eval/electron/autodj-rapid.js`, coda di 3 brani, nessun "Mixa ora"): i due cambi li fa da sola.
    Ogni brano resta in onda 46,2 e 46,8 s (24 misure), il cambio dura 1,85 s (una misura), il crossfader salta da un
    lato all'altro alla fine della misura, il brano entrante è in onda a 2 s dal suo punto d'ingresso.
