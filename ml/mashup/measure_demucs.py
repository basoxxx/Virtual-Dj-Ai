"""Tempo e RAM di Demucs (htdemucs) in PyTorch su un brano, CPU o MPS. Salva voce e base in ml/data/stems.
Uso: ml/.venv/bin/python ml/mashup/measure_demucs.py <file> --device cpu|mps"""
import argparse, os, resource, sys, time
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))
import numpy as np, soundfile as sf, torch  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402
from demucs.apply import apply_model  # noqa: E402
from demucs.audio import convert_audio  # noqa: E402
import subprocess  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("file"); ap.add_argument("--device", default="cpu"); a = ap.parse_args()
t0 = time.time()
model = get_model("htdemucs"); model.eval()
sr = model.samplerate
raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", a.file, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"], capture_output=True, check=True).stdout
wav = torch.from_numpy(np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy())
t1 = time.time()
ref = wav.mean(0); mean, std = ref.mean(), ref.std()
with torch.no_grad():
    out = apply_model(model, ((wav - mean) / std)[None], device=a.device, shifts=0, split=True, overlap=0.25, progress=False)[0]
out = out * std + mean
t2 = time.time()
names = model.sources
voc = out[names.index("vocals")].numpy().T
inst = (out.sum(0) - out[names.index("vocals")]).numpy().T
stem = Path(a.file).stem
sf.write(ML_DIR / "data" / "stems" / f"{stem}-vocals.wav", voc, sr, subtype="PCM_16")
sf.write(ML_DIR / "data" / "stems" / f"{stem}-instrumental.wav", inst, sr, subtype="PCM_16")
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576  # macOS: byte
print(f"{a.device}: brano {wav.shape[1]/sr:.0f} s, separazione {t2-t1:.1f} s ({(t2-t1)/(wav.shape[1]/sr):.2f}x tempo reale), "
      f"caricamento {t1-t0:.1f} s, picco RAM {peak:.0f} MB, sorgenti {names}, parametri {sum(p.numel() for p in model.parameters())/1e6:.1f}M")
