"""Audio per il confronto d'ascolto: per alcune transizioni reali crea tre WAV (solo uso locale, audio protetto):
  <n>_1_reale.wav    estratto del mix del DJ
  <n>_2_regole.wav   stessa finestra con il motore a regole attuale (bass swap)
  <n>_3_modello.wav  stessa finestra con le curve del modello C
I brani sono riportati sulla griglia di battute del mix (come fa il DJ col pitch) e mixati con crossfader "smooth"
ed EQ a 3 bande (crossover Linkwitz-Riley a 220 e 3500 Hz, guadagni come i knob dell'app). 8 battute prima e dopo.

Uso:  ml/.venv/bin/python ml/transitions/render.py --ckpt ml/data/runs/transition-planner.pt --items 0 5 9
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.signal import butter, sosfilt

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import N_IN  # noqa: E402
from model import TransitionPlanner  # noqa: E402
from train import rules_curves  # noqa: E402

DATA = ML_DIR / "data" / "djmix"
OUT = ML_DIR / "data" / "listening"
SR = 44100
PAD = 8


def decode(stem: str) -> np.ndarray:
    path = next(p for p in (DATA / "audio").glob(f"{stem}.*"))
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"]
    return np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, np.float32)


def warp(audio: np.ndarray, src_beats: np.ndarray, dst_beats: np.ndarray, t0: float, t1: float) -> np.ndarray:
    """Riporta l'audio di un brano sulla griglia del mix: per ogni istante del mix, il punto del brano
    alla stessa frazione di battuta (interpolazione lineare tra le battute)."""
    t = np.arange(int(t0 * SR), int(t1 * SR)) / SR
    src_t = np.interp(t, dst_beats, src_beats, left=np.nan, right=np.nan)
    ok = ~np.isnan(src_t)
    out = np.zeros(len(t), np.float32)
    idx = src_t[ok] * SR
    out[ok] = np.interp(idx, np.arange(len(audio)), audio, left=0, right=0)
    return out


LP = butter(2, 220, "low", fs=SR, output="sos")
HP = butter(2, 3500, "high", fs=SR, output="sos")


def bands(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    low = sosfilt(LP, sosfilt(LP, x))
    high = sosfilt(HP, sosfilt(HP, x))
    return low, x - low - high, high


def apply(xa, xb, curves, beat_times, t0):
    """Mix con i controlli per battuta (curve L×9) interpolati sui campioni."""
    n = len(xa)
    t = t0 + np.arange(n) / SR
    c = np.stack([np.interp(t, beat_times, curves[:, k]) for k in range(9)], 1)
    xf = c[:, 0]
    ga = np.minimum(1, np.cos(xf * np.pi / 2) * np.sqrt(2))
    gb = np.minimum(1, np.sin(xf * np.pi / 2) * np.sqrt(2))
    out = np.zeros(n, np.float32)
    for sig, fader, eq in ((xa, ga, c[:, 1:4]), (xb, gb, c[:, 4:7])):
        for i, part in enumerate(bands(sig)):
            out += (fader * 10 ** (1.5 * eq[:, i]) * part).astype(np.float32)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default=str(ML_DIR / "data" / "runs" / "transition-planner.pt"))
    ap.add_argument("--items", type=int, nargs="+", default=[0])
    args = ap.parse_args()
    d = np.load(DATA / "transitions.npz")
    meta = json.loads(str(d["meta"]))
    net = TransitionPlanner(N_IN)
    net.load_state_dict(torch.load(args.ckpt, map_location="cpu"))
    net.eval()
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for i in args.items:
        m = meta[i]
        L = m["length"]
        fm, fa, fb = (np.load(DATA / "features" / f"{s}.npz") for s in (m["mix"], f"yt-{m['idA']}", f"yt-{m['idB']}"))
        mb = fm["beats"]
        j0 = m["mixStartBeat"]
        js = np.arange(j0 - PAD, j0 + L + PAD)
        js = js[(js >= 0) & (js < len(mb))]
        t0, t1 = float(mb[js[0]]), float(mb[js[-1]])
        # battute corrispondenti nei due brani (offset costante lungo la finestra)
        kA = m["kA0"] + (js - j0)
        kB = m["kB0"] + (js - j0)
        okA = (kA >= 0) & (kA < len(fa["beats"]))
        okB = (kB >= 0) & (kB < len(fb["beats"]))
        xa = warp(decode(f"yt-{m['idA']}"), fa["beats"][kA[okA]], mb[js[okA]], t0, t1)
        xb = warp(decode(f"yt-{m['idB']}"), fb["beats"][kB[okB]], mb[js[okB]], t0, t1)
        # curve sulla finestra, estese: prima solo A, dopo solo B
        with torch.no_grad():
            model_c = net(torch.from_numpy(d["X"][i:i + 1]), torch.from_numpy(d["mask"][i:i + 1]))[0, :L].numpy()
        pre = np.zeros((PAD, 9), np.float32)
        post = np.zeros((PAD, 9), np.float32)
        post[:, 0] = 1
        full = lambda c: np.concatenate([pre, c, post])[: len(js)]  # noqa: E731
        mix = decode(m["mix"])[int(t0 * SR):int(t1 * SR)]
        name = f"{i:02d}_{m['mix']}_{m['posA']:02d}"
        peak = max(np.abs(mix).max(), 1e-6)
        for tag, sig in (("1_reale", mix), ("2_regole", apply(xa, xb, full(rules_curves("bassswap", L)), mb[js], t0)),
                         ("3_modello", apply(xa, xb, full(model_c), mb[js], t0))):
            sig = sig / max(np.abs(sig).max(), 1e-6) * min(peak, 0.9)
            sf.write(OUT / f"{name}_{tag}.wav", sig, SR, subtype="PCM_16")
        index.append({"file": name, "battute": L, "secondi": round(t1 - t0, 1)})
        print(name, L, "battute", round(t1 - t0, 1), "s")
    (OUT / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
