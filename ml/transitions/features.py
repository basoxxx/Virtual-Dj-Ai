"""Caratteristiche per battuta di mix e brani (DJ Mix Dataset), salvate in ml/data/djmix/features/<nome>.npz.

Per ogni file audio:
  - decodifica mono a 22050 Hz con ffmpeg (a blocchi, senza tenere l'audio su disco)
  - battute e battute forti con Beat This! final0 (ONNX, CPU)
  - per battuta:
      chroma (12), log-mel (32) e log-mel a 16 bande in 4 sottodivisioni (schema ritmico)
                                    -> allineamento mix-brano
      potenza in 3 bande e in 64 bande logaritmiche -> stima dei guadagni (bande dell'EQ dell'app:
                                    <220 Hz, 220-3500 Hz, >3500 Hz; le 64 bande rendono il problema identificabile)
      forma d'onda low/mid/high/peak come computeWaveform dell'app (filtri a un polo 220/2800 Hz)
                                    -> ingresso del modello, identico a quello che l'app ha in memoria

Uso:  ml/.venv/bin/python ml/transitions/features.py <file audio>...   (oppure --all per tutti i file scaricati)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from scipy.signal import lfilter

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "beat_this"))
import reference as ref  # noqa: E402

DATA = ML_DIR / "data" / "djmix"
AUDIO = DATA / "audio"
OUT = DATA / "features"
SR = 22050
N_FFT = 2048
HOP = 512
EQ_EDGES = (220.0, 3500.0)
_session = None


def decode(path: Path) -> np.ndarray:
    """Audio mono float32 a 22050 Hz (media dei canali, come beat_this)."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def beat_this(mono: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    global _session
    if _session is None:
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("BT_THREADS", "6"))
        _session = ort.InferenceSession(str(ML_DIR / "data" / "onnx" / "beat_this-final0.onnx"), so, providers=["CPUExecutionProvider"])
    return ref.postprocess(*ref.predict_logits(ref.log_mel(mono), ref.onnx_runner(_session)))


def _filters():
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    # chroma: bin -> classe di altezza (55 Hz - 5 kHz), peso decrescente con la distanza dal semitono
    chroma = np.zeros((12, len(freqs)), dtype=np.float32)
    for k, f in enumerate(freqs):
        if 55 <= f <= 5000:
            midi = 69 + 12 * np.log2(f / 440)
            n = int(round(midi))
            chroma[n % 12, k] = max(0.0, 1 - 2 * abs(midi - n))
    # 32 bande mel (triangolari) 30 Hz - 11 kHz
    mel = lambda f: 2595 * np.log10(1 + f / 700)  # noqa: E731
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)  # noqa: E731
    pts = imel(np.linspace(mel(30), mel(11000), 34))
    fb = np.zeros((32, len(freqs)), dtype=np.float32)
    for i in range(32):
        lo, mid, hi = pts[i], pts[i + 1], pts[i + 2]
        fb[i] = np.maximum(0, np.minimum((freqs - lo) / (mid - lo), (hi - freqs) / (hi - mid)))
    bands = np.stack([freqs < EQ_EDGES[0], (freqs >= EQ_EDGES[0]) & (freqs < EQ_EDGES[1]), freqs >= EQ_EDGES[1]]).astype(np.float32)
    # 64 bande logaritmiche rettangolari 30 Hz - 11 kHz (potenza lineare, sommabile tra brani)
    log_edges = np.geomspace(30, 11000, 65)
    fine = np.stack([(freqs >= log_edges[i]) & (freqs < log_edges[i + 1]) for i in range(64)]).astype(np.float32)
    return chroma, fb, bands, fine, log_edges


CHROMA, MEL, BANDS, FINE, FINE_EDGES = _filters()
# banda dell'EQ (0 bassi, 1 medi, 2 alti) di ciascuna delle 64 bande, dal centro geometrico
FINE_EQ_BAND = np.digitize(np.sqrt(FINE_EDGES[:-1] * FINE_EDGES[1:]), EQ_EDGES)


def frame_features(mono: np.ndarray) -> dict:
    """Caratteristiche per frame STFT (hop 512 = 23 ms), a blocchi per contenere la memoria."""
    win = np.hanning(N_FFT).astype(np.float32)
    n_frames = 1 + max(0, (len(mono) - N_FFT) // HOP)
    out = {"chroma": np.zeros((n_frames, 12), np.float32), "mel": np.zeros((n_frames, 32), np.float32),
           "band": np.zeros((n_frames, 3), np.float32), "fine": np.zeros((n_frames, 64), np.float32)}
    step = 4096
    for f0 in range(0, n_frames, step):
        f1 = min(n_frames, f0 + step)
        idx = np.arange(f0, f1)[:, None] * HOP + np.arange(N_FFT)[None, :]
        power = np.abs(np.fft.rfft(mono[idx] * win, axis=1)) ** 2
        out["chroma"][f0:f1] = power @ CHROMA.T
        out["mel"][f0:f1] = power @ MEL.T
        out["band"][f0:f1] = power @ BANDS.T
        out["fine"][f0:f1] = power @ FINE.T
    return out


def waveform_bands(mono: np.ndarray) -> np.ndarray:
    """Come computeWaveform (src/renderer/js/dsp/analysis.js): RMS delle bande a filtri a un polo, 150 punti/s."""
    a_low = 1 - np.exp(-2 * np.pi * 220 / SR)
    a_high = 1 - np.exp(-2 * np.pi * 2800 / SR)
    lp = lfilter([a_low], [1, a_low - 1], mono)
    lp2 = lfilter([a_high], [1, a_high - 1], mono)
    hi = mono - lp2
    md = lp2 - lp
    spb = max(1, round(SR / 150))
    n = len(mono) // spb
    rs = lambda x: x[: n * spb].reshape(n, spb)  # noqa: E731
    peak = np.abs(rs(mono)).max(1)
    low, mid, high = (np.sqrt((rs(x) ** 2).mean(1)) for x in (lp, md, hi))
    m = max(low.max(), mid.max(), high.max(), 1e-9)
    return np.stack([peak / max(peak.max(), 1e-9), low / m, mid / m, high / m], 1).astype(np.float32)


def per_beat(values: np.ndarray, rate: float, beats: np.ndarray, duration: float) -> np.ndarray:
    """Media dei valori (frame, dim) dentro ogni intervallo tra battute consecutive (l'ultima fino alla fine)."""
    edges = np.append(beats, duration)
    idx = np.clip(np.round(edges * rate).astype(int), 0, len(values))
    csum = np.concatenate([np.zeros((1, values.shape[1]), np.float64), np.cumsum(values, 0, dtype=np.float64)])
    n = np.maximum(1, idx[1:] - idx[:-1])[:, None]
    return ((csum[idx[1:]] - csum[idx[:-1]]) / n).astype(np.float32)


def sub_beats(beats: np.ndarray, duration: float, n: int = 4) -> np.ndarray:
    """Inizi delle n sottodivisioni di ogni battuta (l'ultima battuta dura quanto la precedente)."""
    ends = np.append(beats[1:], min(duration, beats[-1] + (beats[-1] - beats[-2] if len(beats) > 1 else 0.5)))
    frac = np.arange(n) / n
    return (beats[:, None] + (ends - beats)[:, None] * frac[None, :]).reshape(-1)


def extract(path: Path, out_dir: Path = OUT, name: str | None = None) -> Path:
    dest = out_dir / f"{name or path.stem.split('.')[0]}.npz"
    old = dict(np.load(dest)) if dest.exists() else None
    if old is not None and "pow64" in old:
        return dest
    t0 = time.time()
    mono = decode(path)
    duration = len(mono) / SR
    # le battute già calcolate si riusano (Beat This! è la parte lenta)
    if old is not None:
        beats, downbeats = old["beats"].astype(np.float64), old["downbeats"].astype(np.float64)
    else:
        beats, downbeats = beat_this(mono)
    ff = frame_features(mono)
    rate = SR / HOP
    wf = waveform_bands(mono)
    lm = np.log1p(ff["mel"])
    lm16 = 0.5 * (lm[:, 0::2] + lm[:, 1::2])
    sb = sub_beats(beats, duration)
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        dest,
        duration=duration,
        beats=beats.astype(np.float32),
        downbeats=downbeats.astype(np.float32),
        chroma=per_beat(ff["chroma"], rate, beats, duration),
        mel=per_beat(lm, rate, beats, duration),
        mel4=per_beat(lm16, rate, sb, duration).reshape(len(beats), -1),
        band=per_beat(ff["band"], rate, beats, duration),
        pow64=per_beat(ff["fine"], rate, beats, duration),
        wave=per_beat(wf, SR / max(1, round(SR / 150)), beats, duration),
    )
    print(f"{path.name}: {duration / 60:.1f} min, {len(beats)} battute, {time.time() - t0:.1f} s", flush=True)
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    files = [Path(f) for f in args.files]
    if args.all:
        files = sorted(p for p in AUDIO.iterdir() if p.suffix not in (".part", ".ytdl") and ".part" not in p.name)
    for f in files:
        try:
            extract(f)
        except Exception as err:
            print(f"{f.name}: ERRORE {err}", flush=True)


if __name__ == "__main__":
    main()
