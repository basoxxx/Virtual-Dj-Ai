"""Transizioni sintetiche per il pre-addestramento del modello C.

Ingressi: coppie di brani veri (caratteristiche per battuta: ml/data/djmix/features/yt-*.npz e, se c'è,
ml/data/usb/features/usb-*.npz dalla musica dell'utente), A verso la fine
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
USB_FEAT = ML_DIR / "data" / "usb" / "features"
GAND_FEAT = ML_DIR / "data" / "werthen" / "features"
MIXOTIC_FEAT = ML_DIR / "data" / "mixotic" / "tracks" / "features"
JAMENDO_FEAT = ML_DIR / "data" / "jamendo" / "features"


DJ_GENRES = {"electronic", "dance", "techno", "house", "trance", "deep house", "tech house", "bass & garage",
             "commercial house", "hardstyle", "edm", "electro", "drum & bass", "progressive house", "minimal"}
DJ_WORDS = ("remix", "rmx", "extended", "club mix", "original mix", " mix)", "edit", "bootleg", "vip", "dub")
DJ_FOLDERS = ("/Techno/", "CROSSFADER MUSIC PACK", "Zarro Mix", "/House", "/Tech House")


def dj_weights(files: list[Path]) -> np.ndarray:
    """Peso di campionamento: 3 per i brani da DJ (remix, club mix, extended, cartelle e generi elettronici della
    musica dell'utente; tutti quelli del DJ Mix Dataset), 1 per gli altri."""
    import json
    import zlib

    inv_path = ML_DIR / "data" / "usb" / "inventory.json"
    info = {}
    if inv_path.exists():
        for it in json.loads(inv_path.read_text()):
            info[f"usb-{zlib.crc32(it['path'].encode()):08x}"] = it
    jam = {}
    jam_path = ML_DIR / "data" / "jamendo" / "selection.json"
    if jam_path.exists():
        jam = {f"jam-{it['id']}": it for it in json.loads(jam_path.read_text())}
    w = []
    for f in files:
        if f.name.startswith(("yt-", "gand-", "mixotic-")):
            w.append(3.0)  # brani dei DJ set (DJ Mix Dataset, Gand, Mixotic)
            continue
        if f.stem in jam:
            # Jamendo: generi da club come i brani da DJ, gli altri un po' meno (ma tutti presenti)
            w.append(3.0 if jam[f.stem].get("club") else 1.5)
            continue
        it = info.get(f.stem)
        if not it:
            w.append(1.0)
            continue
        name = it["path"].lower()
        genre = (it.get("genre") or "").lower()
        dj = any(k.lower() in it["path"] for k in DJ_FOLDERS) or any(k in name for k in DJ_WORDS) or genre in DJ_GENRES
        w.append(3.0 if dj else 1.0)
    return np.array(w)


def default_files() -> list[Path]:
    """Brani del DJ Mix Dataset, della cartella musicale dell'utente (ml/transitions/usb_features.py), dei set di
    Gand e Mixotic e della selezione Jamendo con più generi (ml/transitions/jamendo_features.py), se ci sono."""
    return (sorted(FEAT.glob("yt-*.npz")) + sorted(USB_FEAT.glob("usb-*.npz")) + sorted(GAND_FEAT.glob("gand-*.npz"))
            + sorted(MIXOTIC_FEAT.glob("mixotic-*.npz")) + [f for f in sorted(JAMENDO_FEAT.glob("jam-*.npz"))
                                                            if f.stem not in jamendo_test()])


def jamendo_test() -> set[str]:
    """Brani Jamendo tenuti fuori dal generatore (split "test" della selezione) per il test dei generi."""
    import json

    path = ML_DIR / "data" / "jamendo" / "selection.json"
    if not path.exists():
        return set()
    return {f"jam-{it['id']}" for it in json.loads(path.read_text()) if it.get("split") == "test"}


# lunghezze delle finestre sintetiche (battute): fino alla v4 al massimo 128, dalla v5 anche transizioni lunghe
SHORT_LENGTHS = [32, 48, 64, 64, 96, 128]
LONG_LENGTHS = [32, 48, 64, 64, 96, 128, 128, 160, 192, 256]
LENGTHS = SHORT_LENGTHS


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


def outro_start(d: dict) -> int | None:
    """Battuta forte da cui l'energia (bassi + medi) resta sotto il 60% della mediana fino alla fine."""
    e = d["wave"][:, 1] + d["wave"][:, 2]
    dbs = np.where(d["pos"] == 0)[0]
    if len(dbs) < 16:
        return None
    bar_e = np.array([e[a:b].mean() for a, b in zip(dbs, np.append(dbs[1:], len(e)))])
    loud = np.where(bar_e >= 0.6 * np.median(bar_e))[0]
    if not len(loud) or loud[-1] >= len(dbs) - 8:
        return None
    return int(dbs[loud[-1] + 1])


class Synth:
    """templates: forme del crossfader umano (gand_dataset.human_templates) per lo stile "umano";
    weights: peso di campionamento dei brani (dj_weights)."""

    def __init__(self, seed: int = 0, files: list[Path] | None = None, templates: list[dict] | None = None,
                 weights: np.ndarray | str | None = None, human_share: float = 0.35, use_outro: bool = True,
                 lengths: list[int] | None = None):
        self.rng = np.random.default_rng(seed)
        self.lengths = lengths or LENGTHS
        files = files or default_files()
        # weights: None = pesi da DJ, "uniform" = tutti uguali (generatore della v1/v2)
        if isinstance(weights, str) and weights == "uniform":
            base_w = np.ones(len(files))
        else:
            base_w = dj_weights(files) if weights is None else np.asarray(weights, float)
        self.use_outro = use_outro
        self.templates = templates or []
        self.human_share = human_share if self.templates else 0.0
        self.tracks, w = [], []
        for f, wf in zip(files, base_w):
            d = dict(np.load(f))
            if "pow64" in d and len(d["beats"]) > 200:
                d["band3"] = np.stack([d["pow64"][:, FINE_EQ_BAND == b].sum(1) for b in range(3)], 1)
                d["pos"], d["bar"] = bar_positions(d["beats"], d["downbeats"])
                d["outro"] = outro_start(d)
                ibi = np.diff(d["beats"])
                steady = np.median(np.abs(ibi - np.median(ibi))) / np.median(ibi) < 0.05
                d["club"] = wf >= 3.0
                self.tracks.append(d)
                w.append(wf * (1.0 if steady else 0.5))
        self.p = np.array(w) / np.sum(w)

    def sample(self) -> dict:
        r = self.rng
        ia, ib = r.choice(len(self.tracks), 2, replace=False, p=self.p)
        fa, fb = self.tracks[ia], self.tracks[ib]
        L = int(r.choice(self.lengths))
        na, nb = len(fa["beats"]), len(fb["beats"])
        # A: spesso sul suo outro vero (fino a 8 battute prima), altrimenti una battuta forte nell'ultimo 45%
        cand = np.array([], int)
        if self.use_outro and fa["outro"] is not None and r.random() < 0.6:
            o = fa["outro"]
            cand = np.where((fa["pos"] == 0) & (np.arange(na) >= o - 32) & (np.arange(na) <= o) & (np.arange(na) + L <= na))[0]
        if not len(cand):
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
        if r.random() < self.human_share:
            return self.human_curve(y, L, bars, phrase, club=bool(fa["club"] and fb["club"]))
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

    def human_curve(self, y: np.ndarray, L: int, bars: np.ndarray, phrase: np.ndarray, club: bool = True) -> np.ndarray:
        """Crossfader con la forma e la durata di una transizione umana (dataset di Gand), che parte su una
        battuta forte (spesso a inizio frase); bass swap dove l'umano passa la metà (6 volte su 10). Se uno dei
        due brani non è da club (Jamendo: pop, rock, hip hop…) i bassi si scambiano sempre: nelle dissolvenze
        lunghe di questi generi due linee di basso insieme si sentono (dalla v5)."""
        r = self.rng
        t = self.templates[int(r.integers(len(self.templates)))]
        D = int(np.clip(round(t["beats"]), 4, L - 2))
        starts = [b for b in (phrase if len(phrase) and r.random() < 0.6 else bars) if b + D <= L]
        s = int(r.choice(starts)) if starts else 0
        j = np.arange(L)
        shape = np.asarray(t["shape"])
        y[:, 0] = np.where(j < s, 0, np.where(j >= s + D, 1, np.interp((j - s) / max(1, D), np.linspace(0, 1, len(shape)), shape)))
        if not club or r.random() < 0.6:
            half = int(np.argmax(y[:, 0] >= 0.5))
            swap = int(bars[np.argmin(np.abs(bars - half))]) if len(bars) else half
            y[:, 4] = np.where(j < swap, -1, 0)
            y[:, 1] = np.where(j < swap, 0, -1)
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
