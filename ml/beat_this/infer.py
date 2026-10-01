"""Logit, battute e battute forti di un modello Beat This! sui brani dell'inventario (spettrogrammi già calcolati).

Stessa catena dell'app (reference.py: blocchi da 1500 frame con bordo 6, completati con zeri, "keep_first",
post-processing "minimal"); con PyTorch i blocchi di un brano passano insieme in un solo batch.
Uscita: ml/data/beat_this/pred/<nome>/<id>.npz  (beat, downbeat: logit float16; beats, downbeats: secondi).
L'insegnante è pred/final0: ONNX fp32 su CPU (su MPS final0 con l'attenzione fusa occupa 15 GB e impiega 1,8 s a
blocco). Riprendibile; due processi possono lavorare in parallelo (--reverse).

Uso:  ml/.venv/bin/python ml/beat_this/infer.py --model ml/data/onnx/beat_this-final0.onnx --name final0 --threads 6
      ml/.venv/bin/python ml/beat_this/infer.py --model ml/data/onnx/beat_this-small0-int8.onnx --name small0-int8 \
          --splits test tag val
      ml/.venv/bin/python ml/beat_this/infer.py --model ml/data/beat_this/runs/B/best.ckpt --name B --device mps
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

from beat_this.inference import load_model  # noqa: E402

PRED = C.DATA / "pred"


def chunk_batch(spect: np.ndarray):
    """Blocchi come reference.predict_logits: (n, 1500, 128) completati con zeri, inizi e lunghezze reali."""
    chunks, starts = C.ref.split_piece(torch.from_numpy(np.ascontiguousarray(spect, dtype=np.float32)), C.ref.CHUNK,
                                       border_size=C.ref.BORDER, avoid_short_end=True)
    x = np.zeros((len(chunks), C.ref.CHUNK, spect.shape[1]), dtype=np.float32)
    lens = []
    for i, c in enumerate(chunks):
        x[i, : c.shape[0]] = c.numpy()
        lens.append(c.shape[0])
    return x, starts, lens


def assemble(spect_len: int, outs, starts, lens):
    """Ricompone i logit del brano come reference.predict_logits."""
    preds = [{"beat": torch.from_numpy(np.asarray(b[:n], dtype=np.float32).copy()),
              "downbeat": torch.from_numpy(np.asarray(d[:n], dtype=np.float32).copy())} for (b, d), n in zip(outs, lens)]
    B = C.ref.BORDER
    if spect_len <= C.ref.CHUNK - 2 * B:
        return preds[0]["beat"][B:B + spect_len].numpy(), preds[0]["downbeat"][B:B + spect_len].numpy()
    beat, downbeat = C.ref.aggregate_prediction(preds, starts, spect_len, C.ref.CHUNK, B, "keep_first", "cpu")
    return beat.numpy(), downbeat.numpy()


class TorchRunner:
    def __init__(self, model, device, max_batch=8):
        self.model = model.to(device).eval()
        self.device = device
        self.max_batch = max_batch

    def __call__(self, x: np.ndarray):
        outs = []
        with torch.inference_mode():
            for i in range(0, len(x), self.max_batch):
                o = retry_oom(lambda: self.model(torch.from_numpy(x[i:i + self.max_batch]).to(self.device)))
                b, d = o["beat"].float().cpu().numpy(), o["downbeat"].float().cpu().numpy()
                outs += list(zip(b, d))
        return outs


def use_matmul_attention():
    """Attenzione scritta a mano (prodotto, softmax, prodotto) al posto di F.scaled_dot_product_attention.
    Stesso risultato; su MPS (PyTorch 2.8) la versione fusa occupa molti GB anche con batch 1 (misurato:
    small0 3,6 GB con 1 blocco, 16 GB con 4) e rende impossibile l'addestramento sul Mac."""
    import torch.nn.functional as F

    from beat_this.model import roformer

    def forward(self, q, k, v):
        b, h, n, d = q.shape
        scale = self.scale if self.scale is not None else d ** -0.5
        # tensori 3D contigui: il passo all'indietro di matmul su MPS non accetta le viste di rearrange
        q3 = (q * scale).reshape(b * h, n, d).contiguous()
        k3 = k.reshape(b * h, n, d).contiguous()
        v3 = v.reshape(b * h, n, d).contiguous()
        attn = torch.bmm(q3, k3.transpose(1, 2).contiguous()).softmax(-1)
        if self.training and self.dropout:
            attn = F.dropout(attn, self.dropout)
        return torch.bmm(attn, v3).reshape(b, h, n, d)

    roformer.Attend.forward = forward


def retry_oom(fn, tries=20, wait=30):
    """GPU condivisa: se la memoria MPS manca (un altro processo), svuota la cache, aspetta e riprova."""
    for k in range(tries):
        try:
            return fn()
        except RuntimeError as e:
            if "out of memory" not in str(e) or k == tries - 1:
                raise
            print(f"memoria MPS esaurita, riprovo tra {wait} s ({k + 1}/{tries})", flush=True)
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
            time.sleep(wait)


class OnnxRunner:
    def __init__(self, path: str, threads: int):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])

    def __call__(self, x: np.ndarray):
        outs = []
        for c in x:
            b, d = self.sess.run(["beat", "downbeat"], {"spect": c[None]})
            outs.append((b.reshape(-1), d.reshape(-1)))
        return outs


def predict(runner, spect: np.ndarray):
    x, starts, lens = chunk_batch(spect)
    beat, downbeat = assemble(len(spect), runner(x), starts, lens)
    beats, downbeats = C.ref.postprocess(beat, downbeat)
    return beat, downbeat, beats, downbeats


def make_runner(model: str, device: str, threads: int = 4):
    if model.endswith(".onnx"):
        return OnnxRunner(model, threads)
    path = C.CKPT / f"beat_this-{model}.ckpt" if not model.endswith(".ckpt") else Path(model)
    if device == "mps":
        use_matmul_attention()
    return TorchRunner(load_model(str(path), "cpu"), device)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="final0, small0, file .ckpt o .onnx")
    ap.add_argument("--name", help="cartella di uscita (predefinito: nome del modello)")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--splits", nargs="+", default=["train", "val", "test", "tag"])
    ap.add_argument("--sources", nargs="+")
    ap.add_argument("--jamendo-frac", type=float, default=0.4, help="quota dei brani jamendo di addestramento")
    ap.add_argument("--reverse", action="store_true", help="dalla fine dell'elenco (per due processi in parallelo)")
    ap.add_argument("--max-minutes", type=float, default=0, help="si ferma dopo questi minuti (0 = mai)")
    ap.add_argument("--batch", type=int, default=8, help="blocchi per passata (PyTorch)")
    a = ap.parse_args()
    name = a.name or Path(a.model).stem.replace("beat_this-", "")
    out = PRED / name
    out.mkdir(parents=True, exist_ok=True)
    items = [it for it in C.load_inventory() if it["split"] in a.splits and (not a.sources or it["source"] in a.sources)
             and C.spect_path(it["id"]).exists() and not (out / f"{it['id']}.npz").exists()]
    # jamendo (generi vari) solo in parte: la musica dell'utente e la dance contano di più
    items = [it for it in items if not (it["source"] == "jamendo" and it["split"] == "train"
                                        and zlib.crc32(it["id"].encode()) % 100 >= 100 * a.jamendo_frac)]
    # prima i brani di valutazione, poi quelli della chiavetta
    items.sort(key=lambda it: (it["split"] == "train", it["source"] != "usb", it["id"]), reverse=a.reverse)
    runner = make_runner(a.model, a.device, a.threads)
    if isinstance(runner, TorchRunner):
        runner.max_batch = a.batch
    print(f"{name}: {len(items)} brani", flush=True)
    t0 = time.time()
    for i, it in enumerate(items):
        if a.max_minutes and time.time() - t0 > 60 * a.max_minutes:
            print("tempo scaduto", flush=True)
            break
        if (out / f"{it['id']}.npz").exists():  # fatto da un altro processo
            continue
        spect = np.asarray(C.load_spect(it["id"]), dtype=np.float32)
        beat, downbeat, beats, downbeats = predict(runner, spect)
        tmp = out / f"{it['id']}.tmp.npz"
        np.savez(tmp, beat=beat.astype(np.float16), downbeat=downbeat.astype(np.float16),
                 beats=beats.astype(np.float32), downbeats=downbeats.astype(np.float32))
        os.replace(tmp, out / f"{it['id']}.npz")
        if i % 100 == 0:
            print(f"{i}/{len(items)} ({time.time() - t0:.0f} s)", flush=True)
    print(f"fatto in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
