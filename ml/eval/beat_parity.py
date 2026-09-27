"""Parità delle varianti ONNX (fp32/int8) con PyTorch su brani reali.

Per ogni brano di ml/data/audio/cc calcola logit e battute con PyTorch (final0 e small0) e con
i file ONNX, poi confronta: errore massimo sui logit e F-measure delle battute/battute forti
(finestra ±70 ms, come mir_eval) rispetto al PyTorch dello stesso modello.

Uso:  ml/.venv/bin/python ml/eval/beat_parity.py [--variants int8 ...] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))
sys.path.insert(0, str(ML_DIR / "beat_this"))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import soundfile as sf  # noqa: E402

import reference as ref  # noqa: E402
from beat_this.inference import load_model  # noqa: E402

AUDIO = ML_DIR / "data" / "audio" / "cc"
ONNX_DIR = ML_DIR / "data" / "onnx"
CKPT = ML_DIR / "data" / "checkpoints"


def f_measure(ref_times, est_times, window=0.07, skip=5.0) -> float:
    r = np.asarray([t for t in ref_times if t >= skip])
    e = np.asarray([t for t in est_times if t >= skip])
    if len(r) == 0 and len(e) == 0:
        return 1.0
    if len(r) == 0 or len(e) == 0:
        return 0.0
    used = np.zeros(len(e), dtype=bool)
    hits = 0
    for t in r:
        d = np.abs(e - t)
        d[used] = np.inf
        j = int(np.argmin(d))
        if d[j] <= window:
            used[j] = True
            hits += 1
    p = hits / len(e)
    rc = hits / len(r)
    return 0.0 if hits == 0 else 2 * p * rc / (p + rc)


def load_mono(path: Path) -> np.ndarray:
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return ref.to_mono_22050(x, sr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["final0", "small0"])
    ap.add_argument("--variants", nargs="+", default=["fp32", "int8"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=str(ML_DIR / "data" / "reference" / "beat_parity.json"))
    args = ap.parse_args()
    manifest = json.loads((AUDIO / "manifest.json").read_text())
    if args.limit:
        manifest = manifest[: args.limit]
    spects = {m["file"]: ref.log_mel(load_mono(AUDIO / m["file"])) for m in manifest}
    summary = {}
    for name in args.models:
        run_torch = ref.torch_runner(load_model(str(CKPT / f"beat_this-{name}.ckpt"), "cpu"))
        torch_out = {}
        for m in manifest:
            logits = ref.predict_logits(spects[m["file"]], run_torch)
            torch_out[m["file"]] = (logits, ref.postprocess(*logits))
        for variant in args.variants:
            suffix = "" if variant == "fp32" else f"-{variant}"
            sess = ort.InferenceSession(str(ONNX_DIR / f"beat_this-{name}{suffix}.onnx"), providers=["CPUExecutionProvider"])
            errs, fb, fdb = [], [], []
            for m in manifest:
                (tl, (tb, tdb)) = torch_out[m["file"]]
                logits = ref.predict_logits(spects[m["file"]], ref.onnx_runner(sess))
                b, db = ref.postprocess(*logits)
                errs.append(max(float(np.max(np.abs(logits[0] - tl[0]))), float(np.max(np.abs(logits[1] - tl[1])))))
                fb.append(f_measure(tb, b))
                fdb.append(f_measure(tdb, db))
            key = f"{name}-{variant}"
            summary[key] = {
                "tracks": len(manifest),
                "maxLogitErr": round(max(errs), 4),
                "medianMaxLogitErr": round(float(np.median(errs)), 4),
                "beatF": round(float(np.mean(fb)), 4),
                "beatFmin": round(float(np.min(fb)), 4),
                "downbeatF": round(float(np.mean(fdb)), 4),
                "downbeatFmin": round(float(np.min(fdb)), 4),
            }
            print(key, json.dumps(summary[key]), flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(summary, indent=1) + "\n")


if __name__ == "__main__":
    main()
