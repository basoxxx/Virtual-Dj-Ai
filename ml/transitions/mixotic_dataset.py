"""Transizioni reali dei mix originali di Mixotic (set 044, 123, 281, 286; DJ veri con crossfader, fader ed EQ),
allineati ai brani originali da align_mixotic.py. Crossfader + EQ stimati dal mix come per il DJ Mix Dataset
(build_dataset.transitions_of_mix, 64 sotto-bande), con più levigatura tra battute (SMOOTH): con 1 le curve
dell'EQ saltano da una battuta all'altra (ambiguità spettrale tra due casse techno simili).

Tratto suonato di ogni brano: le clip della ricostruzione di Gand, spostate sulla diagonale trovata nel mix vero
(il riconoscimento per somiglianza da solo copre spesso solo parte del brano e le coppie non risultano contigue).

Controlli di affidabilità:
- entrambi i brani sulla diagonale prevista dalla ricostruzione di Gand (entro TOL battute);
- errore del fit dei guadagni sotto MAX_FIT (il mix deve essere spiegato da A + B);
- confronto indipendente con la ricostruzione di Gand: istante in cui il crossfader stimato dal mix vero passa
  metà corsa contro l'istante in cui lo passa il crossfader di Gand.

Finestre (al massimo --window battute: 256, oppure 128 come fino alla v4): da quando B si sente, anticipata di 0/4/8/16 battute; per le
transizioni più lunghe anche quella che finisce quando A non si sente più. Pesi: crossfader 1, EQ 0,5 scalato
sull'udibilità del proprio deck (con il deck quasi muto l'EQ non si osserva), filtri 0 (non stimati).

Uso:  ml/.venv/bin/python ml/transitions/mixotic_dataset.py [--window 128]   -> ml/data/mixotic/transitions[-128].npz
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import MAX_BEATS, N_IN, deck_features, global_features, median_bpm, transitions_of_mix  # noqa: E402
from gand_dataset import crossfader  # noqa: E402
from gand_features import name_of  # noqa: E402

GAND = ML_DIR / "data" / "werthen"
MIX = ML_DIR / "data" / "mixotic"
WINDOW = MAX_BEATS
SETS = ["set044", "set123", "set281", "set286"]
TOL = 48  # battute di scarto ammesse dalla diagonale prevista
MAX_FIT = 0.5
SMOOTH = 16.0
AUDIBLE = 0.2
PRE = [0, 4, 8, 16]
EQ_WEIGHT = 0.5


def gand_half_time(set_name: str, a_name: str, b_name: str) -> float | None:
    """Istante (s) in cui il crossfader della ricostruzione di Gand passa metà corsa da A a B, se c'è."""
    d = json.loads((GAND / "extracted" / set_name / f"{set_name}.json").read_text())
    names = {name_of(set_name, c["name"]): c for c in d["clips"]}
    ca, cb = names.get(a_name), names.get(b_name)
    if not ca or not cb or ca["track"] == cb["track"]:
        return None
    ev = d["crossfade"]["events"]
    for xp in d["xfade_positions"]:
        s, e = xp["start"], xp["end"]
        if not (ca["time"] <= e and cb["time"] <= e and ca["end"] >= s):
            continue
        t = np.linspace(s, e, 400)
        v = crossfader(ev, t)
        v = v if ca["track"] == "A" else 1 - v
        if v[0] < 0.5 <= v[-1]:
            return float(t[np.argmax(v >= 0.5)])
    return None


def played_ranges(set_name: str, al: dict, mb: np.ndarray) -> None:
    """Tratto suonato di ogni brano nel mix vero: unione delle clip del brano nella ricostruzione di Gand,
    spostata della differenza tra diagonale trovata e prevista."""
    d = json.loads((GAND / "extracted" / set_name / f"{set_name}.json").read_text())
    beat = float(np.median(np.diff(mb)))
    for t in al["tracks"]:
        if t.get("failed"):
            continue
        clips = [c for c in d["clips"] if name_of(set_name, c["name"]) == t["id"]]
        shift = (t["offset"] - t["predictedOffset"]) * beat
        j0 = int(np.searchsorted(mb, min(c["time"] for c in clips) + shift))
        j1 = int(np.searchsorted(mb, max(c["end"] for c in clips) + shift))
        n_track = len(np.load(GAND / "features" / f"{t['id']}.npz")["beats"])
        dd = t["offset"]
        j0, j1 = max(j0, dd), min(j1, dd + n_track, len(mb))
        t["detected"] = {"mixBeats": t["mixBeats"], "segments": t["segments"]}
        t["mixBeats"], t["segments"] = [j0, j1], [[j0 - dd, j1 - dd, dd]]


def window(it: dict, fa, fb, start: int, L: int) -> dict:
    """Finestra di L battute che parte `start` battute dopo l'inizio della transizione completa (negativo:
    prima, quando B non si sente ancora: controlli della prima battuta, crossfader dal lato di A, mix = A)."""
    full = it["y"].shape[0]
    idx = np.arange(start, start + L)
    src = np.clip(idx, 0, full - 1)
    before = idx < 0
    kA, kB = it["kA0"] + idx, it["kB0"] + idx
    nA, nB = len(fa["beats"]), len(fb["beats"])
    x = np.concatenate([deck_features(fa, np.where((kA >= 0) & (kA < nA), kA, -1)),
                        deck_features(fb, np.where((kB >= 0) & (kB < nB), kB, -1)),
                        global_features(L, median_bpm(fb["beats"]) / median_bpm(fa["beats"]))], 1)
    y = it["y"][src].copy()
    y[before, 0] = 0
    pA, pB, pM = it["powA"][src].copy(), it["powB"][src].copy(), it["powMix"][src].copy()
    pB[before], pM[before] = 0, pA[before]
    # pesi: l'EQ si osserva solo quanto il proprio deck si sente
    ga = np.minimum(1, np.cos(y[:, 0] * np.pi / 2) * np.sqrt(2))
    gb = np.minimum(1, np.sin(y[:, 0] * np.pi / 2) * np.sqrt(2))
    w = np.zeros((L, 9), np.float32)
    w[:, 0] = 1
    w[:, 1:4] = EQ_WEIGHT * np.clip(ga / 0.5, 0, 1)[:, None]
    w[:, 4:7] = EQ_WEIGHT * np.clip(gb / 0.5, 0, 1)[:, None]
    meta = {k: v for k, v in it.items() if k not in ("x", "y", "powA", "powB", "powMix")}
    return {**meta, "x": x, "y": y, "w": w, "powA": pA, "powB": pB, "powMix": pM, "length": L, "start": start}


def build(set_name: str) -> list[dict]:
    al = json.loads((MIX / "alignments" / f"{set_name}.json").read_text())
    for t in al["tracks"]:
        if not t.get("failed") and abs(t["offset"] - t["predictedOffset"]) > TOL:
            t["failed"] = True
    fm = np.load(MIX / "features" / f"{set_name}.npz")
    played_ranges(set_name, al, fm["beats"])
    cache: dict = {}

    def feat(i: str):
        if i not in cache:
            cache[i] = np.load(GAND / "features" / f"{i}.npz")
        return cache[i]

    full = transitions_of_mix(set_name, al=al, fm=fm, track_feat=feat, smooth=SMOOTH, audible=AUDIBLE, max_beats=10_000)
    mb = fm["beats"]
    out = []
    for it in full:
        it["set"] = set_name
        R = it["length"]
        xf = it["y"][:, 0]
        j_half = int(np.argmax(xf >= 0.5)) if (xf >= 0.5).any() else None
        it["halfTime"] = float(mb[it["mixStartBeat"] + j_half]) if j_half is not None else None
        it["gandHalfTime"] = gand_half_time(set_name, it["idA"], it["idB"])
        it["rawLength"] = R
        fa, fb = feat(it["idA"]), feat(it["idB"])
        L = min(R, WINDOW)
        for pre in PRE:
            if it["kB0"] - pre < 0 or it["kA0"] - pre < 0:
                continue  # B (o A) non esiste così presto
            out.append({**window(it, fa, fb, -pre, min(WINDOW, L + pre)), "kind": f"inizio-{pre}", "pre": pre})
        if R > WINDOW:
            out.append({**window(it, fa, fb, R - WINDOW, WINDOW), "kind": "fine", "pre": 0})
    return out


def pack(items: list[dict]) -> dict:
    n = len(items)
    X = np.zeros((n, MAX_BEATS, N_IN), np.float32)
    Y = np.zeros((n, MAX_BEATS, 9), np.float32)
    W = np.zeros((n, MAX_BEATS, 9), np.float32)
    P = np.zeros((n, MAX_BEATS, 9), np.float32)
    mask = np.zeros((n, MAX_BEATS), bool)
    for i, it in enumerate(items):
        L = it["length"]
        X[i, :L], Y[i, :L], W[i, :L], mask[i, :L] = it["x"], it["y"], it["w"], True
        P[i, :L] = np.concatenate([it["powA"], it["powB"], it["powMix"]], 1)
    meta = [{k: v for k, v in it.items() if k not in ("x", "y", "w", "powA", "powB", "powMix")} for it in items]
    return {"X": X, "Y": Y, "W": W, "P": P, "mask": mask, "meta": json.dumps(meta)}


def main():
    global WINDOW
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=MAX_BEATS, help="finestra massima in battute (128 = come fino alla v4)")
    WINDOW = ap.parse_args().window
    out = MIX / ("transitions.npz" if WINDOW == MAX_BEATS else f"transitions-{WINDOW}.npz")
    kept = []
    for s in SETS:
        tr = build(s)
        base = [t for t in tr if t["kind"] == "inizio-0"]
        ok = {t["posA"] for t in base if t["fitError"] <= MAX_FIT}
        print(f"== {s}: {len(base)} transizioni trovate, {len(ok)} con fit <= {MAX_FIT}")
        for t in base:
            dt = (f"{t['halfTime'] - t['gandHalfTime']:+6.1f} s" if t["halfTime"] is not None and t["gandHalfTime"] is not None
                  else "   n/d  ")
            half = f"{t['halfTime'] / 60:5.1f} min" if t["halfTime"] is not None else "   n/d   "
            print(f"  {t['posA']:2d}->{t['posA'] + 1:2d}  battute {t['rawLength']:3d}  fit {t['fitError']:.3f}  "
                  f"metà crossfader {half}  vs Gand {dt}")
        kept += [t for t in tr if t["posA"] in ok]
    np.savez_compressed(out, **pack(kept))
    base = [t for t in kept if t["kind"] == "inizio-0"]
    dts = [abs(t["halfTime"] - t["gandHalfTime"]) for t in base if t["halfTime"] is not None and t["gandHalfTime"] is not None]
    raw = [t["rawLength"] for t in base]
    print(f"{len(base)} transizioni tenute ({len(kept)} finestre); durata completa: mediana {np.median(raw):.0f} battute "
          f"(min {min(raw)}, max {max(raw)}, {sum(r > WINDOW for r in raw)} oltre {WINDOW}); "
          f"fit mediano {np.median([t['fitError'] for t in base]):.3f}; "
          f"metà crossfader vs Gand: mediana {np.median(dts):.1f} s su {len(dts)}")


if __name__ == "__main__":
    main()
