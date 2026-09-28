"""Effetto del ricampionamento a 22050 Hz sulle battute di Beat This!.

Confronta, sui brani di ml/data/audio/cc, le battute ottenute da audio ricampionato con soxr
(come beat_this in Python) con quelle da:
  linear  interpolazione lineare senza filtro anti-aliasing, come AudioBufferSourceNode di
          Chromium dentro un OfflineAudioContext a 22050 Hz (a 44,1 kHz: un campione ogni due)
  sinc    ricampionatore sinc di qualità, come decodeAudioData su un OfflineAudioContext a 22050 Hz
          (qui: soxr in qualità "VHQ" partendo dalla frequenza originale)

Uso:  ml/.venv/bin/python ml/eval/resample_check.py [--model small0]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "beat_this"))
sys.path.insert(0, str(ML_DIR / "eval"))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import soundfile as sf  # noqa: E402
import soxr  # noqa: E402

import reference as ref  # noqa: E402
from beat_parity import f_measure  # noqa: E402

AUDIO = ML_DIR / "data" / "audio" / "cc"


def linear_resample(x: np.ndarray, sr: int, target: int = ref.SAMPLE_RATE) -> np.ndarray:
    ratio = sr / target
    n = int(np.floor(len(x) / ratio))
    pos = np.arange(n) * ratio
    return np.interp(pos, np.arange(len(x)), x).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small0")
    args = ap.parse_args()
    sess = ort.InferenceSession(str(ML_DIR / "data" / "onnx" / f"beat_this-{args.model}.onnx"), providers=["CPUExecutionProvider"])
    run = ref.onnx_runner(sess)
    manifest = json.loads((AUDIO / "manifest.json").read_text())
    rows = []
    for m in manifest:
        y, sr = sf.read(str(AUDIO / m["file"]), dtype="float32", always_2d=True)
        mono = y.mean(1)
        variants = {
            "soxr": soxr.resample(mono, sr, ref.SAMPLE_RATE),
            "linear": linear_resample(mono, sr),
            "sinc": soxr.resample(mono, sr, ref.SAMPLE_RATE, quality="VHQ"),
        }
        out = {}
        for k, sig in variants.items():
            logits = ref.predict_logits(ref.log_mel(np.asarray(sig, dtype=np.float32)), run)
            out[k] = ref.postprocess(*logits)
        row = {"file": m["file"], "sr": sr}
        for k in ("linear", "sinc"):
            row[f"{k}BeatF"] = f_measure(out["soxr"][0], out[k][0])
            row[f"{k}DownbeatF"] = f_measure(out["soxr"][1], out[k][1])
        rows.append(row)
        print(json.dumps(row), flush=True)
    summary = {k: round(float(np.mean([r[k] for r in rows])), 4) for k in rows[0] if k.endswith("F")}
    summary.update({f"{k}Min": round(float(np.min([r[k] for r in rows])), 4) for k in rows[0] if k.endswith("F")})
    print("MEDIA", json.dumps(summary))
    (ML_DIR / "data" / "reference" / "resample_check.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
