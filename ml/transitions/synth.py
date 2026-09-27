"""Transizioni sintetiche per il pre-addestramento del modello C.

Ingressi: coppie di brani veri (caratteristiche per battuta in ml/data/djmix/features/yt-*.npz), A verso la fine
e B dall'inizio, come nell'app. Curve: stili da DJ legati alla musica, così il modello impara a usare gli ingressi:
  - bass swap al primo confine di frase (8 battute di A) dopo l'entrata dei bassi di B
  - blend con scambio graduale dei bassi, dissolvenza, taglio sul beat
Potenze del mix: stesse curve applicate alle bande dei due brani (mixer dell'app, vedi model.mix_power).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import MAX_BEATS, N_IN, bar_positions, deck_features, global_features, median_bpm  # noqa: E402
from features import FINE_EQ_BAND  # noqa: E402

FEAT = ML_DIR / "data" / "djmix" / "features"
LENGTHS = [32, 48, 64, 64, 96, 128]


def ease(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0, 1)
    return 0.5 - 0.5 * np.cos(np.pi * t)


def ramp(n: int, a: float, b: float, v0: float, v1: float) -> np.ndarray:
    j = np.arange(n)
    return v0 + (v1 - v0) * ease((j - a) / max(1e-6, b - a))


def smooth_gains(xf: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    a = np.minimum(1, np.cos(xf * np.pi / 2) * np.sqrt(2))
    b = np.minimum(1, np.sin(xf * np.pi / 2) * np.sqrt(2))
    return a, b


class Synth:
    def __init__(self, seed: int = 0, files: list[Path] | None = None):
        self.rng = np.random.default_rng(seed)
        files = files or sorted(FEAT.glob("yt-*.npz"))
        self.tracks = []
        for f in files:
            d = dict(np.load(f))
            if "pow64" in d and len(d["beats"]) > 200:
                d["band3"] = np.stack([d["pow64"][:, FINE_EQ_BAND == b].sum(1) for b in range(3)], 1)
                d["pos"], d["bar"] = bar_positions(d["beats"], d["downbeats"])
                self.tracks.append(d)

    def sample(self) -> dict:
        r = self.rng
        ia, ib = r.choice(len(self.tracks), 2, replace=False)
        fa, fb = self.tracks[ia], self.tracks[ib]
        L = int(r.choice(LENGTHS))
        na, nb = len(fa["beats"]), len(fb["beats"])
        # A: una battuta forte nell'ultimo 45% del brano con almeno L battute rimaste
        cand = np.where((fa["pos"] == 0) & (np.arange(na) >= 0.55 * na) & (np.arange(na) + L <= na))[0]
        if not len(cand):
            cand = np.where((fa["pos"] == 0) & (np.arange(na) + L <= na))[0]
        ka0 = int(r.choice(cand)) if len(cand) else max(0, na - L)
        # B: prima battuta forte (a volte l'inizio della seconda frase)
        dbs = np.where(fb["pos"] == 0)[0]
        kb0 = int(dbs[0]) if len(dbs) else 0
        if r.random() < 0.3 and len(dbs) > 8:
            kb0 = int(dbs[8])
        j = np.arange(L)
        kA, kB = ka0 + j, kb0 + j
        kB = np.where(kB < nb, kB, -1)
        x = np.concatenate([deck_features(fa, kA), deck_features(fb, kB),
                            global_features(L, median_bpm(fb["beats"]) / median_bpm(fa["beats"]))], 1)
        y = self.curves(fa, fb, kA, kB, L)
        powA = fa["band3"][kA]
        powB = np.where((kB >= 0)[:, None], fb["band3"][np.clip(kB, 0, nb - 1)], 0)
        ga, gb = smooth_gains(y[:, 0])
        ampA = ga[:, None] * 10 ** (1.5 * y[:, 1:4])
        ampB = gb[:, None] * 10 ** (1.5 * y[:, 4:7])
        mix = ampA ** 2 * powA + ampB ** 2 * powB
        return {"x": x, "y": y, "p": np.concatenate([powA, powB, mix], 1), "length": L}

    def curves(self, fa, fb, kA, kB, L) -> np.ndarray:
        r = self.rng
        y = np.zeros((L, 9), np.float32)
        # confini di frase di A (inizio di un gruppo di 8 battute) e entrata dei bassi di B
        phrase = np.where((fa["pos"][kA] == 0) & (fa["bar"][kA] % 8 == 0))[0]
        bars = np.where(fa["pos"][kA] == 0)[0]
        low_b = np.where(kB >= 0, fb["wave"][np.clip(kB, 0, len(fb["beats"]) - 1), 1], 0)
        entry = int(np.argmax(low_b > 0.5 * max(low_b.max(), 1e-6)))
        lo_w = max(entry, int(0.25 * L))
        ok = phrase[(phrase >= lo_w) & (phrase <= 0.8 * L)]
        if not len(ok):
            ok = bars[(bars >= lo_w) & (bars <= 0.8 * L)]
        w = int(ok[0]) if len(ok) else int(L // 2)
        end = L - int(r.integers(0, 9))
        style = r.choice(["swap", "blend", "fade", "cut"], p=[0.45, 0.3, 0.15, 0.1])
        if style == "swap":
            hold = int(r.choice([0, 0, 8, 16]))
            xf = np.where(np.arange(L) < w, ramp(L, 0, max(4, w - int(r.integers(0, 5))), 0, 0.5),
                          ramp(L, w + hold, max(w + hold + 4, end), 0.5, 1))
            y[:, 0] = xf
            y[:, 4] = np.where(np.arange(L) < w, -1, 0)
            y[:, 1] = np.where(np.arange(L) < w, 0, -1)
            if r.random() < 0.4:
                y[:, 6] = ramp(L, w // 2, w, -r.uniform(0.3, 0.6), 0)
        elif style == "blend":
            s = int(r.integers(0, max(1, L // 4)))
            y[:, 0] = ramp(L, s, end, 0, 1)
            half = int(r.choice([4, 8]))
            y[:, 1] = ramp(L, w - half, w + half, 0, -1)
            y[:, 4] = ramp(L, w - half, w + half, -1, 0)
        elif style == "fade":
            y[:, 0] = np.clip(np.arange(L) / max(1, end - 1), 0, 1)
        else:
            y[:, 0] = (np.arange(L) >= w).astype(np.float32)
        return y

    def batch(self, n: int) -> dict:
        X = np.zeros((n, MAX_BEATS, N_IN), np.float32)
        Y = np.zeros((n, MAX_BEATS, 9), np.float32)
        P = np.zeros((n, MAX_BEATS, 9), np.float32)
        M = np.zeros((n, MAX_BEATS), bool)
        for i in range(n):
            s = self.sample()
            L = s["length"]
            X[i, :L], Y[i, :L], P[i, :L], M[i, :L] = s["x"], s["y"], s["p"], True
        return {"X": X, "Y": Y, "P": P, "mask": M}
