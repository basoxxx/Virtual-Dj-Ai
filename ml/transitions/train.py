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
from synth import LONG_LENGTHS, SHORT_LENGTHS, Synth, default_files  # noqa: E402

DATA = ML_DIR / "data" / "djmix"
RUNS = ML_DIR / "data" / "runs"
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


def to_t(batch: dict) -> dict:
    """Tensori del lotto, tagliati all'ultima battuta valida: con la finestra da 256 molte finestre sono corte e
    l'attenzione costa col quadrato della lunghezza."""
    valid = np.asarray(batch["mask"]).any(0)
    T = int(np.nonzero(valid)[0][-1]) + 1 if valid.any() else 1
    cut = lambda k, v: np.asarray(v)[:, :T] if k != "MO" else np.asarray(v)  # noqa: E731
    return {k: torch.from_numpy(cut(k, v)).to(DEVICE) for k, v in batch.items() if k in ("X", "Y", "P", "mask", "W", "MO")}


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
          lr: float = 3e-4, synth_share: int = 8, log=print, synth_files: list[Path] | None = None,
          synth_kwargs: dict | None = None):
    """Senza dati reali (o con init=None e real=None): pre-addestramento sintetico. Con dati reali: rifinitura
    (batch di 24 reali + `synth_share` sintetiche, per non dimenticare), a partire dai pesi `init`."""
    torch.manual_seed(seed)
    synth = Synth(seed=seed, files=synth_files, **(synth_kwargs or {}))
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
            sb = synth.batch(32)
            b = to_t({**sb, "W": np.ones_like(sb["Y"]), "MO": np.ones(32, np.float32)})
        else:
            n_real = 32 - synth_share
            # probabilità di estrazione per fonte (es. metà Gand e metà Mixotic), se date
            p = real["p"][train_idx] / real["p"][train_idx].sum() if "p" in real else None
            ids = rng.choice(train_idx, n_real, replace=True, p=p)
            r = {k: real[k][ids] for k in ("X", "Y", "P", "mask")}
            # dati reali: pesi per controllo (es. solo crossfader) e mixer solo se le potenze del mix sono note
            r["W"] = real["W"][ids] if "W" in real else np.ones_like(r["Y"])
            r["MO"] = real["MO"][ids] if "MO" in real else np.full(n_real, 0.0 if "W" in real else 1.0, np.float32)
            sb = synth.batch(synth_share)
            sb = {**sb, "W": np.ones_like(sb["Y"]), "MO": np.ones(synth_share, np.float32)}
            b = to_t({k: np.concatenate([r[k], sb[k]]) for k in r})
        out = losses(model(b["X"], b["mask"]), b["Y"], b["P"], b["mask"], weights=b["W"], mixer_on=b["MO"])
        opt.zero_grad()
        out["total"].backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % 500 == 0 or step == steps - 1:
            log(f"passo {step:5d}  curve {out['curve'].item():.3f}  mixer {out['mixer'].item():.3f}  tv {out['tv'].item():.3f}  {time.time() - t0:.0f} s")
    return model


def xf_metrics(C: np.ndarray, data: dict, idx: np.ndarray) -> dict:
    """Crossfader previsto contro quello umano: errore medio, errore di tempo (battute) di inizio (0,1),
    metà (0,5) e fine (0,9) del movimento, attraversamento della metà su una battuta forte del brano uscente."""
    mae, t_err, on_bar = [], {0.1: [], 0.5: [], 0.9: []}, []
    for n, i in enumerate(idx):
        L = int(data["mask"][i].sum())
        y, c, x = data["Y"][i, :L, 0], C[n, :L, 0], data["X"][i, :L]
        mae.append(np.abs(c - y).mean())
        first = lambda v, th: int(np.argmax(v >= th)) if (v >= th).any() else L  # noqa: E731
        for th in t_err:
            t_err[th].append(abs(first(c, th) - first(y, th)))
        j = first(c, 0.5)
        on_bar.append(bool(j < L and (x[max(0, j - 1):j + 2, 4] > 0.5).any()))
    return {"maeCrossfader": round(float(np.mean(mae)), 3),
            "erroreInizioBattute": round(float(np.mean(t_err[0.1])), 1),
            "erroreMetaBattute": round(float(np.mean(t_err[0.5])), 1),
            "erroreFineBattute": round(float(np.mean(t_err[0.9])), 1),
            "metaSuBattutaForte": round(float(np.mean(on_bar)), 2)}


def eval_xf(models: dict, data: dict, idx: np.ndarray) -> dict:
    X, M = data["X"][idx], data["mask"][idx]
    out = {}
    for name, model in models.items():
        with torch.no_grad():
            model.eval()
            C = model(torch.from_numpy(X).to(DEVICE), torch.from_numpy(M).to(DEVICE)).cpu().numpy()
        out[name] = xf_metrics(C, data, idx)
    for style in ("bassswap", "fade"):
        C = np.zeros((len(idx), X.shape[1], 9), np.float32)
        for n in range(len(idx)):
            L = int(M[n].sum())
            C[n, :L] = rules_curves(style, L)
        out[f"regole_{style}"] = xf_metrics(C, data, idx)
    real = np.stack([data["Y"][i] for i in idx])
    out["umano"] = xf_metrics(real, data, idx)
    return out


def load_npz(path: Path) -> dict:
    d = np.load(path)
    out = {k: d[k] for k in ("X", "Y", "W", "P", "mask")}
    out["meta"] = json.loads(str(d["meta"]))
    return out


def load_gand(window: str = "") -> dict:
    """window: "" = finestre fino a 256 battute, "-128" = come fino alla v4."""
    return load_npz(ML_DIR / "data" / "werthen" / f"transitions{window}.npz")


def load_mixotic(window: str = "") -> dict:
    return load_npz(ML_DIR / "data" / "mixotic" / f"transitions{window}.npz")


def load_mixotic_new(window: str = "") -> dict | None:
    """Set Mixotic senza ricostruzione di Gand (mixotic_new_dataset.py), se ci sono."""
    path = ML_DIR / "data" / "mixotic" / f"transitions-nuovi{window}.npz"
    return load_npz(path) if path.exists() else None


def combine(parts: list[tuple[str, dict, float, float]]) -> dict:
    """parts: (fonte, dati, quota delle estrazioni reali, mixer noto 0/1) -> un solo insieme con probabilità p."""
    parts = [p for p in parts if p[1] is not None and len(p[1]["X"])]
    tot = sum(p[2] for p in parts)
    out = {k: np.concatenate([p[1][k] for p in parts]) for k in ("X", "Y", "W", "P", "mask")}
    out["MO"] = np.concatenate([np.full(len(p[1]["X"]), p[3], np.float32) for p in parts])
    out["p"] = np.concatenate([np.full(len(p[1]["X"]), p[2] / tot / len(p[1]["X"])) for p in parts])
    out["meta"] = [{**x, "fonte": p[0]} for p in parts for x in p[1]["meta"]]
    return out


def gand_plus_mixotic(share: float = 0.5, window: str = "-128") -> dict:
    """Gand (solo crossfader, niente mixer) + Mixotic (crossfader + EQ + mixer); `share` delle estrazioni reali
    dai mix veri di Mixotic. Finestre da 128 battute, come per la v4."""
    g, m = load_gand(window), load_mixotic(window)
    out = {k: np.concatenate([g[k], m[k]]) for k in ("X", "Y", "W", "P", "mask")}
    out["MO"] = np.concatenate([np.zeros(len(g["X"]), np.float32), np.ones(len(m["X"]), np.float32)])
    out["p"] = np.concatenate([np.full(len(g["X"]), (1 - share) / len(g["X"])), np.full(len(m["X"]), share / len(m["X"]))])
    out["meta"] = [{**x, "fonte": "gand"} for x in g["meta"]] + [{**x, "fonte": "mixotic"} for x in m["meta"]]
    return out


def load_real() -> dict:
    d = np.load(DATA / "transitions.npz")
    out = {k: d[k] for k in ("X", "Y", "P", "mask")}
    out["meta"] = json.loads(str(d["meta"]))
    return out


V5_SHARES = {"gand": 1.0, "mixotic": 1.0, "mixotic-nuovi": 1.0}


def v5_data(window: str = "") -> dict:
    """Gand (solo crossfader) + Mixotic dei 4 set di Gand + set Mixotic nuovi, un terzo delle estrazioni ciascuno."""
    return combine([("gand", load_gand(window), V5_SHARES["gand"], 0.0),
                    ("mixotic", load_mixotic(window), V5_SHARES["mixotic"], 1.0),
                    ("mixotic-nuovi", load_mixotic_new(window), V5_SHARES["mixotic-nuovi"], 1.0)])


def folds_of(sets: list[str]) -> list[list[str]]:
    """Gruppi per la validazione incrociata: un set "vecchio" (con Gand) e uno nuovo per gruppo."""
    old = sorted(s for s in sets if s in ("set044", "set123", "set281", "set286"))
    new = sorted(s for s in sets if s not in old and s != "setncs")
    n = max(len(old), 1)
    groups = [[o] for o in old] or [[]]
    for i, s in enumerate(new):
        groups[i % n].append(s)
    groups[-1] += [s for s in sets if s == "setncs"]
    return groups


def evaluate_split(models: dict, data: dict, idx: np.ndarray) -> dict:
    """Metriche d'imitazione (evaluate) dei modelli e delle regole sulle finestre idx; None se vuote."""
    if not len(idx):
        return None
    r = {"n": int(len(idx))}
    for nm, mdl in models.items():
        ev = evaluate(mdl, data, idx)
        r[nm] = ev["modello"]
    r["regole_bassswap"], r["regole_fade"], r["reale"] = ev["regole_bassswap"], ev["regole_fade"], ev["reale"]
    r["tempi"] = eval_xf(models, data, idx)
    return r


def average(results: list[dict]) -> dict | None:
    """Media pesata sul numero di finestre di dizionari annidati di metriche."""
    results = [r for r in results if r]
    if not results:
        return None
    tot = sum(r["n"] for r in results)

    def rec(vals):
        if isinstance(vals[0][0], dict):
            return {k: rec([(v[k], n) for v, n in vals if k in v]) for k in vals[0][0]}
        num = [(v, n) for v, n in vals if v is not None]
        return round(sum(v * n for v, n in num) / max(1, sum(n for _, n in num)), 3) if num else None
    return {"n": tot, **{k: rec([(r[k], r["n"]) for r in results]) for k in results[0] if k != "n"}}


def run_v5(args) -> None:
    from gand_dataset import human_templates

    v4_state = torch.load(RUNS / "planner-v4.pt", map_location=DEVICE)
    data = v5_data()
    short = v5_data("-128")
    sets = np.array([m["set"] for m in data["meta"]])
    src = np.array([m["fonte"] for m in data["meta"]])
    kind = np.array([m.get("kind", "") for m in data["meta"]])
    raw = np.array([m.get("rawLength", m.get("length", 0)) for m in data["meta"]])
    s_sets = np.array([m["set"] for m in short["meta"]])
    s_src = np.array([m["fonte"] for m in short["meta"]])
    s_kind = np.array([m.get("kind", "") for m in short["meta"]])
    wide_g = lambda d: np.array([(m.get("pre"), m.get("post")) == (16, 8) for m in d["meta"]])  # noqa: E731
    print(f"v5: {len(sets)} finestre ({', '.join(f'{f} {int((src == f).sum())}' for f in sorted(set(src)))}), dispositivo {DEVICE}", flush=True)

    def v5_model(train_sets, idx, seed=0):
        # brani del generatore: niente brani dei set tenuti da parte (i nomi contengono il set)
        held = set(sets) - set(train_sets)
        files = [f for f in default_files() if not any(f"-{h}-" in f.name for h in held)]
        kw = {"templates": human_templates([s for s in train_sets if s.startswith("set")]), "lengths": LONG_LENGTHS}
        return train(data, idx, args.v5_steps, init=v4_state, lr=1e-4, synth_share=12, synth_kwargs=kw, seed=seed,
                     synth_files=files)

    def v4_recipe(train_sets):
        """La v4 rifatta senza il gruppo tenuto da parte: v3 + dati della v4 (finestre da 128, 4 set)."""
        v3_state = torch.load(RUNS / "planner-v3.pt", map_location=DEVICE)
        d4 = gand_plus_mixotic()
        s4 = np.array([m["set"] for m in d4["meta"]])
        kw = {"templates": human_templates([s for s in train_sets if s.startswith("set")]), "lengths": SHORT_LENGTHS}
        return train(d4, np.where(np.isin(s4, train_sets))[0], args.v4_steps, init=v3_state, lr=1e-4, synth_share=12, synth_kwargs=kw)

    if args.v5_cv:
        v4 = TransitionPlanner(N_IN).to(DEVICE)
        v4.load_state_dict(v4_state)
        groups = folds_of(sorted(set(sets)))
        chosen = [int(i) for i in args.v5_folds.split(",")] if args.v5_folds else range(len(groups))
        out_path = RUNS / "v5-cv.json"
        results = json.loads(out_path.read_text())["perGruppo"] if out_path.exists() and args.v5_folds else {}
        for gi in chosen:
            held = groups[gi]
            train_sets = sorted(set(sets) - set(held))
            print(f"--- gruppo {gi}: tenuti da parte {held}", flush=True)
            t0 = time.time()
            models = {"v5": v5_model(train_sets, np.where(~np.isin(sets, held))[0]), "v4": v4}
            if args.v4_baseline:
                models["v4_rifatta"] = v4_recipe(train_sets)
            mix = (np.isin(sets, held)) & (src != "gand") & np.isin(kind, ["inizio-0", "fine"])
            s_mix = (np.isin(s_sets, held)) & (s_src != "gand") & np.isin(s_kind, ["inizio-0", "fine"])
            r = {
                "tenuti": held,
                # transizioni intere fino a 256 battute: corte (<= 128) e lunghe (> 128)
                "corte": evaluate_split(models, data, np.where(mix & (kind == "inizio-0") & (raw <= 128))[0]),
                "lunghe": evaluate_split(models, data, np.where(mix & (kind == "inizio-0") & (raw > 128))[0]),
                # le stesse finestre della valutazione della v4 (al massimo 128 battute, inizio e fine)
                "finestre128": evaluate_split(models, short, np.where(s_mix)[0]),
                "gandLarga": None,
                "minuti": None,
            }
            gw = np.where(np.isin(s_sets, held) & (s_src == "gand") & wide_g(short))[0]
            if len(gw):
                r["gandLarga"] = {"n": int(len(gw)), **eval_xf(models, short, gw)}
            gl = np.where(np.isin(sets, held) & (src == "gand") & wide_g(data))[0]
            if len(gl):
                r["gandLargaFino256"] = {"n": int(len(gl)), **eval_xf(models, data, gl)}
            r["minuti"] = round((time.time() - t0) / 60, 1)
            results[str(gi)] = r
            print(json.dumps(r, ensure_ascii=False), flush=True)
            summary = {k: average([x.get(k) for x in results.values()])
                       for k in ("corte", "lunghe", "finestre128", "gandLarga", "gandLargaFino256")}
            out_path.write_text(json.dumps({"passi": args.v5_steps, "gruppi": groups, "perGruppo": results, "media": summary},
                                           indent=1, ensure_ascii=False))
        print("MEDIA", json.dumps(summary, ensure_ascii=False), flush=True)
    if args.v5_final:
        m5 = v5_model(sorted(set(sets)), np.arange(len(sets)))
        torch.save(m5.state_dict(), RUNS / "planner-v5.pt")
        print(f"salvato {RUNS / 'planner-v5.pt'}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pretrain", action="store_true", help="pre-addestramento sintetico (salva pretrained.pt)")
    ap.add_argument("--cv", action="store_true", help="validazione incrociata: rifinitura tenendo da parte un mix alla volta")
    ap.add_argument("--final", action="store_true", help="rifinitura su tutti i mix (salva transition-planner.pt)")
    ap.add_argument("--synth-eval", action="store_true", help="pre-addestra sull'80%% dei brani e valuta sul 20%% mai visto")
    ap.add_argument("--compare", default="", help="con --synth-eval: valuta anche questo checkpoint sullo stesso test")
    ap.add_argument("--test-prefix", default="", help="con --synth-eval: solo i brani di test con questo prefisso (es. usb-)")
    ap.add_argument("--out", default="", help="nome del checkpoint salvato da --pretrain / del risultato di --synth-eval")
    ap.add_argument("--gand-cv", action="store_true", help="rifinitura sul crossfader dei mix di Gand, un set tenuto da parte alla volta")
    ap.add_argument("--gand-final", action="store_true", help="rifinitura su tutti i set di Gand (salva planner-v2.pt)")
    ap.add_argument("--init", default="planner-v1.pt", help="checkpoint di partenza per la rifinitura")
    ap.add_argument("--ft-lr", type=float, default=1e-4)
    ap.add_argument("--synth-share", type=int, default=16, help="transizioni sintetiche per lotto di 32 nella rifinitura")
    ap.add_argument("--v3-cv", action="store_true", help="v3: sintetico con brani da DJ, outro e forme umane + finestre variabili")
    ap.add_argument("--v3-final", action="store_true", help="v3 su tutti i set (salva planner-v3.pt)")
    ap.add_argument("--v3-steps", type=int, default=1500, help="passi sul nuovo sintetico prima della rifinitura")
    ap.add_argument("--v4-cv", action="store_true", help="v4: v3 rifinita anche sui mix veri di Mixotic (crossfader + EQ), un set tenuto da parte alla volta")
    ap.add_argument("--v4-final", action="store_true", help="v4 su tutti i set (salva planner-v4.pt)")
    ap.add_argument("--v4-steps", type=int, default=800)
    ap.add_argument("--v5-cv", action="store_true", help="v5: v4 con finestra da 256 battute, set Mixotic nuovi e generatore con più generi; un gruppo di set tenuto da parte alla volta")
    ap.add_argument("--v5-final", action="store_true", help="v5 su tutti i set (salva planner-v5.pt)")
    ap.add_argument("--v5-steps", type=int, default=800)
    ap.add_argument("--v5-folds", default="", help="solo questi gruppi della validazione incrociata (indici separati da virgola)")
    ap.add_argument("--v4-baseline", action="store_true", help="con --v5-cv: rifà anche la v4 per ogni gruppo (stessa ricetta, dati della v4)")
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
    if args.gand_cv or args.gand_final:
        init = torch.load(RUNS / args.init, map_location=DEVICE)
        gand = load_gand()
        sets = np.array([m["set"] for m in gand["meta"]])
        v1 = TransitionPlanner(N_IN).to(DEVICE)
        v1.load_state_dict(init)
        if args.gand_cv:
            results = {}
            for held in sorted(set(sets)):
                tr, te = np.where(sets != held)[0], np.where(sets == held)[0]
                print(f"--- set tenuto da parte: {held} ({len(te)} transizioni)")
                model = train(gand, tr, args.ft_steps, init=init, lr=args.ft_lr, synth_share=args.synth_share)
                results[held] = {"n": int(len(te)), **eval_xf({"rifinito": model, "v1": v1}, gand, te)}
                print(json.dumps(results[held], ensure_ascii=False))
            # media pesata sul numero di transizioni
            tot = sum(r["n"] for r in results.values())
            names = [k for k in next(iter(results.values())) if k != "n"]
            summary = {nm: {m: round(sum(r[nm][m] * r["n"] for r in results.values()) / tot, 3) for m in results[held][nm]} for nm in names}
            print("MEDIA", json.dumps(summary, ensure_ascii=False))
            cfg = {"passi": args.ft_steps, "lr": args.ft_lr, "sinteticiPerLotto": args.synth_share}
            (RUNS / (args.out or "gand-cv.json")).write_text(json.dumps({"config": cfg, "perSet": results, "media": summary}, indent=1, ensure_ascii=False))
        if args.gand_final:
            model = train(gand, np.arange(len(sets)), args.ft_steps, init=init, lr=args.ft_lr, synth_share=args.synth_share)
            torch.save(model.state_dict(), RUNS / "planner-v2.pt")
            print(f"salvato {RUNS / 'planner-v2.pt'}")
    if args.v3_cv or args.v3_final:
        from gand_dataset import WINDOWS, human_templates

        v1_state = torch.load(RUNS / "planner-v1.pt", map_location=DEVICE)
        gand = load_gand()
        sets = np.array([m["set"] for m in gand["meta"]])
        win = [(m["pre"], m["post"]) for m in gand["meta"]]
        narrow = np.array([w == WINDOWS[0] for w in win])
        wide = np.array([w == (16, 8) for w in win])

        def v3_model(train_sets, idx):
            kw = {"templates": human_templates(list(train_sets))}
            stage1 = train(None, np.array([], int), args.v3_steps, init=v1_state, lr=2e-4, synth_kwargs=kw)
            return train(gand, idx, args.ft_steps, init=stage1.state_dict(), lr=1e-4, synth_share=16, synth_kwargs=kw)

        if args.v3_cv:
            v1 = TransitionPlanner(N_IN).to(DEVICE)
            v1.load_state_dict(v1_state)
            results = {}
            for held in sorted(set(sets)):
                train_sets = sorted(set(sets) - {held})
                tr_all = np.where(sets != held)[0]
                print(f"--- set tenuto da parte: {held}")
                m3 = v3_model(train_sets, tr_all)
                # v2 ricalcolata per questo fold: solo rifinitura della v1 sulle finestre strette
                m2 = train(gand, np.where((sets != held) & narrow)[0], args.ft_steps, init=v1_state, lr=1e-4, synth_share=16,
                           synth_kwargs={"weights": "uniform", "templates": None, "use_outro": False})
                models = {"v3": m3, "v2": m2, "v1": v1}
                results[held] = {"n": int(((sets == held) & narrow).sum()),
                                 "stretta": eval_xf(models, gand, np.where((sets == held) & narrow)[0]),
                                 "larga": eval_xf(models, gand, np.where((sets == held) & wide)[0])}
                print(json.dumps(results[held], ensure_ascii=False))
            tot = sum(r["n"] for r in results.values())
            summary = {}
            for w in ("stretta", "larga"):
                summary[w] = {}
                for nm in next(iter(results.values()))[w]:
                    summary[w][nm] = {m: round(sum(r[w][nm][m] * r["n"] for r in results.values()) / tot, 3)
                                      for m in next(iter(results.values()))[w][nm]}
            print("MEDIA", json.dumps(summary, ensure_ascii=False))
            (RUNS / "v3-cv.json").write_text(json.dumps({"perSet": results, "media": summary}, indent=1, ensure_ascii=False))
        if args.v3_final:
            m3 = v3_model(sorted(set(sets)), np.arange(len(sets)))
            torch.save(m3.state_dict(), RUNS / "planner-v3.pt")
            print(f"salvato {RUNS / 'planner-v3.pt'}")
    if args.v4_cv or args.v4_final:
        from gand_dataset import human_templates

        v3_state = torch.load(RUNS / "planner-v3.pt", map_location=DEVICE)
        data = gand_plus_mixotic()
        sets = np.array([m["set"] for m in data["meta"]])
        src = np.array([m["fonte"] for m in data["meta"]])
        kind = np.array([m.get("kind", "") for m in data["meta"]])

        def v4_model(train_sets, idx):
            kw = {"templates": human_templates(list(train_sets))}
            return train(data, idx, args.v4_steps, init=v3_state, lr=1e-4, synth_share=12, synth_kwargs=kw)

        if args.v4_cv:
            v3 = TransitionPlanner(N_IN).to(DEVICE)
            v3.load_state_dict(v3_state)
            results = {}
            for held in sorted(set(sets[src == "mixotic"])):
                train_sets = sorted(set(sets) - {held})
                print(f"--- set tenuto da parte: {held}", flush=True)
                m4 = v4_model(train_sets, np.where(sets != held)[0])
                models = {"v4": m4, "v3": v3}
                te = np.where((sets == held) & (src == "mixotic") & np.isin(kind, ["inizio-0", "fine"]))[0]
                r = {"n": int(len(te)), "crossfader": eval_xf(models, data, te)}
                for nm, mdl in models.items():
                    ev = evaluate(mdl, data, te)
                    r[nm] = ev["modello"]
                r["regole_bassswap"], r["regole_fade"], r["reale"] = ev["regole_bassswap"], ev["regole_fade"], ev["reale"]
                gw = np.where((sets == held) & (src == "gand") & np.array([(m.get("pre"), m.get("post")) == (16, 8) for m in data["meta"]]))[0]
                if len(gw):
                    r["gandLarga"] = {"n": int(len(gw)), **eval_xf(models, data, gw)}
                results[held] = r
                print(json.dumps(r, ensure_ascii=False), flush=True)
            tot = sum(r["n"] for r in results.values())
            avg = lambda get: round(sum(get(r) * r["n"] for r in results.values()) / tot, 3)  # noqa: E731
            summary = {}
            for nm in ("v4", "v3", "regole_bassswap", "regole_fade", "reale"):
                summary[nm] = {m: avg(lambda r, nm=nm, m=m: r[nm][m] or 0) for m in results[held][nm]}
            summary["crossfader"] = {nm: {m: avg(lambda r, nm=nm, m=m: r["crossfader"][nm][m]) for m in results[held]["crossfader"][nm]}
                                     for nm in results[held]["crossfader"]}
            print("MEDIA", json.dumps(summary, ensure_ascii=False), flush=True)
            (RUNS / "v4-cv.json").write_text(json.dumps({"passi": args.v4_steps, "perSet": results, "media": summary}, indent=1, ensure_ascii=False))
        if args.v4_final:
            m4 = v4_model(sorted(set(sets)), np.arange(len(sets)))
            torch.save(m4.state_dict(), RUNS / "planner-v4.pt")
            print(f"salvato {RUNS / 'planner-v4.pt'}", flush=True)

    if args.v5_cv or args.v5_final:
        run_v5(args)
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
