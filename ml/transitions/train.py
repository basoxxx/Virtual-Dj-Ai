"""Addestramento del modello C: pre-addestramento su transizioni sintetiche, poi rifinitura per imitazione
delle transizioni reali (DJ Mix Dataset). Valutazione per mix tenuti da parte, contro il motore a regole.

Uso:
  ml/.venv/bin/python ml/transitions/train.py --pretrain        # pre-addestramento sintetico
  ml/.venv/bin/python ml/transitions/train.py --cv              # validazione incrociata (un mix alla volta)
  ml/.venv/bin/python ml/transitions/train.py --final           # modello finale su tutti i mix
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from build_dataset import N_IN  # noqa: E402
from model import TransitionPlanner, count_params, losses, mix_power  # noqa: E402
from synth import Synth  # noqa: E402

DATA = ML_DIR / "data" / "djmix"
RUNS = ML_DIR / "data" / "runs"
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def to_t(batch: dict) -> dict:
    return {k: torch.from_numpy(np.asarray(v)).to(DEVICE) for k, v in batch.items() if k in ("X", "Y", "P", "mask")}


def rules_curves(style: str, L: int) -> np.ndarray:
    """Motore a regole attuale (selector.js transitionState) su una finestra di L battute, nei 9 controlli."""
    ease = lambda t: 0.5 - 0.5 * np.cos(np.pi * np.clip(t, 0, 1))  # noqa: E731
    p = np.arange(L) / max(1, L - 1)
    y = np.zeros((L, 9), np.float32)
    if style == "bassswap":
        y[:, 0] = np.where(p < 0.5, ease(p / 0.5) * 0.5, 0.5 + ease((p - 0.5) / 0.5) * 0.5)
        y[:, 4] = np.where(p < 0.5, -1, 0)
        y[:, 1] = np.where(p < 0.5, 0, -1)
    else:  # dissolvenza
        y[:, 0] = ease(p)
    return y


def events(y: np.ndarray, x: np.ndarray) -> list[tuple[int, bool, bool]]:
    """Momenti chiave della transizione (crossfader a metà, bassi di A tagliati, bassi di B aperti) e se
    cadono (±1 battuta) su una battuta forte / su un inizio di frase di 8 battute del brano uscente."""
    out = []
    series = [(y[:, 0], 0.5, 1), (y[:, 1], -0.5, -1), (y[:, 4], -0.5, 1)]
    for s, thr, direction in series:
        cross = np.where(np.diff(np.sign((s - thr) * direction)) > 0)[0]
        if len(cross):
            j = int(cross[0]) + 1
            near = slice(max(0, j - 1), j + 2)
            on_bar = bool((x[near, 4] > 0.5).any())
            on_phrase = bool(((x[near, 4] > 0.5) & (np.abs(x[near, 8]) < 1e-3) & (x[near, 9] > 0.99)).any())
            out.append((j, on_bar, on_phrase))
    return out


def sound_proxies(C: np.ndarray, P: np.ndarray, M: np.ndarray) -> tuple[float, float]:
    """Indicatori d'ascolto oggettivi sulle battute valide:
    scontro dei bassi = entrambi i bassi pieni (ognuno almeno il 30% dei bassi totali e bassi totali oltre
    metà del livello dei brani); buco = volume totale più di 6 dB sotto il livello dei brani da soli."""
    ga = np.minimum(1, np.cos(C[..., 0] * np.pi / 2) * np.sqrt(2))
    gb = np.minimum(1, np.sin(C[..., 0] * np.pi / 2) * np.sqrt(2))
    ca = (ga[..., None] * 10 ** (1.5 * C[..., 1:4])) ** 2 * P[..., 0:3]
    cb = (gb[..., None] * 10 ** (1.5 * C[..., 4:7])) ** 2 * P[..., 3:6]
    clash, dip, n = 0, 0, 0
    for i in range(len(C)):
        m = M[i].astype(bool)
        low_ref = np.sqrt(np.median(P[i, m, 0]) * np.median(P[i, m, 3]) + 1e-20)
        tot_ref = np.sqrt(np.median(P[i, m, 0:3].sum(-1)) * np.median(P[i, m, 3:6].sum(-1)) + 1e-20)
        low = ca[i, m, 0] + cb[i, m, 0]
        both = (ca[i, m, 0] > 0.3 * low) & (cb[i, m, 0] > 0.3 * low) & (low > 0.5 * low_ref)
        tot = ca[i, m].sum(-1) + cb[i, m].sum(-1)
        clash += int(both.sum())
        dip += int((tot < tot_ref * 10 ** -0.6).sum())
        n += int(m.sum())
    return clash / max(1, n), dip / max(1, n)


def evaluate(model, data: dict, idx: np.ndarray) -> dict:
    X, Y, P, M = (data[k][idx] for k in ("X", "Y", "P", "mask"))
    with torch.no_grad():
        model.eval()
        pred = model(torch.from_numpy(X).to(DEVICE), torch.from_numpy(M).to(DEVICE)).cpu().numpy()
    res = {}
    cands = {"modello": pred}
    for style in ("bassswap", "fade"):
        R = np.zeros_like(Y)
        for i in range(len(idx)):
            L = int(M[i].sum())
            R[i, :L] = rules_curves(style, L)
        cands[f"regole_{style}"] = R
    Pt = torch.from_numpy(P)
    for name, C in cands.items():
        m = M[..., None]
        mae = (np.abs(C - Y) * m).sum((0, 1)) / m.sum()
        est = mix_power(torch.from_numpy(C), Pt[..., 0:3], Pt[..., 3:6]).numpy()
        ref = P[..., 6:9]
        eps = 1e-6 * ref.mean()
        db = np.abs(10 * np.log10(est + eps) - 10 * np.log10(ref + eps))
        ev = [e for i in range(len(idx)) for e in events(C[i, : int(M[i].sum())], X[i, : int(M[i].sum())])]
        clash, dip = sound_proxies(C, P, M)
        res[name] = {
            "scontroBassi": round(clash, 3),
            "buchiVolume": round(dip, 3),
            "maeCrossfader": round(float(mae[0]), 3),
            "maeEq": round(float(mae[1:7].mean()), 3),
            "mixErrDb": round(float((db * m).sum() / (m.sum() * 3)), 2),
            "eventiSuBattutaForte": round(float(np.mean([e[1] for e in ev])), 2) if ev else None,
            "eventiSuFrase": round(float(np.mean([e[2] for e in ev])), 2) if ev else None,
        }
    ev_real = [e for i in range(len(idx)) for e in events(Y[i, : int(M[i].sum())], X[i, : int(M[i].sum())])]
    clash, dip = sound_proxies(Y, P, M)
    res["reale"] = {"scontroBassi": round(clash, 3), "buchiVolume": round(dip, 3),
                    "eventiSuBattutaForte": round(float(np.mean([e[1] for e in ev_real])), 2) if ev_real else None,
                    "eventiSuFrase": round(float(np.mean([e[2] for e in ev_real])), 2) if ev_real else None}
    return res


def split_tracks(test_share: float = 0.2) -> tuple[list[Path], list[Path]]:
    """Brani per il sintetico divisi in modo deterministico (hash del nome) tra addestramento e test."""
    import zlib

    from synth import default_files

    files = default_files()
    test = [f for f in files if zlib.crc32(f.name.encode()) % 100 < test_share * 100]
    return [f for f in files if f not in test], test


def train(real: dict | None, train_idx: np.ndarray, steps: int, seed: int = 0, init: dict | None = None,
          lr: float = 3e-4, synth_share: int = 8, log=print, synth_files: list[Path] | None = None):
    """Senza dati reali (o con init=None e real=None): pre-addestramento sintetico. Con dati reali: rifinitura
    (batch di 24 reali + `synth_share` sintetiche, per non dimenticare), a partire dai pesi `init`."""
    torch.manual_seed(seed)
    synth = Synth(seed=seed, files=synth_files)
    model = TransitionPlanner(N_IN).to(DEVICE)
    if init is not None:
        model.load_state_dict(init)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.05)
    rng = np.random.default_rng(seed)
    t0 = time.time()
    for step in range(steps):
        model.train()
        if real is None or not len(train_idx):
            b = to_t(synth.batch(32))
        else:
            ids = rng.choice(train_idx, 24, replace=True)
            r = {k: real[k][ids] for k in ("X", "Y", "P", "mask")}
            sb = synth.batch(synth_share)
            b = to_t({k: np.concatenate([r[k], sb[k]]) for k in r})
        out = losses(model(b["X"], b["mask"]), b["Y"], b["P"], b["mask"])
        opt.zero_grad()
        out["total"].backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % 500 == 0 or step == steps - 1:
            log(f"passo {step:5d}  curve {out['curve'].item():.3f}  mixer {out['mixer'].item():.3f}  tv {out['tv'].item():.3f}  {time.time() - t0:.0f} s")
    return model


def load_real() -> dict:
    d = np.load(DATA / "transitions.npz")
    out = {k: d[k] for k in ("X", "Y", "P", "mask")}
    out["meta"] = json.loads(str(d["meta"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pretrain", action="store_true", help="pre-addestramento sintetico (salva pretrained.pt)")
    ap.add_argument("--cv", action="store_true", help="validazione incrociata: rifinitura tenendo da parte un mix alla volta")
    ap.add_argument("--final", action="store_true", help="rifinitura su tutti i mix (salva transition-planner.pt)")
    ap.add_argument("--synth-eval", action="store_true", help="pre-addestra sull'80%% dei brani e valuta sul 20%% mai visto")
    ap.add_argument("--compare", default="", help="con --synth-eval: valuta anche questo checkpoint sullo stesso test")
    ap.add_argument("--test-prefix", default="", help="con --synth-eval: solo i brani di test con questo prefisso (es. usb-)")
    ap.add_argument("--out", default="", help="nome del checkpoint salvato da --pretrain / del risultato di --synth-eval")
    ap.add_argument("--pre-steps", type=int, default=4000)
    ap.add_argument("--ft-steps", type=int, default=600)
    args = ap.parse_args()
    RUNS.mkdir(parents=True, exist_ok=True)
    pre_path = RUNS / (args.out or "pretrained.pt") if args.pretrain else RUNS / "pretrained.pt"
    if args.synth_eval:
        tr_files, te_files = split_tracks()
        te_files = [f for f in te_files if f.name.startswith(args.test_prefix)]
        model = train(None, np.array([], int), args.pre_steps, synth_files=tr_files)
        test = Synth(seed=123, files=te_files).batch(256)
        res = {"braniAddestramento": len(tr_files), "braniTest": len(te_files), **evaluate(model, test, np.arange(256))}
        if args.compare:
            base = TransitionPlanner(N_IN).to(DEVICE)
            base.load_state_dict(torch.load(args.compare, map_location=DEVICE))
            res["confronto"] = {"checkpoint": Path(args.compare).name, **evaluate(base, test, np.arange(256))["modello"]}
        print(json.dumps(res, ensure_ascii=False))
        (RUNS / (args.out or "synth-eval.json")).write_text(json.dumps(res, indent=1, ensure_ascii=False))
    if args.pretrain:
        model = train(None, np.array([], int), args.pre_steps)
        torch.save(model.state_dict(), pre_path)
        print(f"{count_params(model) / 1e6:.2f}M parametri, salvato {pre_path}")
    if not (args.cv or args.final):
        return
    init = torch.load(pre_path, map_location=DEVICE)
    real = load_real()
    mixes = np.array([m["mix"] for m in real["meta"]])
    print(f"{len(mixes)} transizioni reali da {len(set(mixes))} mix, dispositivo {DEVICE}")
    if args.cv:
        base = TransitionPlanner(N_IN).to(DEVICE)
        base.load_state_dict(init)
        results = {}
        for held in sorted(set(mixes)):
            tr, te = np.where(mixes != held)[0], np.where(mixes == held)[0]
            print(f"--- mix tenuto da parte: {held} ({len(te)} transizioni)")
            model = train(real, tr, args.ft_steps, init=init, lr=1e-4)
            results[held] = {"n": int(len(te)), "rifinito": evaluate(model, real, te),
                             "soloSintetico": evaluate(base, real, te)["modello"]}
            print(json.dumps(results[held], ensure_ascii=False))
        (RUNS / "cv.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    if args.final:
        model = train(real, np.arange(len(mixes)), args.ft_steps, init=init, lr=1e-4)
        torch.save(model.state_dict(), RUNS / "transition-planner.pt")
        print(f"{count_params(model) / 1e6:.2f}M parametri, salvato {RUNS / 'transition-planner.pt'}")


if __name__ == "__main__":
    main()
