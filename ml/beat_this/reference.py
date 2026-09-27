"""Pipeline di riferimento di Beat This! identica a quella dell'app.

Replica beat_this.inference (spettrogramma, blocchi da 1500 frame con bordo di 6,
post-processing "minimal") con una sola differenza voluta: il modello ONNX ha forma
fissa, quindi un brano più corto di un blocco viene completato con zeri fino a 1500
frame invece di passare al modello un blocco più corto.
"""

from __future__ import annotations

import numpy as np
import soxr
import torch

from beat_this.inference import aggregate_prediction, split_piece
from beat_this.model.postprocessor import Postprocessor
from beat_this.preprocessing import LogMelSpect

SAMPLE_RATE = 22050
CHUNK = 1500
BORDER = 6
FPS = 50

_spect = LogMelSpect()


def to_mono_22050(signal: np.ndarray, sr: int) -> np.ndarray:
    if signal.ndim == 2:
        signal = signal.mean(1)
    if sr != SAMPLE_RATE:
        signal = soxr.resample(signal, in_rate=sr, out_rate=SAMPLE_RATE)
    return np.asarray(signal, dtype=np.float32)


def log_mel(mono22050: np.ndarray) -> np.ndarray:
    """Spettrogramma log-mel (frame, 128) come beat_this.preprocessing.LogMelSpect."""
    with torch.inference_mode():
        return _spect(torch.from_numpy(np.asarray(mono22050, dtype=np.float32))).numpy()


def predict_logits(spect: np.ndarray, run_chunk) -> tuple[np.ndarray, np.ndarray]:
    """Divide in blocchi, esegue `run_chunk` (array (1,1500,128) -> (beat, downbeat)) e ricompone."""
    spect_t = torch.from_numpy(spect)
    chunks, starts = split_piece(spect_t, CHUNK, border_size=BORDER, avoid_short_end=True)
    preds = []
    for chunk in chunks:
        n = chunk.shape[0]
        x = np.zeros((1, CHUNK, spect.shape[1]), dtype=np.float32)
        x[0, :n] = chunk.numpy()
        beat, downbeat = run_chunk(x)
        # un blocco completato con zeri: si tiene solo la parte reale (+ bordo)
        preds.append({"beat": torch.from_numpy(np.asarray(beat).reshape(-1)[:n].copy()),
                      "downbeat": torch.from_numpy(np.asarray(downbeat).reshape(-1)[:n].copy())})
    if len(spect) <= CHUNK - 2 * BORDER:
        # caso del brano corto: un solo blocco di n = len+12 frame
        beat = preds[0]["beat"][BORDER:BORDER + len(spect)]
        downbeat = preds[0]["downbeat"][BORDER:BORDER + len(spect)]
        return beat.numpy(), downbeat.numpy()
    beat, downbeat = aggregate_prediction(preds, starts, len(spect), CHUNK, BORDER, "keep_first", "cpu")
    return beat.numpy(), downbeat.numpy()


def torch_runner(model):
    def run(x):
        with torch.inference_mode():
            out = model(torch.from_numpy(x))
        return out["beat"].numpy(), out["downbeat"].numpy()

    return run


def onnx_runner(session):
    def run(x):
        beat, downbeat = session.run(["beat", "downbeat"], {"spect": x})
        return beat, downbeat

    return run


_post = Postprocessor(type="minimal", fps=FPS)


def postprocess(beat_logits: np.ndarray, downbeat_logits: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    beats, downbeats = _post(torch.from_numpy(beat_logits), torch.from_numpy(downbeat_logits))
    return np.asarray(beats, dtype=np.float64), np.asarray(downbeats, dtype=np.float64)
