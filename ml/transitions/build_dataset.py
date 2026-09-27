"""Dataset delle transizioni reali: per ogni coppia di brani consecutivi allineati in un mix,
finestra di transizione, ingressi per battuta (come li calcola l'app) e controlli stimati dal mix.

La finestra parte quando il brano entrante B diventa udibile (come nell'app, dove B parte all'inizio della
transizione) e finisce quando l'uscente A non si sente più; lunghezza 16-128 battute.

Uso:  ml/.venv/bin/python ml/transitions/build_dataset.py [mix0010 ...]   -> ml/data/djmix/transitions.npz
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from features import FINE_EQ_BAND  # noqa: E402
from gains import SMOOTH, estimate, to_controls  # noqa: E402

DATA = ML_DIR / "data" / "djmix"
FEAT = DATA / "features"
ALIGN = DATA / "alignments"
MAX_BEATS = 128
MIN_BEATS = 16
MARGIN = 48  # battute cercate prima/dopo i tratti rilevati per le dissolvenze
N_DECK = 16
N_GLOBAL = 3
N_IN = 2 * N_DECK + N_GLOBAL


def bar_positions(beats: np.ndarray, downbeats: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per ogni battuta: tempo nella battuta (0..3) e numero della battuta (dalle battute forti di Beat This!)."""
    pos = np.zeros(len(beats), np.int64)
    bar = np.zeros(len(beats), np.int64)
    if len(downbeats) == 0:
        pos = np.arange(len(beats)) % 4
        return pos, np.arange(len(beats)) // 4
    is_db = np.isin(np.round(beats, 2), np.round(downbeats, 2))
    first = int(np.argmax(is_db)) if is_db.any() else 0
    b, p = -1, (-first) % 4
    for k in range(len(beats)):
        if k >= first and is_db[k]:
            b, p = b + 1, 0
        pos[k] = min(p, 3)
        bar[k] = max(b, 0) if k >= first else -1 - (first - k - 1) // 4
        p += 1
    return pos, bar


def deck_block(t: np.ndarray, wave: np.ndarray, pos: np.ndarray, bar: np.ndarray, duration: float,
               present: np.ndarray) -> np.ndarray:
    """Ingressi per battuta di un deck dai dati di base; identico a deckBlock in
    src/renderer/js/ai/transition-model.js (test di parità in test/transition-model.test.js).
    t: tempo della battuta (s); wave: forma d'onda media peak/low/mid/high; pos: tempo nella battuta 0..3;
    bar: numero della battuta; present: la battuta esiste nel brano."""
    out = np.zeros((len(t), N_DECK), np.float32)
    out[:, 0:4] = wave
    out[np.arange(len(t)), 4 + np.clip(pos, 0, 3)] = 1
    for i, period in enumerate((8, 16)):
        ang = 2 * np.pi * np.mod(bar, period) / period
        out[:, 8 + 2 * i] = np.sin(ang)
        out[:, 9 + 2 * i] = np.cos(ang)
    out[:, 12] = t / duration
    out[:, 13] = np.minimum(t / 60, 4)
    out[:, 14] = np.minimum((duration - t) / 60, 4)
    out[:, 15] = 1
    out[~present] = 0
    return out


def deck_features(f, k: np.ndarray) -> np.ndarray:
    """Ingressi per battuta di un deck (k: indice di battuta del brano per ogni battuta della finestra, -1 = assente)."""
    beats, dur = f["beats"], float(f["duration"])
    n = len(beats)
    pos, bar = bar_positions(beats, f["downbeats"])
    ok = (k >= 0) & (k < n)
    kk = np.clip(k, 0, n - 1)
    return deck_block(beats[kk], f["wave"][kk], pos[kk], bar[kk], dur, ok)


def global_features(length: int, bpm_ratio: float) -> np.ndarray:
    j = np.arange(length)
    return np.stack([j / length, np.full(length, length / MAX_BEATS), np.full(length, np.log2(bpm_ratio))], 1).astype(np.float32)


def median_bpm(beats: np.ndarray) -> float:
    ibi = np.diff(beats)
    return 60 / float(np.median(ibi)) if len(ibi) else 120.0


def mapping(a: dict, n_mix: int, first: bool) -> tuple[int, int, int]:
    """(offset, inizio, fine) nel mix del tratto rilevato; offset dal primo o dall'ultimo tratto."""
    seg = a["segments"][0] if first else a["segments"][-1]
    return seg[2], a["mixBeats"][0], min(a["mixBeats"][1], n_mix)


def transitions_of_mix(mix_id: str, al: dict | None = None, fm=None, track_feat=None, smooth: float = SMOOTH,
                       audible: float = 0.1, max_beats: int = MAX_BEATS) -> list[dict]:
    """Transizioni tra brani consecutivi allineati. Di default dati del DJ Mix Dataset; al/fm/track_feat
    (allineamento, caratteristiche del mix, id -> caratteristiche del brano) per altre fonti; smooth: penalità
    sulle variazioni dei guadagni tra battute; audible: guadagno oltre il quale un brano si considera udibile."""
    al = al or json.loads((ALIGN / f"{mix_id}.json").read_text())
    fm = fm if fm is not None else np.load(FEAT / f"{mix_id}.npz")
    track_feat = track_feat or (lambda i: np.load(FEAT / f"yt-{i}.npz"))
    n_mix = len(fm["beats"])
    tracks = {t["pos"]: t for t in al["tracks"] if not t.get("failed")}
    out = []
    for pos in sorted(tracks):
        if pos + 1 not in tracks:
            continue
        A, B = tracks[pos], tracks[pos + 1]
        fa, fb = track_feat(A["id"]), track_feat(B["id"])
        dA, a0, a1 = mapping(A, n_mix, first=False)
        dB, b0, b1 = mapping(B, n_mix, first=True)
        if b0 > a1 + 32 or b1 < a1:  # tratti non consecutivi: allineamento dubbio
            continue
        lo = max(a0, b0 - MARGIN)
        hi = min(b1, a1 + MARGIN)
        j = np.arange(lo, hi)
        kA, kB = j - dA, j - dB
        okA = (kA >= 0) & (kA < len(fa["beats"]))
        okB = (kB >= 0) & (kB < len(fb["beats"]))
        if okA.sum() < 16 or okB.sum() < 16:
            continue
        powA = np.where(okA[:, None], fa["pow64"][np.clip(kA, 0, len(fa["beats"]) - 1)], 0)
        powB = np.where(okB[:, None], fb["pow64"][np.clip(kB, 0, len(fb["beats"]) - 1)], 0)
        mix = fm["pow64"][j]
        # calibrazione: A da solo prima dell'inizio rilevato di B, B da solo dopo la fine rilevata di A
        solo_a = slice(0, max(0, min(16, b0 - lo)))
        s_b = max(0, a1 - lo)
        solo_b = slice(min(len(j), s_b), min(len(j), s_b + 16))
        g = estimate(mix, powA + 1e-12, powB + 1e-12, FINE_EQ_BAND, solo_a, solo_b, smooth)
        ctrl = to_controls(g["gainA"] * okA[:, None], g["gainB"] * okB[:, None])
        fA_, fB_ = g["gainA"].max(1) * okA, g["gainB"].max(1) * okB
        audB = np.where(fB_ > audible)[0]
        audA = np.where(fA_ > audible)[0]
        if not len(audB) or not len(audA):
            continue
        # finestra: da quando B si sente (all'inizio della sua battuta) a quando A non si sente più
        w0 = int(audB[0])
        w0 -= int((kB[w0] if okB[w0] else 0) % 4) if okB[w0] else 0
        w0 = max(0, w0)
        w1 = min(len(j), int(audA[-1]) + 4)
        L = w1 - w0
        if L < MIN_BEATS:
            continue
        raw_length = L
        if L > max_beats:
            w1, L = w0 + max_beats, max_beats
        sl = slice(w0, w1)
        bpm_a, bpm_b = median_bpm(fa["beats"]), median_bpm(fb["beats"])
        x = np.concatenate([deck_features(fa, np.where(okA, kA, -1)[sl]), deck_features(fb, np.where(okB, kB, -1)[sl]),
                            global_features(L, bpm_b / bpm_a)], 1)
        out.append({
            "mix": mix_id, "posA": pos, "idA": A["id"], "idB": B["id"], "length": L, "rawLength": raw_length, "zA": A["z"], "zB": B["z"],
            "x": x, "y": ctrl[sl], "fitError": g["fitError"],
            # potenze per banda dell'EQ (per la perdita del mixer differenziabile), calibrate come nel fit
            "powA": g["bandA"][sl] * okA[sl, None], "powB": g["bandB"][sl] * okB[sl, None], "powMix": g["bandMix"][sl],
            "mixStartBeat": int(lo + w0), "kA0": int(kA[w0]), "kB0": int(kB[w0]),
        })
    return out


def pack(items: list[dict]) -> dict:
    n = len(items)
    X = np.zeros((n, MAX_BEATS, N_IN), np.float32)
    Y = np.zeros((n, MAX_BEATS, 9), np.float32)
    P = np.zeros((n, MAX_BEATS, 9), np.float32)
    mask = np.zeros((n, MAX_BEATS), bool)
    for i, it in enumerate(items):
        L = it["length"]
        X[i, :L], Y[i, :L], mask[i, :L] = it["x"], it["y"], True
        P[i, :L] = np.concatenate([it["powA"], it["powB"], it["powMix"]], 1)
    meta = [{k: v for k, v in it.items() if k not in ("x", "y", "powA", "powB", "powMix")} for it in items]
    return {"X": X, "Y": Y, "P": P, "mask": mask, "meta": json.dumps(meta)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mixes", nargs="*")
    args = ap.parse_args()
    mixes = args.mixes or sorted(p.stem for p in ALIGN.glob("mix*.json"))
    items = []
    for m in mixes:
        tr = transitions_of_mix(m)
        print(f"{m}: {len(tr)} transizioni", flush=True)
        items += tr
    np.savez_compressed(DATA / "transitions.npz", **pack(items))
    L = [it["length"] for it in items]
    fe = [it["fitError"] for it in items]
    print(f"{len(items)} transizioni, lunghezza mediana {np.median(L):.0f} battute, errore del fit mediano {np.median(fe):.3f}")


if __name__ == "__main__":
    main()
