"""Insegnante medio: media delle probabilità di final0, final1 e final2 (checkpoint ufficiali, licenza MIT).

Per ogni brano con le tre previsioni (pred/final0, pred/final1, pred/final2) scrive pred/ens/<id>.npz con i logit
della probabilità media (float16) e battute / battute forti del post-processing "minimal" (soglia 0,5 sulla media).

Uso:  ml/.venv/bin/python ml/beat_this/ensemble.py [--members final0 final1 final2] [--name ens]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402

PRED = C.DATA / "pred"


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--members", nargs="+", default=["final0", "final1", "final2"])
    ap.add_argument("--name", default="ens")
    a = ap.parse_args()
    out = PRED / a.name
    out.mkdir(parents=True, exist_ok=True)
    ids = sorted(p.stem for p in (PRED / a.members[0]).glob("*.npz")
                 if all((PRED / m / p.name).exists() for m in a.members[1:]))
    n = 0
    for tid in ids:
        dst = out / f"{tid}.npz"
        if dst.exists():
            continue
        pb, pd = [], []
        for m in a.members:
            with np.load(PRED / m / f"{tid}.npz") as z:
                pb.append(sigmoid(z["beat"].astype(np.float32)))
                pd.append(sigmoid(z["downbeat"].astype(np.float32)))
        b, d = logit(np.mean(pb, 0)).astype(np.float32), logit(np.mean(pd, 0)).astype(np.float32)
        beats, downbeats = C.ref.postprocess(b, d)
        tmp = out / f"{tid}.tmp.npz"
        np.savez(tmp, beat=b.astype(np.float16), downbeat=d.astype(np.float16),
                 beats=beats.astype(np.float32), downbeats=downbeats.astype(np.float32))
        os.replace(tmp, dst)
        n += 1
    print(f"{n} brani nuovi in {out} ({len(ids)} con tutti i membri)")


if __name__ == "__main__":
    main()
