"""Battute di riferimento (Beat This! final0 fp32 in Python, ricampionamento soxr) per i brani di
ml/data/audio/cc. Servono a misurare la fase della griglia dell'app: non sono annotazioni umane,
quindi il confronto favorisce i modelli Beat This! (vedi ml/REPORT.md)."""

import json
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "beat_this"))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import soundfile as sf  # noqa: E402

import reference as ref  # noqa: E402

AUDIO = ML_DIR / "data" / "audio" / "cc"
sess = ort.InferenceSession(str(ML_DIR / "data" / "onnx" / "beat_this-final0.onnx"), providers=["CPUExecutionProvider"])
out = {}
for m in json.loads((AUDIO / "manifest.json").read_text()):
    y, sr = sf.read(str(AUDIO / m["file"]), dtype="float32", always_2d=True)
    b, db = ref.postprocess(*ref.predict_logits(ref.log_mel(ref.to_mono_22050(y, sr)), ref.onnx_runner(sess)))
    out[m["file"]] = {"beats": np.round(b, 3).tolist(), "downbeats": np.round(db, 3).tolist()}
    print(m["file"], len(b), len(db), flush=True)
(ML_DIR / "data" / "reference" / "cc_beats.json").write_text(json.dumps(out))
