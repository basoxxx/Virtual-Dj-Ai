"""Riferimento PyTorch per la separazione in JS: 30 s di un brano (stereo, 44,1 kHz) e voce/base di
demucs.apply_model (shifts=0, overlap 0,25), come f32 grezzi in ml/data/stems/ref-*.f32.

Opzioni per la versione 2 (sotto-modello voce di htdemucs_ft, base = mix − voce come nel suo ONNX):
    ml/.venv/bin/python ml/mashup/reference_separation.py [brano] --model htdemucs_ft --sub 3 --base mix-voce --tag ref-v2
Con un file STEMS di MUSDB18 (--musdb) si salvano anche voce e base vere (<tag>-true-*.f32) per l'SDR in JS.
La base "mix − voce" del riferimento è quella che calcola demucs.js con l'ONNX v2: mix − voce + 3·media del brano
(demucs.js aggiunge la media del brano a ognuna delle tre sorgenti della base)."""
import argparse, os, subprocess
from pathlib import Path
ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))
import numpy as np, torch  # noqa: E402
from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402
ap = argparse.ArgumentParser()
ap.add_argument("src", nargs="?", default=str(ML_DIR / "data" / "audio" / "cc" / "Realizer.mp3"))
ap.add_argument("--model", default="htdemucs")
ap.add_argument("--sub", type=int, default=0)
ap.add_argument("--base", choices=["somma", "mix-voce"], default="somma")
ap.add_argument("--tag", default="ref")
ap.add_argument("--start", default="60")
ap.add_argument("--dur", default="30")
ap.add_argument("--musdb", action="store_true", help="il brano è un file STEMS di MUSDB18: mix = traccia 0")
a = ap.parse_args()


def decode(stream=None):
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-ss", a.start, "-t", a.dur, "-i", a.src]
    if stream is not None:
        cmd += ["-map", f"0:{stream}"]
    raw = subprocess.run(cmd + ["-f", "f32le", "-ac", "2", "-ar", "44100", "-"], capture_output=True, check=True).stdout
    return torch.from_numpy(np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy())


wav = decode(0 if a.musdb else None)
bag = get_model(a.model)
model = bag.models[a.sub]
ref = wav.mean(0); mean, std = ref.mean(), ref.std()
torch.backends.mha.set_fastpath_enabled(False)
with torch.no_grad():
    out = apply_model(model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.25, progress=False)[0] * std + mean
v = model.sources.index("vocals")
base = wav - out[v] + 3 * mean if a.base == "mix-voce" else out.sum(0) - out[v]
d = ML_DIR / "data" / "stems"; d.mkdir(parents=True, exist_ok=True)
wav.numpy().astype("<f4").tofile(d / f"{a.tag}-mix.f32")
out[v].numpy().astype("<f4").tofile(d / f"{a.tag}-vocals.f32")
base.numpy().astype("<f4").tofile(d / f"{a.tag}-instrumental.f32")
if a.musdb:
    n = wav.shape[1]
    tv = decode(4)[:, :n]
    tb = decode(1)[:, :n] + decode(2)[:, :n] + decode(3)[:, :n]
    tv.numpy().astype("<f4").tofile(d / f"{a.tag}-true-vocals.f32")
    tb.numpy().astype("<f4").tofile(d / f"{a.tag}-true-instrumental.f32")
print("campioni", wav.shape[1], "media del brano", float(mean))
