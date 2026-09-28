# Modello C v5 (scartato)

Addestrata nel cloud il 28/09/2026 (vedi `ml/REPORT.md`, giorno 7). **Non è nell'app:** rispetto alla v4 sovrappone
molto meno i bassi, ma imita peggio i DJ veri (crossfader, EQ, momento d'inizio) e il crossfader di Gand.

| File | Contenuto |
|---|---|
| `transition-planner-v5.onnx` | fp32, ingressi x (1, 256, 35) e mask (1, 256), uscita controls (1, 256, 9); SHA-256 `f647f41fafc01ed1202aa73739a221a734944f7099d50c128e76df7227bdf2f1` |
| `transition-planner-v5-int8.onnx` | int8 dinamico, 6,9 MB; SHA-256 `01e3338301fe11fccfbe25c945f30cce1c05be80ee40c23bded79177282c6fea` |
| `reference.json` | riferimenti per `test/transition-model.test.js` con la v5 |
| `v5-cv.json` | validazione con i set 044 e 285 tenuti da parte |
| `genre-eval.json` | scontro dei bassi per gruppo di genere (Jamendo), v4 contro v5 |

Checkpoint PyTorch (per ripartire da qui):
`ml/.venv/bin/python ml/transitions/onnx_to_pt.py ml/modello-scartato/v5/transition-planner-v5.onnx ml/data/runs/planner-v5.pt`

Per ascoltarla nell'app (solo in locale): copiare `transition-planner-v5-int8.onnx` in `src/renderer/models/`, mettere
`TRANSITION_MODEL = 'transition-planner-v5-int8.onnx'` e `TRANSITION_MODEL_BEATS = 256` in
`src/renderer/js/ai/transition-planner.js` e `reference.json` in `test/fixtures/transition-model/`.
