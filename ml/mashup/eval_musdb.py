"""Separazione voce/base su MUSDB18 (50 tracce di test con le parti vere): htdemucs contro htdemucs_ft e impostazioni
d'inferenza, nelle condizioni dell'app (src/renderer/js/dsp/demucs.js = demucs.apply.apply_model con split=True,
blocchi di 7,8 s, sovrapposizione 0,25, pesi triangolari, shifts=0, normalizzazione con media e deviazione standard
del brano intero).

MUSDB18 (licenza solo ricerca non commerciale): su decisione dell'utente solo in locale e solo per misurare
(ml/data/musdb, scaricato con ml/mashup/musdb_download.py). Le 50 tracce di test non sono nell'addestramento dei
modelli Demucs ufficiali.

Riferimenti: voce = parte "vocals"; base = drums + bass + other ("accompaniment" di MUSDB). Ingresso = la traccia
"mixture" del file STEMS, come musdb e demucs.evaluate.

Metriche per traccia, per voce e base:
  nsdr  SDR "nuovo" della MDX Challenge (demucs.evaluate.new_sdr): 10·log10(Σref² / Σ(ref−stima)²) sul brano intero
  sdr   BSSEval v4 (museval, versione "immagini" con filtri fissi, blocchi di 1 s, mediana dei blocchi): in questa
        versione l'SDR di un blocco è proprio Σref² / Σ(ref−stima)² del blocco (s_true + e_spat + e_interf + e_artif
        = stima), con NaN nei blocchi dove voce o base (vera o stimata) è muta; qui si calcola direttamente
        (--check-museval lo confronta con museval.metrics.bss_eval su una traccia).

Configurazioni (modello, sovrapposizione, shifts):
  ht        htdemucs, 0,25, 0                         (l'app oggi)
  ft        htdemucs_ft, solo il sotto-modello voce, 0,25, 0
  ht_o50 / ft_o50   sovrapposizione 0,5 (1,5 volte i blocchi)
  ht_s2  / ft_s2    shifts=2: due passate spostate a caso di 0-0,5 s e mediate (2 volte il tempo)
  ftbag     htdemucs_ft completo (4 sotto-modelli, 4 volte il tempo): base = batteria, basso e altro dei loro
            specialisti
Varianti della base per ogni configurazione: somma delle altre tre uscite (come demucs.js), "mix − voce" e
"mix − voce + 3·media del brano" (|mix-voce+3m: quello che dà demucs.js senza modifiche con l'ONNX v2, perché
aggiunge la media del brano a ognuna delle tre sorgenti della base, come demucs.apply/separate).
Combinazioni senza calcoli in più: ht+ft (media di voce e base dei due modelli, 2 volte il tempo), ftvoce+htbase.

Uso:  ml/.venv/bin/python ml/mashup/eval_musdb.py --device mps --configs ht,ft [--limit N] [--every N] [--out file.jsonl]
      ml/.venv/bin/python ml/mashup/eval_musdb.py --summary ml/data/demucs/musdb-main.jsonl
      ml/.venv/bin/python ml/mashup/eval_musdb.py --check-museval
"""
from __future__ import annotations

import argparse
import json
import os
import random
import resource
import subprocess
import sys
import time
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402

MUSDB = ML_DIR / "data" / "musdb" / "test"
OUT_DIR = ML_DIR / "data" / "demucs"
SR = 44100
CONFIGS = {
    "ht": ("ht", 0.25, 0),
    "ft": ("ft3", 0.25, 0),
    "ht_o50": ("ht", 0.5, 0),
    "ft_o50": ("ft3", 0.5, 0),
    "ht_s2": ("ht", 0.25, 2),
    "ft_s2": ("ft3", 0.25, 2),
}
VOC = 3  # indice di "vocals" in drums, bass, other, vocals


def decode(path: Path, stream: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", f"0:{stream}", "-f", "f32le",
                          "-ac", "2", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()


def load_track(path: Path):
    """mix (2, n), voce vera (2, n), base vera (2, n) come float32."""
    mix = decode(path, 0)
    voc = decode(path, 4)
    acc = decode(path, 1)
    for k in (2, 3):
        s = decode(path, k)
        n = min(acc.shape[1], s.shape[1])
        acc = acc[:, :n] + s[:, :n]
    n = min(mix.shape[1], voc.shape[1], acc.shape[1])
    return mix[:, :n], voc[:, :n], acc[:, :n]


def nsdr(ref: np.ndarray, est: np.ndarray) -> float:
    r = ref.astype(np.float64)
    num = np.sum(r * r) + 1e-7
    den = np.sum((r - est.astype(np.float64)) ** 2) + 1e-7
    return float(10 * np.log10(num / den))


def frame_energies(x: np.ndarray, win: int = SR) -> np.ndarray:
    """Energia (somma su canali e campioni) dei blocchi di 1 s come museval.metrics.Framing (finestra = salto)."""
    nwin = (x.shape[-1] - win + win) // win
    x = x[:, : nwin * win].astype(np.float64)
    return (x * x).reshape(x.shape[0], nwin, win).sum(axis=(0, 2))


def silent_frames(x: np.ndarray, win: int = SR) -> np.ndarray:
    """Blocchi muti come museval._any_source_silent: somma sui canali nulla in tutti i campioni."""
    nwin = x.shape[-1] // win
    s = x[:, : nwin * win].astype(np.float64).sum(axis=0).reshape(nwin, win)
    return np.all(s == 0, axis=1)


def sdr_v4_frames(refs: list[np.ndarray], ests: list[np.ndarray]) -> list[np.ndarray]:
    """SDR di BSSEval v4 (immagini) per blocco di 1 s, per ogni coppia (ref, stima); NaN dove una delle ref o delle
    stime è muta (stessa regola di museval.metrics.bss_eval)."""
    silent = np.zeros(refs[0].shape[-1] // SR, bool)
    for x in refs + ests:
        silent |= silent_frames(x)
    out = []
    for r, e in zip(refs, ests):
        num = frame_energies(r)
        den = frame_energies(r.astype(np.float64) - e.astype(np.float64))
        with np.errstate(divide="ignore"):
            v = 10 * np.log10(num / den)
        v[silent] = np.nan
        out.append(v)
    return out


def metrics(mix, voc_ref, acc_ref, voc, base) -> dict:
    fv, fb = sdr_v4_frames([voc_ref, acc_ref], [voc, base])
    return {"voce": {"nsdr": round(nsdr(voc_ref, voc), 3), "sdr": round(float(np.nanmedian(fv)), 3)},
            "base": {"nsdr": round(nsdr(acc_ref, base), 3), "sdr": round(float(np.nanmedian(fb)), 3)}}


class Models:
    def __init__(self, device: str):
        self.device = device
        self.cache = {}

    def get(self, key: str):
        if key not in self.cache:
            if key == "ht":
                bag = get_model("htdemucs")
                m = bag.models[0]
            else:  # ft0..ft3: sotto-modelli di htdemucs_ft (ft3 = specialista della voce)
                if "ftbag" not in self.cache:
                    self.cache["ftbag"] = get_model("htdemucs_ft")
                bag = self.cache["ftbag"]
                k = int(key[2:])
                assert list(bag.weights[k]) == [1.0 if i == k else 0.0 for i in range(4)], bag.weights
                m = bag.models[k]
            m.eval()
            self.cache[key] = m
        return self.cache[key]

    def run(self, key: str, mixn: torch.Tensor, overlap: float, shifts: int) -> tuple[torch.Tensor, float]:
        model = self.get(key)
        if shifts:
            random.seed(1234)
        t0 = time.time()
        with torch.no_grad():
            out = apply_model(model, mixn[None], shifts=shifts, split=True, overlap=overlap, progress=False,
                              device=self.device)[0]
        if self.device == "mps":
            torch.mps.synchronize()
        return out, time.time() - t0


def evaluate_track(path: Path, models: Models, configs: list[str]) -> dict:
    mix, voc_ref, acc_ref = load_track(path)
    n = mix.shape[1]
    wav = torch.from_numpy(mix)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    mixn = (wav - mean) / std
    res = {"track": path.name.replace(".stem.mp4", ""), "seconds": round(n / SR, 2), "tempi": {}, "metriche": {}}
    keep = {}
    for cfg in configs:
        if cfg == "ftbag":
            continue
        key, overlap, shifts = CONFIGS[cfg]
        out, dt = models.run(key, mixn, overlap, shifts)
        out = out * std + mean
        res["tempi"][cfg] = round(dt, 2)
        voc = out[VOC].numpy()
        base = (out.sum(0) - out[VOC]).numpy()
        del out
        res["metriche"][cfg] = metrics(mix, voc_ref, acc_ref, voc, base)
        res["metriche"][cfg + "|mix-voce"] = metrics(mix, voc_ref, acc_ref, voc, mix - voc)
        # come la calcola demucs.js con l'ONNX v2 senza modifiche: ogni sorgente della base riceve + media del brano
        res["metriche"][cfg + "|mix-voce+3m"] = metrics(mix, voc_ref, acc_ref, voc, mix - voc + 3 * float(mean))
        if cfg in ("ht", "ft"):
            keep[cfg] = (voc, base)
    if "ht" in keep and "ft" in keep:
        (hv, hb), (fv, fb) = keep["ht"], keep["ft"]
        v = 0.5 * (hv + fv)
        res["metriche"]["ht+ft"] = metrics(mix, voc_ref, acc_ref, v, 0.5 * (hb + fb))
        res["metriche"]["ht+ft|mix-voce"] = metrics(mix, voc_ref, acc_ref, v, mix - v)
        res["metriche"]["ftvoce+htbase"] = metrics(mix, voc_ref, acc_ref, fv, hb)
    if "ftbag" in configs:
        base = np.zeros_like(mix)
        dt = 0.0
        for k in range(3):  # batteria, basso e altro dai loro specialisti
            out, t = models.run(f"ft{k}", mixn, 0.25, 0)
            base += (out[k] * std + mean).numpy()
            dt += t
            del out
        res["tempi"]["ftbag"] = round(dt + res["tempi"].get("ft", 0.0), 2)
        if "ft" in keep:
            res["metriche"]["ftbag"] = metrics(mix, voc_ref, acc_ref, keep["ft"][0], base)
        res["metriche"]["htvoce+ftbagbase"] = metrics(mix, voc_ref, acc_ref, keep["ht"][0], base) if "ht" in keep else None
    return res


def summary(paths: list[Path]) -> dict:
    rows = {}
    for p in paths:
        for line in p.read_text().splitlines():
            r = json.loads(line)
            rows[r["track"]] = {**rows.get(r["track"], {}), **r,
                                "metriche": {**rows.get(r["track"], {}).get("metriche", {}), **r["metriche"]},
                                "tempi": {**rows.get(r["track"], {}).get("tempi", {}), **r["tempi"]}}
    variants = sorted({v for r in rows.values() for v, m in r["metriche"].items() if m})
    out = {"tracce": len(rows), "secondiAudio": round(sum(r["seconds"] for r in rows.values()), 1), "varianti": {}}
    for v in variants:
        have = [r for r in rows.values() if r["metriche"].get(v)]
        d = {"tracce": len(have)}
        for part in ("voce", "base"):
            for met in ("nsdr", "sdr"):
                vals = np.array([r["metriche"][v][part][met] for r in have], dtype=np.float64)
                d[f"{part}_{met}_mediana"] = round(float(np.nanmedian(vals)), 3)
                d[f"{part}_{met}_media"] = round(float(np.nanmean(vals)), 3)
        out["varianti"][v] = d
    cfgs = sorted({c for r in rows.values() for c in r["tempi"]})
    out["tempi"] = {c: {"secondi": round(sum(r["tempi"][c] for r in rows.values() if c in r["tempi"]), 1),
                        "tempoReale": round(sum(r["tempi"][c] for r in rows.values() if c in r["tempi"])
                                            / sum(r["seconds"] for r in rows.values() if c in r["tempi"]), 4)}
                    for c in cfgs}
    return out


def paired(paths: list[Path], a: str, b: str) -> dict:
    """Differenza b − a per traccia (voce e base, nsdr): mediana, media e tracce migliorate."""
    rows = {}
    for p in paths:
        for line in p.read_text().splitlines():
            r = json.loads(line)
            rows.setdefault(r["track"], {}).update(r["metriche"])
    out = {}
    for part in ("voce", "base"):
        d = np.array([m[b][part]["nsdr"] - m[a][part]["nsdr"] for m in rows.values() if m.get(a) and m.get(b)])
        out[part] = {"mediana": round(float(np.median(d)), 3), "media": round(float(np.mean(d)), 3),
                     "migliori": int((d > 0).sum()), "tracce": len(d)}
    return out


def check_museval():
    """Il calcolo diretto dell'SDR v4 contro museval.metrics.bss_eval (pacchetto in ml/data/demucs/pylib)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("bsseval", ML_DIR / "data" / "demucs" / "pylib" / "museval" / "metrics.py")
    mm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mm)
    path = sorted(MUSDB.glob("*.stem.mp4"))[0]
    mix, voc_ref, acc_ref = load_track(path)
    sl = slice(SR * 20, SR * 50)  # 30 s: museval sul brano intero usa vari GB di RAM
    mix, voc_ref, acc_ref = mix[:, sl], voc_ref[:, sl], acc_ref[:, sl]
    rng = np.random.default_rng(0)
    voc = voc_ref + 0.2 * acc_ref + 0.01 * rng.standard_normal(voc_ref.shape).astype(np.float32)
    base = mix - voc
    refs = np.stack([voc_ref.T, acc_ref.T])
    ests = np.stack([voc.T, base.T])
    s = mm.bss_eval(refs, ests, compute_permutation=False, window=SR, hop=SR, framewise_filters=False,
                    bsseval_sources_version=False)[0]
    mine = sdr_v4_frames([voc_ref, acc_ref], [voc, base])
    print(json.dumps({"traccia": path.name, "museval": np.round(np.nanmedian(s, axis=1), 4).tolist(),
                      "diretto": [round(float(np.nanmedian(x)), 4) for x in mine],
                      "maxDiffBlocchi": float(np.nanmax(np.abs(s - np.stack(mine))))}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--configs", default="ht,ft")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--skip", type=int, default=0)
    ap.add_argument("--every", type=int, default=1, help="una traccia ogni N (sottoinsieme per le prove costose)")
    ap.add_argument("--out", default=str(OUT_DIR / "musdb-main.jsonl"))
    ap.add_argument("--summary", nargs="*")
    ap.add_argument("--paired", nargs=2)
    ap.add_argument("--check-museval", action="store_true")
    a = ap.parse_args()
    if a.check_museval:
        check_museval()
        return
    if a.summary is not None:
        paths = [Path(p) for p in a.summary] or [OUT_DIR / "musdb-main.jsonl"]
        s = summary(paths)
        if a.paired:
            s["confronto"] = {f"{a.paired[1]} − {a.paired[0]}": paired(paths, *a.paired)}
        print(json.dumps(s, indent=1, ensure_ascii=False))
        return
    torch.set_num_threads(a.threads)
    torch.backends.mha.set_fastpath_enabled(False)  # come l'export ONNX e il riferimento di bench_separate.mjs
    configs = a.configs.split(",")
    for c in configs:
        assert c in CONFIGS or c == "ftbag", c
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        done = {json.loads(line)["track"] for line in out.read_text().splitlines()}
    tracks = sorted(MUSDB.glob("*.stem.mp4"))
    assert len(tracks) == 50 or a.limit, f"{len(tracks)} tracce in {MUSDB}"
    tracks = tracks[a.skip::a.every]
    if a.limit:
        tracks = tracks[: a.limit]
    models = Models(a.device)
    t0 = time.time()
    for i, p in enumerate(tracks):
        name = p.name.replace(".stem.mp4", "")
        if name in done:
            continue
        r = evaluate_track(p, models, configs)
        with out.open("a") as f:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1048576
        m = r["metriche"]
        print(f"{i + 1}/{len(tracks)} {name} {r['seconds']:.0f} s | "
              + " ".join(f"{c} v{m[c]['voce']['nsdr']:.2f}/b{m[c]['base']['nsdr']:.2f}" for c in configs if c in m)
              + f" | tempi {r['tempi']} | picco {peak:.0f} MB | {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
