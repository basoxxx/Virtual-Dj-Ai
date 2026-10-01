"""Rifinitura di Beat This! small0 con final0 come insegnante (stessa architettura, stessa interfaccia ONNX).

Dati: spettrogrammi in ml/data/beat_this/spect, etichette di labels.py (griglia a tempo costante per i brani
regolari, battute di final0 per gli altri) e logit di final0 (pred/final0) per la distillazione.
Perdita: BCE "shift tolerant" pesata come l'addestramento originale (pesi 19 battute / 86 battute forti, ±3 frame)
sulle etichette + `--soft` × BCE contro le probabilità di final0 frame per frame.
Aumenti al volo sullo spettrogramma (disattivabili con --p-tempo 0 --gain 0): tempo (interpolazione lungo il
tempo, ×0,85–1,18), guadagno e inclinazione spettrale (esatti sulla magnitudo); sempre blocchi permutati come
beat_this. BatchNorm congelate (statistiche di small0).
Su MPS (PyTorch 2.8) l'attenzione fusa occupa troppa memoria: si usa l'attenzione scritta a mano
(infer.use_matmul_attention), ricalcolata nel passo all'indietro (checkpoint) e BatchNorm con ingresso contiguo;
così il batch 2 sta in circa 8 GB (1,3 s a passo), il batch 4 va in swap: batch effettivo con --accum.
Validazione ogni --val-minutes di addestramento su usb/jamendo "val" con la griglia dell'app (beat-this.js) contro
quella di final0; checkpoint nel formato di beat_this (load_model li legge). Riprendibile (state.pt).

Uso:  ml/.venv/bin/python ml/beat_this/finetune.py --run B --minutes 30 --lr 2e-5 --batch 2 --accum 4 \
          --p-tempo 0 --gain 0 [--labels grid|teacher] [--soft 1]      (oppure --steps N --val-every M)
      -> ml/data/beat_this/runs/<run>/{log.jsonl, step-*.ckpt, best.ckpt, state.pt}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import infer as I  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from torch.utils.data import DataLoader, Dataset  # noqa: E402

from beat_this.inference import load_checkpoint, load_model  # noqa: E402
from beat_this.model.loss import ShiftTolerantBCELoss  # noqa: E402

RUNS = C.DATA / "runs"
L = C.ref.CHUNK
TEACHER = C.DATA / "pred" / "final0"
# quota di estratti per sorgente (la musica dell'utente e la dance contano di più)
SOURCE_WEIGHT = {"usb": 1.0, "gabry": 1.0, "lumix": 1.0, "djmix": 1.0, "djmix2": 1.0, "jamendo": 0.5}


class Excerpts(Dataset):
    """Estratti casuali da 1500 frame con etichette per frame, logit dell'insegnante e maschera."""

    def __init__(self, ids, labels, use_grid: bool, n: int, seed: int, tempo=(0.85, 1.18), p_tempo=0.5, p_mask=0.5):
        self.ids, self.labels, self.use_grid, self.n = ids, labels, use_grid, n
        self.seed, self.tempo, self.p_tempo, self.p_mask = seed, tempo, p_tempo, p_mask
        self.frames = {i: int(np.load(C.spect_path(i), mmap_mode="r").shape[0]) for i in ids}
        # probabilità di scelta: peso della sorgente × durata
        w = np.array([SOURCE_WEIGHT[labels[i]["source"]] * self.frames[i] for i in ids], float)
        self.p = w / w.sum()
        self.teacher_cache = {}

    def __len__(self):
        return self.n

    def _labels(self, tid):
        lab = self.labels[tid]
        if lab["kind"] == "grid" and not self.use_grid:
            # variante "teacher": battute di final0 anche per i brani a griglia
            return lab["t_beats"], lab["t_downbeats"], []
        return lab["beats"], lab["downbeats"], lab["mask"]

    def __getitem__(self, idx):
        rng = np.random.default_rng((self.seed, idx))
        tid = self.ids[rng.choice(len(self.ids), p=self.p)]
        n_src = self.frames[tid]
        f = math.exp(rng.uniform(math.log(self.tempo[0]), math.log(self.tempo[1]))) if rng.random() < self.p_tempo else 1.0
        span = min(n_src - 2, int(math.ceil(L * f)) + 1)
        f = min(f, (span - 1) / L)
        start = int(rng.integers(0, n_src - span + 1))
        spect = np.load(C.spect_path(tid), mmap_mode="r")
        src = np.asarray(spect[start:start + span], dtype=np.float32)
        z = np.load(TEACHER / f"{tid}.npz")
        tb = z["beat"][start:start + span].astype(np.float32)
        td = z["downbeat"][start:start + span].astype(np.float32)
        pos = np.arange(L) * f
        if f != 1.0:
            i0 = np.floor(pos).astype(int)
            w = (pos - i0).astype(np.float32)[:, None]
            i1 = np.minimum(i0 + 1, len(src) - 1)
            x = src[i0] * (1 - w) + src[i1] * w
            tb = tb[i0] * (1 - w[:, 0]) + tb[i1] * w[:, 0]
            td = td[i0] * (1 - w[:, 0]) + td[i1] * w[:, 0]
        else:
            x, tb, td = src[:L].copy(), tb[:L], td[:L]
        beats, downbeats, mask_iv = self._labels(tid)

        def frames_of(times):
            fr = np.round((np.asarray(times) * C.FPS - start) / f).astype(int)
            return fr[(fr >= 0) & (fr < L)]

        yb = np.zeros(L, np.float32)
        yd = np.zeros(L, np.float32)
        yb[frames_of(beats)] = 1
        yd[frames_of(downbeats)] = 1
        m = np.ones(L, np.float32)
        for a, b in mask_iv:
            fa = int((a * C.FPS - start) / f)
            fb = int(math.ceil((b * C.FPS - start) / f))
            if fb > 0 and fa < L:
                m[max(0, fa):min(L, fb)] = 0
        # blocchi permutati (come augment_mask_ di beat_this, kind="permute")
        if rng.random() < self.p_mask:
            for _ in range(int(rng.integers(1, 4))):
                ln = int(rng.integers(5, 50))
                s = int(rng.integers(0, L - ln))
                parts = np.array_split(x[s:s + ln], int(rng.integers(2, 6)))
                x[s:s + ln] = np.concatenate([parts[j] for j in rng.permutation(len(parts))])
        return {"spect": x.astype(np.float32), "beat": yb, "downbeat": yd, "mask": m, "t_beat": tb.astype(np.float32),
                "t_downbeat": td.astype(np.float32)}


def gain_tilt(x: torch.Tensor) -> torch.Tensor:
    """Guadagno casuale (×0,25–4) e inclinazione spettrale (±6 dB tra i bassi e gli acuti) sulla magnitudo mel."""
    b = x.shape[0]
    a = torch.empty(b, 1, 1, device=x.device).uniform_(math.log(0.25), math.log(4))
    t = torch.empty(b, 1, 1, device=x.device).uniform_(-0.7, 0.7)
    pos = torch.linspace(-1, 1, x.shape[-1], device=x.device)[None, None]
    g = torch.exp(a + t * pos)
    return torch.log1p(g * torch.expm1(x))


def freeze_bn(model):
    for m in model.modules():
        if isinstance(m, (torch.nn.BatchNorm1d, torch.nn.BatchNorm2d)):
            m.eval()


def checkpoint_attention(model):
    """Ricalcola l'attenzione nel passo all'indietro invece di tenerla in memoria: su MPS l'attenzione lungo il
    tempo (1500 × 1500 per banda di frequenza) non è "memory efficient" e con il batch 8 supera la RAM del Mac."""
    from torch.utils.checkpoint import checkpoint

    from beat_this.model.roformer import Attention
    for m in model.modules():
        if isinstance(m, Attention):
            f = m.forward
            m.forward = lambda x, f=f: checkpoint(f, x, use_reentrant=False) if torch.is_grad_enabled() else f(x)


def contiguous_bn(model):
    """Su MPS il passo all'indietro di batch_norm fallisce se l'ingresso è una vista trasposta (BatchNorm1d dopo
    Rearrange "b t f -> b f t" nello stem): si passa una copia contigua. I pesi e lo state_dict non cambiano."""
    for m in model.modules():
        if isinstance(m, (torch.nn.BatchNorm1d, torch.nn.BatchNorm2d)):
            f = m.forward
            m.forward = lambda x, f=f: f(x.contiguous())


def save_ckpt(model, path: Path, hparams: dict):
    sd = {f"model.{k}": v.detach().cpu() for k, v in model.state_dict().items()}
    torch.save({"hyper_parameters": hparams, "state_dict": sd}, path)


def validate(model, device, val_ids, labels) -> dict:
    """Battute del modello sui brani interi di validazione; griglia dell'app contro quella di final0."""
    model.eval()
    runner = I.TorchRunner(model, device, max_batch=2)
    items, teach, fb, fd, fbl = {}, {}, [], [], []
    for tid in val_ids:
        s = np.asarray(C.load_spect(tid), dtype=np.float32)
        _, _, beats, downbeats = I.predict(runner, s)
        z = np.load(TEACHER / f"{tid}.npz")
        items[tid] = {"beats": beats, "downbeats": downbeats}
        teach[tid] = {"beats": z["beats"], "downbeats": z["downbeats"]}
        fb.append(C.f_measure(z["beats"], beats))
        fd.append(C.f_measure(z["downbeats"], downbeats))
        fbl.append(C.f_measure(labels[tid]["beats"], beats))
    model.train()
    freeze_bn(model)
    g, gt = C.app_grids(items), C.app_grids(teach)
    bpm_ok = [C.ok_bpm(g[k]["bpm"], gt[k]["bpm"]) for k in val_ids if gt[k]["bpm"]]
    phase_ok = [C.grid_phase_ok(g[k]["bpm"], g[k]["offset"], 60 / gt[k]["bpm"], gt[k]["offset"])
                for k in val_ids if gt[k]["bpm"] and C.ok_bpm(g[k]["bpm"], gt[k]["bpm"])]
    return {"F_beat_vs_final0": float(np.mean(fb)), "F_down_vs_final0": float(np.mean(fd)),
            "F_beat_vs_labels": float(np.mean(fbl)), "bpm_agree": float(np.mean(bpm_ok)),
            "phase_agree": float(np.sum(phase_ok) / max(1, len(bpm_ok))), "n": len(val_ids)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--labels", choices=["grid", "teacher"], default="grid")
    ap.add_argument("--soft", type=float, default=1.0, help="peso della distillazione sui logit di final0")
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--accum", type=int, default=1, help="passi accumulati per ogni aggiornamento (batch effettivo)")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--warmup", type=int, default=300)
    ap.add_argument("--val-every", type=int, default=1000)
    ap.add_argument("--minutes", type=float, default=0, help="durata in minuti di addestramento (al posto di --steps): "
                    "il coseno del tasso segue il tempo trascorso")
    ap.add_argument("--val-minutes", type=float, default=10, help="con --minutes: validazione ogni tot minuti")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--init", default=str(C.CKPT / "beat_this-small0.ckpt"))
    ap.add_argument("--max-val", type=int, default=0, help="solo per prove: al massimo N brani di validazione")
    ap.add_argument("--p-tempo", type=float, default=0.5, help="probabilità dell'aumento di tempo")
    ap.add_argument("--gain", type=int, default=1, help="1 = guadagno e inclinazione casuali, 0 = spettrogramma com'è")
    a = ap.parse_args()
    run = RUNS / a.run
    run.mkdir(parents=True, exist_ok=True)
    (run / "args.json").write_text(json.dumps(vars(a), indent=1))
    torch.manual_seed(a.seed)
    device = torch.device(a.device)

    labels = json.loads((C.DATA / "labels.json").read_text())
    # per la variante "teacher" servono anche le battute di final0 dei brani a griglia
    for tid, lab in labels.items():
        if lab["kind"] == "grid":
            z = np.load(TEACHER / f"{tid}.npz")
            lab["t_beats"], lab["t_downbeats"] = z["beats"].astype(float), z["downbeats"].astype(float)
        lab["beats"], lab["downbeats"] = np.asarray(lab["beats"]), np.asarray(lab["downbeats"])
    train_ids = sorted(k for k, v in labels.items() if v["split"] == "train")
    val_ids = sorted(k for k, v in labels.items() if v["split"] == "val")
    if a.max_val:
        val_ids = val_ids[:a.max_val]
    print(f"addestramento: {len(train_ids)} brani, validazione: {len(val_ids)}", flush=True)

    if a.device == "mps":
        I.use_matmul_attention()
    hparams = load_checkpoint(a.init, "cpu")["hyper_parameters"]
    model = load_model(a.init, "cpu").to(device)
    model.train()
    freeze_bn(model)
    checkpoint_attention(model)
    contiguous_bn(model)
    decay = [p for p in model.parameters() if p.ndim >= 2]
    no_decay = [p for p in model.parameters() if p.ndim < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": 0.01}, {"params": no_decay, "weight_decay": 0}], lr=a.lr)

    def progress(step, elapsed):
        return elapsed / (60 * a.minutes) if a.minutes else step / a.steps

    def lr_at(step, elapsed):
        w = min(1.0, step / a.warmup)
        return a.lr * w * 0.5 * (1 + math.cos(math.pi * min(1.0, progress(step, elapsed))))

    beat_loss = ShiftTolerantBCELoss(pos_weight=hparams["pos_weights"]["beat"]).to(device)
    down_loss = ShiftTolerantBCELoss(pos_weight=hparams["pos_weights"]["downbeat"]).to(device)

    step, best, elapsed, next_val = 0, None, 0.0, 0.0
    state = run / "state.pt"
    if state.exists():
        st = torch.load(state, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model"])
        opt.load_state_dict(st["opt"])
        step, best = st["step"], st["best"]
        elapsed = st.get("elapsed", 0.0)
        print(f"riprendo dal passo {step}", flush=True)
    if step == 0 and not (run / "log.jsonl").exists():
        # punto di partenza: small0 così com'è
        v = validate(model, device, val_ids, labels)
        with (run / "log.jsonl").open("a") as lg:
            lg.write(json.dumps({"step": 0, **v}) + "\n")
        print("passo 0", json.dumps(v), flush=True)

    n_items = 10 ** 7 if a.minutes else (a.steps - step) * a.batch
    ds = Excerpts(train_ids, labels, a.labels == "grid", n=n_items, seed=(a.seed, step), p_tempo=a.p_tempo)
    next_val = elapsed + 60 * a.val_minutes
    dl = DataLoader(ds, batch_size=a.batch, num_workers=a.workers, persistent_workers=a.workers > 0,
                    prefetch_factor=4 if a.workers else None)
    t0, acc = time.time(), []
    t_step = time.time()
    for batch in dl:
        step += 1
        for g in opt.param_groups:
            g["lr"] = lr_at(step, elapsed)
        def train_step():
            x = batch["spect"].to(device)
            if a.gain:
                x = gain_tilt(x)
            out = model(x)
            m = batch["mask"].to(device)
            lb = beat_loss(out["beat"], batch["beat"].to(device), m)
            ld = down_loss(out["downbeat"], batch["downbeat"].to(device), m)
            loss = lb + ld
            if a.soft:
                ls = F.binary_cross_entropy_with_logits(out["beat"], torch.sigmoid(batch["t_beat"].to(device))) + \
                    F.binary_cross_entropy_with_logits(out["downbeat"], torch.sigmoid(batch["t_downbeat"].to(device)))
                loss = loss + a.soft * ls
            else:
                ls = torch.zeros(())
            (loss / a.accum).backward()
            return lb, ld, ls

        lb, ld, ls = I.retry_oom(train_step)
        if step % a.accum:
            continue
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        opt.zero_grad(set_to_none=True)
        acc.append([lb.item(), ld.item(), ls.item()])
        elapsed += time.time() - t_step
        t_step = time.time()
        if step % 100 == 0:
            mb = np.mean(acc, 0)
            print(f"passo {step}: beat {mb[0]:.4f} downbeat {mb[1]:.4f} soft {mb[2]:.4f} lr {lr_at(step, elapsed):.2e} "
                  f"({(time.time() - t0) / len(acc):.2f} s/passo)", flush=True)
            with (run / "log.jsonl").open("a") as lg:
                lg.write(json.dumps({"step": step, "loss_beat": mb[0], "loss_down": mb[1], "loss_soft": mb[2]}) + "\n")
            acc, t0 = [], time.time()
        done = progress(step, elapsed) >= 1
        if (elapsed >= next_val if a.minutes else step % a.val_every == 0) or done:
            next_val = elapsed + 60 * a.val_minutes
            v = validate(model, device, val_ids, labels)
            score = v["bpm_agree"] + v["phase_agree"] + v["F_beat_vs_final0"] + v["F_down_vs_final0"]
            save_ckpt(model, run / f"step-{step}.ckpt", hparams)
            if best is None or score > best[1]:
                best = (step, score)
                save_ckpt(model, run / "best.ckpt", hparams)
            with (run / "log.jsonl").open("a") as lg:
                lg.write(json.dumps({"step": step, **v, "score": score, "best_step": best[0]}) + "\n")
            print(f"val passo {step}", json.dumps(v), f"migliore: {best[0]}", flush=True)
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step, "best": best,
                        "elapsed": elapsed}, state)
            t0 = t_step = time.time()
        if done:
            break
    print("fatto", flush=True)


if __name__ == "__main__":
    main()
