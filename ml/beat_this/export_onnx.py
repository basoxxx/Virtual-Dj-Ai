"""Esporta i checkpoint ufficiali di Beat This! (CPJKU, licenza MIT anche per i pesi) in ONNX.

Per ogni modello (final0, small0) crea in ml/data/onnx/:
  beat_this-<nome>.onnx        fp32, ingresso fisso (1, 1500, 128)
  beat_this-<nome>-int8.onnx   quantizzazione dinamica int8 dei MatMul/Gemm con pesi costanti
e controlla la parità dei logit con PyTorch. Salva poi gli output di riferimento per i test
JavaScript in test/fixtures/beat-this/ (spettrogramma e logit del brano sintetico di prova).

Uso:  ml/.venv/bin/python ml/beat_this/export_onnx.py [--models final0 small0]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
REPO = ML_DIR.parent
DATA = ML_DIR / "data"
os.environ.setdefault("TORCH_HOME", str(DATA / "torch"))

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402
from onnxruntime.quantization.shape_inference import quant_pre_process  # noqa: E402
from rotary_embedding_torch import RotaryEmbedding  # noqa: E402

from beat_this.inference import CHECKPOINT_URL, load_model  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference as ref  # noqa: E402

CKPT_DIR = DATA / "checkpoints"
ONNX_DIR = DATA / "onnx"
REF_DIR = DATA / "reference"
FIXTURES = REPO / "test" / "fixtures" / "beat-this"
CLIP_SECONDS = 6


class BeatThisOnnx(torch.nn.Module):
    """Uscite separate e con nome al posto del dizionario di BeatThis."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def download_checkpoint(name: str) -> Path:
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    path = CKPT_DIR / f"beat_this-{name}.ckpt"
    if not path.exists():
        print(f"scarico {name}…")
        torch.hub.download_url_to_file(f"{CHECKPOINT_URL}/{name}.ckpt", str(path))
    return path


def export(name: str) -> tuple[Path, Path, torch.nn.Module]:
    model = load_model(str(download_checkpoint(name)), "cpu")
    # la cache delle rotary embedding scrive nei buffer: con forma fissa le frequenze
    # calcolate al volo diventano costanti nel grafo
    for m in model.modules():
        if isinstance(m, RotaryEmbedding):
            m.cache_if_possible = False
    wrapper = BeatThisOnnx(model).eval()
    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    fp32 = ONNX_DIR / f"beat_this-{name}.onnx"
    dummy = torch.randn(1, ref.CHUNK, 128)
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (dummy,),
            str(fp32),
            input_names=["spect"],
            output_names=["beat", "downbeat"],
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )
    onnx.checker.check_model(str(fp32))

    pre = ONNX_DIR / f"beat_this-{name}-pre.onnx"
    int8 = ONNX_DIR / f"beat_this-{name}-int8.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    quantize_dynamic(
        str(pre),
        str(int8),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
        per_channel=True,
        extra_options={"MatMulConstBOnly": True},
    )
    pre.unlink()
    return fp32, int8, model


def make_clip() -> Path:
    """Scrive in WAV il brano sintetico di test/helpers/music.js (stessi campioni dei test JS)."""
    REF_DIR.mkdir(parents=True, exist_ok=True)
    out = REF_DIR / "clip.wav"
    code = (
        "import { musicClip } from './test/helpers/music.js';"
        "import { encodeWav } from './src/renderer/js/dsp/wav.js';"
        "import { writeFileSync } from 'node:fs';"
        f"writeFileSync(process.argv[1], encodeWav([musicClip(22050, {CLIP_SECONDS})], 22050));"
    )
    subprocess.run(["node", "--input-type=module", "-e", code, str(out)], cwd=REPO, check=True)
    return out


def max_err(a, b) -> float:
    return float(np.max(np.abs(np.asarray(a) - np.asarray(b))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["final0", "small0"])
    args = ap.parse_args()
    torch.manual_seed(0)

    clip_path = make_clip()
    clip, sr = sf.read(clip_path, dtype="float32")
    assert sr == ref.SAMPLE_RATE
    clip_mel = ref.log_mel(clip)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    clip_mel.astype("<f4").tofile(FIXTURES / "clip-mel.f32")

    # spettrogramma "vero" per la parità: 60 s di brano sintetico a tempo diverso
    rng = np.random.default_rng(0)
    long_spect = np.concatenate([clip_mel] * 10)[: 2 * ref.CHUNK].copy()
    long_spect += rng.normal(0, 0.05, long_spect.shape).astype(np.float32)

    meta = {"clipSeconds": CLIP_SECONDS, "sampleRate": ref.SAMPLE_RATE, "frames": int(clip_mel.shape[0]), "models": {}}
    for name in args.models:
        fp32, int8, model = export(name)
        run_torch = ref.torch_runner(model)
        report = {"fp32MB": round(fp32.stat().st_size / 1e6, 2), "int8MB": round(int8.stat().st_size / 1e6, 2)}
        torch_logits = ref.predict_logits(long_spect, run_torch)
        for variant, path in (("fp32", fp32), ("int8", int8)):
            sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            logits = ref.predict_logits(long_spect, ref.onnx_runner(sess))
            report[f"{variant}MaxLogitErr"] = round(max(max_err(logits[0], torch_logits[0]), max_err(logits[1], torch_logits[1])), 5)
            tb, tdb = ref.postprocess(*torch_logits)
            ob, odb = ref.postprocess(*logits)
            report[f"{variant}SameBeats"] = bool(len(tb) == len(ob) and np.allclose(tb, ob, atol=0.021))
            report[f"{variant}SameDownbeats"] = bool(len(tdb) == len(odb) and np.allclose(tdb, odb, atol=0.021))
            # riferimenti per i test JS: logit ONNX sul brano sintetico
            clip_logits = ref.predict_logits(clip_mel, ref.onnx_runner(sess))
            np.stack(clip_logits).astype("<f4").tofile(FIXTURES / f"clip-logits-{name}-{variant}.f32")
            beats, downbeats = ref.postprocess(*clip_logits)
            report[f"{variant}ClipBeats"] = [round(float(b), 3) for b in beats]
            report[f"{variant}ClipDownbeats"] = [round(float(b), 3) for b in downbeats]
        meta["models"][name] = report
        print(name, json.dumps({k: v for k, v in report.items() if "Clip" not in k}))
    (FIXTURES / "reference.json").write_text(json.dumps(meta, indent=1) + "\n")


if __name__ == "__main__":
    main()
