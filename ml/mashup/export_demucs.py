"""Esporta Demucs v4 (htdemucs, Meta/Alexandre Défossez, codice MIT) in ONNX per la separazione nell'app.

La parte con i numeri complessi (STFT e inversa) resta fuori dal modello e si calcola in JavaScript
(src/renderer/js/dsp/demucs.js), come fa questo file in Python:
    ingressi  mix  (1, 2, 343980)        blocco stereo di 7,8 s a 44,1 kHz
              spec (1, 4, 2048, 336)     STFT (reale/immaginario per canale) come HTDemucs._spec/_magnitude
    uscite    freq (1, 4, 4, 2048, 336)  ramo in frequenza (sorgenti × reale/immaginario per canale), denormalizzato
              time (1, 4, 2, 343980)     ramo nel tempo, denormalizzato
Separazione = ISTFT(freq) + time, sorgenti: drums, bass, other, vocals.

Licenza dei pesi: il codice è MIT, il README non parla dei pesi; htdemucs è addestrato anche su MUSDB18-HQ
(solo ricerca non commerciale). Uso deciso dall'utente il 27/09/2026, annotato in ml/REPORT.md.

Uso:  ml/.venv/bin/python ml/mashup/export_demucs.py [--int8]
      (versione 2, solo il sotto-modello voce di htdemucs_ft e base = mix − voce dentro il modello:)
      ml/.venv/bin/python ml/mashup/export_demucs.py --model htdemucs_ft --sub 3 --base mix-voce \
          --name segueo-separazione-voce-v2.onnx

--base mix-voce: le uscite restano (1, 4, 4, 2048, 336) e (1, 4, 2, 343980), ma al posto di batteria, basso e altro
il modello restituisce "mix − voce" nella prima sorgente (ramo in frequenza: −voce, ramo nel tempo: mix − voce) e
zeri nelle altre due. demucs.js, che somma le sorgenti diverse dalla voce, ottiene così base = mix − voce senza
modifiche (ISTFT lineare: ISTFT(−voce_f) + mix − voce_t = mix − voce). demucs.js aggiunge poi la media del brano
a ognuna delle tre sorgenti della base (come demucs con la somma): la base esce mix − voce + 3·media.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402

ONNX_DIR = ML_DIR / "data" / "onnx"


class Core(torch.nn.Module):
    """HTDemucs.forward senza _spec/_magnitude all'inizio e senza _mask/_ispec alla fine."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T) * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1]) * stdt[:, None] + meant[:, None]
        return x, xt


class MixMinusVoice(torch.nn.Module):
    """Core con base = mix − voce nella sorgente 0 (vedi --base mix-voce); la voce resta dov'è."""

    def __init__(self, core, voice: int = 3):
        super().__init__()
        self.core = core
        self.voice = voice

    def forward(self, mix, mag):
        x, xt = self.core(mix, mag)
        v = self.voice
        xv, tv = x[:, v:v + 1], xt[:, v:v + 1]
        # zeri calcolati (non zeros_like: l'export li piegherebbe in una costante da 11 MB dentro il file)
        fz, tz = xv * 0.0, tv * 0.0
        x = torch.cat([-xv, fz, fz, xv], dim=1)
        xt = torch.cat([mix[:, None] - tv, tz, tz, tv], dim=1)
        return x, xt


# --- STFT come HTDemucs._spec / _ispec (riferimento per la versione JavaScript) ---------------------------

NFFT, HOP = 4096, 1024


def spec(mix: torch.Tensor) -> torch.Tensor:
    le = int(math.ceil(mix.shape[-1] / HOP))
    pad = HOP // 2 * 3
    x = F.pad(mix, (pad, pad + le * HOP - mix.shape[-1]), mode="reflect")
    z = torch.stft(x.reshape(-1, x.shape[-1]), NFFT, HOP, window=torch.hann_window(NFFT), win_length=NFFT,
                   normalized=True, center=True, return_complex=True, pad_mode="reflect")
    z = z.view(*mix.shape[:-1], z.shape[-2], z.shape[-1])[..., :-1, :]
    return z[..., 2: 2 + le]


def magnitude(z: torch.Tensor) -> torch.Tensor:
    B, C, Fr, T = z.shape
    return torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(B, C * 2, Fr, T)


def ispec(zout: torch.Tensor, length: int) -> torch.Tensor:
    z = F.pad(zout, (0, 0, 0, 1))
    z = F.pad(z, (2, 2))
    pad = HOP // 2 * 3
    le = HOP * int(math.ceil(length / HOP)) + 2 * pad
    *other, freqs, frames = z.shape
    x = torch.istft(z.reshape(-1, freqs, frames), NFFT, HOP, window=torch.hann_window(NFFT), win_length=NFFT,
                    normalized=True, length=le, center=True)
    return x.view(*other, -1)[..., pad: pad + length]


def separate_chunk(run_core, mix: torch.Tensor) -> torch.Tensor:
    """Un blocco (1, 2, L) -> sorgenti (1, 4, 2, L) con la STFT fuori dal modello."""
    z = spec(mix)
    freq, tim = run_core(mix, magnitude(z))
    B, S, C2, Fq, T = freq.shape
    zout = torch.view_as_complex(freq.view(B, S, -1, 2, Fq, T).permute(0, 1, 2, 4, 5, 3).contiguous())
    return ispec(zout, mix.shape[-1]) + tim


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--int8", action="store_true")
    ap.add_argument("--model", default="htdemucs", help="htdemucs o htdemucs_ft")
    ap.add_argument("--sub", type=int, default=0, help="sotto-modello del gruppo (htdemucs_ft: 3 = voce)")
    ap.add_argument("--base", choices=["somma", "mix-voce"], default="somma")
    ap.add_argument("--name", default="htdemucs.onnx")
    args = ap.parse_args()
    bag = get_model(args.model)
    model = bag.models[args.sub] if hasattr(bag, "models") else bag
    if hasattr(bag, "weights"):
        print("pesi del sotto-modello nel gruppo", list(bag.weights[args.sub]))
    model.eval()
    L = int(model.segment * model.samplerate)
    print("campioni per blocco", L, "sorgenti", model.sources)
    core = Core(model).eval()
    voice = model.sources.index("vocals")
    if args.base == "mix-voce":
        core = MixMinusVoice(core, voice).eval()
    mix = torch.randn(1, 2, L) * 0.1
    mag = magnitude(spec(mix))
    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    fp32 = ONNX_DIR / args.name
    stem = fp32.name.removesuffix(".onnx")
    # la scorciatoia nativa dell'attenzione (_native_multi_head_attention) non esiste in ONNX
    torch.backends.mha.set_fastpath_enabled(False)
    with torch.inference_mode():
        torch.onnx.export(core, (mix, mag), str(fp32), input_names=["mix", "spec"], output_names=["freq", "time"],
                          opset_version=17, do_constant_folding=True, dynamo=False)
    core.eval()
    onnx.checker.check_model(str(fp32))
    report = {"fp32MB": round(fp32.stat().st_size / 1e6, 1), "samplesPerChunk": L}

    # parità: brano vero (primo blocco di Realizer) con PyTorch intero contro STFT esterna + ONNX
    import subprocess

    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", "60", "-t", str(L / 44100 + 0.1), "-i",
                          str(ML_DIR / "data" / "audio" / "cc" / "Realizer.mp3"), "-f", "f32le", "-ac", "2", "-ar", "44100", "-"],
                         capture_output=True, check=True).stdout
    real = torch.from_numpy(np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy())[None, :, :L]
    with torch.inference_mode():
        ref = model(real)
    if args.base == "mix-voce":  # riferimento PyTorch con la stessa trasformazione delle uscite
        z = torch.zeros_like(ref[:, :1])
        ref = torch.cat([real[:, None] - ref[:, voice:voice + 1], z, z, ref[:, voice:voice + 1]], dim=1)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 6
    variants = [("fp32", fp32)]
    if args.int8:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        from onnxruntime.quantization.shape_inference import quant_pre_process

        pre = ONNX_DIR / f"{stem}-pre.onnx"
        int8 = ONNX_DIR / f"{stem}-int8.onnx"
        quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
        quantize_dynamic(str(pre), str(int8), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"],
                         per_channel=True, extra_options={"MatMulConstBOnly": True})
        pre.unlink()
        report["int8MB"] = round(int8.stat().st_size / 1e6, 1)
        variants.append(("int8", int8))
    for name, path in variants:
        sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])

        def run(m, s):
            f, t = sess.run(["freq", "time"], {"mix": m.numpy(), "spec": s.numpy()})
            return torch.from_numpy(f), torch.from_numpy(t)

        t0 = time.time()
        out = separate_chunk(run, real)
        dt = time.time() - t0
        err = (out - ref).pow(2).sum() / ref.pow(2).sum()
        db = lambda r, o: round(float(10 * torch.log10(r.pow(2).sum() / (o - r).pow(2).sum())), 1)  # noqa: E731
        if args.base == "mix-voce":
            sdr = {"vocals": db(ref[0, voice], out[0, voice]),
                   "base": db(ref[0].sum(0) - ref[0, voice], out[0].sum(0) - out[0, voice])}
        else:
            sdr = {src: db(ref[0, i], out[0, i]) for i, src in enumerate(model.sources)}
        report[name] = {"erroreRelativo": float(err), "sdrControPyTorchDb": sdr, "secondiPerBlocco": round(dt, 2)}
    report.update(model=args.model, sub=args.sub, base=args.base)
    print(json.dumps(report, indent=1))
    (ONNX_DIR / f"{stem}-report.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
