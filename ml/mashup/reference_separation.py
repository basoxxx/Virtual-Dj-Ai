"""Riferimento PyTorch per la separazione in JS: 30 s di un brano (stereo, 44,1 kHz) e voce/base di
demucs.apply_model (shifts=0, overlap 0,25), come f32 grezzi in ml/data/stems/ref-*.f32."""
import os, subprocess, sys
from pathlib import Path
ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))
import numpy as np, torch  # noqa: E402
from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402
src = sys.argv[1] if len(sys.argv) > 1 else str(ML_DIR / "data" / "audio" / "cc" / "Realizer.mp3")
raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", "60", "-t", "30", "-i", src, "-f", "f32le", "-ac", "2", "-ar", "44100", "-"], capture_output=True, check=True).stdout
wav = torch.from_numpy(np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy())
model = get_model("htdemucs")
ref = wav.mean(0); mean, std = ref.mean(), ref.std()
torch.backends.mha.set_fastpath_enabled(False)
with torch.no_grad():
    out = apply_model(model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.25, progress=False)[0] * std + mean
v = model.sources.index("vocals")
d = ML_DIR / "data" / "stems"; d.mkdir(parents=True, exist_ok=True)
wav.numpy().astype("<f4").tofile(d / "ref-mix.f32")
out[v].numpy().astype("<f4").tofile(d / "ref-vocals.f32")
(out.sum(0) - out[v]).numpy().astype("<f4").tofile(d / "ref-instrumental.f32")
print("campioni", wav.shape[1])
