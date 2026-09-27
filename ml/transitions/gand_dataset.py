"""Transizioni umane del dataset della tesi di Gand (Werthen-Brabants 2018): 5 mix ricreati in Ableton Live con
l'automazione del crossfader (niente EQ). Solo in locale (ml/data/werthen), licenza del dataset non dichiarata:
uso deciso dall'utente il 27/09/2026.

Dal JSON di ogni set: clip (inizio nel mix, punto di partenza nel brano, fattore di velocità "stretch", lato A/B),
eventi del crossfader (secondi, 0 = lato A, 1 = lato B, interpolazione lineare) e tratti in cui si muove.
Per ogni tratto: brano uscente = clip sul lato di partenza, entrante = clip sull'altro lato; finestra dalla battuta
forte (griglia del set, BPM costante) prima dell'inizio del movimento fino alla fine, al massimo 128 battute.
Obiettivo: solo il crossfader (0 = solo uscente, 1 = solo entrante); EQ e filtri esclusi dalla perdita.

Uso:  ml/.venv/bin/python ml/transitions/gand_dataset.py   -> ml/data/werthen/transitions.npz
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import MAX_BEATS, N_IN, deck_features, global_features  # noqa: E402
from gand_features import name_of  # noqa: E402

ROOT = ML_DIR / "data" / "werthen" / "extracted"
FEAT = ML_DIR / "data" / "werthen" / "features"
OUT = ML_DIR / "data" / "werthen" / "transitions.npz"
# pesi per controllo: solo il crossfader è noto
XF_ONLY = np.array([1, 0, 0, 0, 0, 0, 0, 0, 0], np.float32)


def crossfader(events: list[dict], t: np.ndarray) -> np.ndarray:
    ev = sorted((e["time"], e["value"]) for e in events if e["time"] > -1e6)
    ts = np.array([e[0] for e in ev])
    vs = np.array([e[1] for e in ev])
    first = [e["value"] for e in events if e["time"] <= -1e6]
    left = first[0] if first else vs[0]
    return np.interp(t, ts, vs, left=left, right=vs[-1])


def active(clips: list[dict], side: str, t: float) -> dict | None:
    """Clip del lato `side` che suona all'istante t (la più recente se sono più di una)."""
    c = [x for x in clips if x["track"] == side and x["time"] <= t < x["end"]]
    return max(c, key=lambda x: x["time"]) if c else None


def track_beats(f, clip: dict, times: np.ndarray) -> np.ndarray:
    """Indice della battuta del brano originale suonata a ogni istante del mix (-1 fuori dalla clip)."""
    t_src = clip["offset"] + (times - clip["time"]) * clip["stretch"]
    beats = f["beats"]
    k = np.clip(np.searchsorted(beats, t_src), 1, len(beats) - 1)
    k = np.where(np.abs(beats[k - 1] - t_src) < np.abs(beats[k] - t_src), k - 1, k)
    inside = (times >= clip["time"]) & (times < clip["end"]) & (t_src >= 0) & (t_src <= beats[-1] + 1)
    return np.where(inside, k, -1)


def human_templates(sets: list[str] | None = None) -> list[dict]:
    """Forme del crossfader umano (anche le transizioni lunghe): durata in battute e curva normalizzata
    0 -> 1 su 21 punti, per il generatore sintetico. `sets`: solo questi set (validazione incrociata)."""
    out = []
    for set_dir in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        if sets is not None and set_dir.name not in sets:
            continue
        d = json.loads((set_dir / f"{set_dir.name}.json").read_text())
        beat = 60 / d["bpm"]
        for xp in d["xfade_positions"]:
            s, e = xp["start"], xp["end"]
            v0, v1 = crossfader(d["crossfade"]["events"], np.array([s, e]))
            if abs(v1 - v0) < 0.5 or e - s < 2 * beat:
                continue
            v = crossfader(d["crossfade"]["events"], np.linspace(s, e, 21))
            out.append({"set": set_dir.name, "beats": (e - s) / beat, "shape": np.clip((v - v0) / (v1 - v0), 0, 1).tolist()})
    return out


def transitions_of_set(set_name: str, pre_beats: int = 0, post_beats: int = 4) -> tuple[list[dict], int]:
    d = json.loads((ROOT / set_name / f"{set_name}.json").read_text())
    beat = 60 / d["bpm"]
    bar = 4 * beat
    clips = d["clips"]
    events = d["crossfade"]["events"]
    out, too_long = [], 0
    for xp in d["xfade_positions"]:
        s, e = xp["start"], xp["end"]
        v0, v1 = crossfader(events, np.array([s, e]))
        if abs(v1 - v0) < 0.5:
            continue  # il crossfader non passa da un lato all'altro
        side_from = "B" if v0 >= 0.5 else "A"
        side_to = "A" if side_from == "B" else "B"
        a, b = active(clips, side_from, s), active(clips, side_to, e - 1e-3)
        if not a or not b or a is b:
            continue
        # finestra: dalla battuta forte prima del movimento (anticipata di pre_beats) fino a post_beats dopo
        t0 = np.floor(s / bar) * bar - pre_beats * beat
        L = int(np.ceil((e - t0) / beat)) + post_beats
        if L > MAX_BEATS:
            too_long += 1
            continue
        times = t0 + np.arange(L) * beat
        fa, fb = (np.load(FEAT / f"{name_of(set_name, c['name'])}.npz") for c in (a, b))
        kA, kB = track_beats(fa, a, times), track_beats(fb, b, times)
        v = crossfader(events, times)
        xf = v if side_from == "A" else 1 - v
        x = np.concatenate([deck_features(fa, kA), deck_features(fb, kB),
                            global_features(L, a["stretch"] / b["stretch"])], 1)
        y = np.zeros((L, 9), np.float32)
        y[:, 0] = xf
        out.append({"set": set_name, "x": x, "y": y, "length": L, "start": float(s), "end": float(e),
                    "from": a["name"], "to": b["name"], "beats": round((e - s) / beat, 1),
                    "pre": pre_beats, "post": post_beats})
    return out, too_long


# finestre usate: la prima è quella "stretta" (dal movimento), le altre la anticipano e la allungano come
# succede nell'app, dove la finestra la decide il piano e il modello deve scegliere quando muoversi
WINDOWS = [(0, 4), (4, 8), (8, 4), (16, 8), (32, 8)]


def main():
    items, skipped = [], 0
    for set_dir in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        for pre, post in WINDOWS:
            tr, n = transitions_of_set(set_dir.name, pre, post)
            items += tr
            if (pre, post) == WINDOWS[0]:
                skipped += n
                print(f"{set_dir.name}: {len(tr)} transizioni ({n} oltre 128 battute escluse)")
    n = len(items)
    X = np.zeros((n, MAX_BEATS, N_IN), np.float32)
    Y = np.zeros((n, MAX_BEATS, 9), np.float32)
    W = np.zeros((n, MAX_BEATS, 9), np.float32)
    mask = np.zeros((n, MAX_BEATS), bool)
    for i, it in enumerate(items):
        L = it["length"]
        X[i, :L], Y[i, :L], mask[i, :L], W[i, :L] = it["x"], it["y"], True, XF_ONLY
    meta = [{k: v for k, v in it.items() if k not in ("x", "y")} for it in items]
    np.savez_compressed(OUT, X=X, Y=Y, W=W, P=np.zeros((n, MAX_BEATS, 9), np.float32), mask=mask, meta=json.dumps(meta))
    dur = [m["beats"] for m in meta if (m["pre"], m["post"]) == WINDOWS[0]]
    print(f"{len(dur)} transizioni ({n} finestre in tutto), {skipped} escluse; durata del movimento: mediana "
          f"{np.median(dur):.0f} battute, min {min(dur):.0f}, max {max(dur):.0f}")


if __name__ == "__main__":
    main()
