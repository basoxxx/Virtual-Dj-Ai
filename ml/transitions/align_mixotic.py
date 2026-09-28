"""Allinea i mix originali di Mixotic (DJ set veri, Creative Commons, Internet Archive) ai loro brani originali
(i "refsongs" del dataset della tesi di Gand, stessi file digitali). Ordine dei brani dalle clip del JSON di Gand.
La ricostruzione di Gand segue la timeline dei mix originali (stesse durate: 76,8 contro 77,8 min per il 044): da
inizio clip, offset e stretch si ricava la diagonale attesa e si cerca solo entro ±64 battute da lì.

Uso:  ml/.venv/bin/python ml/transitions/align_mixotic.py   -> ml/data/mixotic/alignments/<set>.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from align import align_track, candidates, choose_sequence, similarity  # noqa: E402
from gand_features import name_of  # noqa: E402

GAND = ML_DIR / "data" / "werthen"
MIX = ML_DIR / "data" / "mixotic"
SETS = ["set044", "set123", "set281", "set286"]


def predicted_offset(c: dict, ft, mb: np.ndarray) -> int:
    """Diagonale attesa (battuta del mix - battuta del brano) dalla clip della ricostruzione di Gand:
    la battuta k del brano (tempo t) suona nel mix a clip.time + (t - offset) / stretch."""
    beats = ft["beats"]
    k = int(np.searchsorted(beats, c["offset"] + 8.0))  # una battuta sicuramente dentro la clip
    k = min(k, len(beats) - 1)
    t_mix = c["time"] + (beats[k] - c["offset"]) / c["stretch"]
    j = int(np.clip(np.searchsorted(mb, t_mix), 0, len(mb) - 1))
    return j - k


def align_set(set_name: str, window: int = 64) -> dict:
    d = json.loads((GAND / "extracted" / set_name / f"{set_name}.json").read_text())
    fm = np.load(MIX / "features" / f"{set_name}.npz")
    mb = fm["beats"]
    order, seen = [], set()
    for c in sorted(d["clips"], key=lambda c: c["time"]):
        if c["name"] not in seen:
            seen.add(c["name"])
            order.append(c)
    entries, cands, sims = [], [], []
    for pos, c in enumerate(order):
        ft = np.load(GAND / "features" / f"{name_of(set_name, c['name'])}.npz")
        S = similarity(ft, fm)
        d_pred = predicted_offset(c, ft, mb)
        # indizio a priori: solo le diagonali entro ±window battute da quella della ricostruzione di Gand
        allc = candidates(S, k=40, sep=16)
        near = [x for x in allc if abs(x["d"] - d_pred) <= window]
        entries.append({"pos": pos, "id": name_of(set_name, c["name"]), "title": c["name"], "gandTime": c["time"],
                        "gandSourceStart": c["offset"], "predictedOffset": d_pred})
        cands.append(near[:10])
        sims.append(S)
    chosen = choose_sequence(cands)
    tracks = []
    for e, cs, S, k in zip(entries, cands, sims, chosen):
        if k is None:
            tracks.append({**e, "failed": True})
            continue
        a = align_track(S, fixed=cs[k])
        a.update(e)
        a["mixTime"] = [float(mb[a["mixBeats"][0]]), float(mb[min(a["mixBeats"][1], len(mb) - 1)])]
        tracks.append(a)
    out = {"mix": set_name, "beats": int(len(mb)), "tracks": tracks}
    (MIX / "alignments").mkdir(parents=True, exist_ok=True)
    (MIX / "alignments" / f"{set_name}.json").write_text(json.dumps(out, indent=1))
    return out


def main():
    for s in SETS:
        out = align_set(s)
        print(f"== {s}")
        for t in out["tracks"]:
            if t.get("failed"):
                print(f"  {t['pos']:2d} NON ALLINEATO {t['title'][:50]}")
                continue
            # dove inizia il brano nel mix, riportato all'inizio del brano (offset della diagonale)
            start = t["mixTime"][0]
            print(f"  {t['pos']:2d} mix {start / 60:5.1f} min (Gand {t['gandTime'] / 60:5.1f})  z {t['z']:5.1f} "
                  f"diagonale {t['offset']} (attesa {t['predictedOffset']})  tratti {len(t['segments'])}  {t['title'][:36]}")


if __name__ == "__main__":
    main()
