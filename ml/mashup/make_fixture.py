"""Riferimenti per i test JS della STFT di Demucs (test/fixtures/demucs/stft.json): spettro di
ml/mashup/export_demucs.spec (una frequenza ogni 16) per un segnale stereo di 0,5 s definito da una formula
(la stessa di test/demucs.test.js)."""
import json, sys
from pathlib import Path
import numpy as np, torch
ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "mashup"))
from export_demucs import ispec, magnitude, spec  # noqa: E402
n = 22050
t = np.arange(n) / 44100
x = np.stack([0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 1234.5 * t),
              0.2 * np.sin(2 * np.pi * 330 * t) + 0.1 * np.sin(2 * np.pi * 3210 * t)]).astype(np.float32)
m = magnitude(spec(torch.from_numpy(x)[None]))[0].numpy()  # (4, 2048, T)
# ISTFT di Demucs sullo spettro: ai bordi del blocco non ricostruisce x (frame scartati da _spec), al centro sì
y = ispec(spec(torch.from_numpy(x)[None]), n)[0, 0].numpy()
out = {"n": n, "T": int(m.shape[-1]), "step": 16,
       "spec": np.round(m[:, ::16, :], 7).reshape(-1).tolist(),
       "istftHead": np.round(y[:3072:4], 7).tolist(), "istftTail": np.round(y[-3072::4], 7).tolist()}
dest = ML_DIR.parent / "test" / "fixtures" / "demucs" / "stft.json"
dest.write_text(json.dumps(out))
print(dest, m.shape, dest.stat().st_size // 1024, "KB")
