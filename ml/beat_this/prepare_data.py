"""Brani e spettrogrammi per rifinire Beat This! small0 (solo in locale, in ml/data/beat_this/).

  inventory  elenco dei brani con sorgente e suddivisione:
               cc       25 brani di Kevin MacLeod (BPM dell'autore)            -> test (mai addestramento)
               gand     62 brani originali dei set di Gand (warp marker)       -> test
               usb      chiavetta: brani con tag BPM affidabile                 -> tag (test)
                        gli altri, per titolo normalizzato (duplicati insieme): 10% test, 10% val, 80% train
               dj-a, dj-b, djmix (yt-*), djmix2 (file completi), jamendo    -> train (jamendo: 5% val)
  spect      log-mel come l'app (float32 per i brani di valutazione, float16 per l'addestramento);
             brani < 60 s o > 12 min esclusi; riprendibile, N processi
  dedupe     impronta a bit (16 bande, 5 frame/s) per togliere dall'addestramento i brani uguali a uno
             di valutazione (stesso master anche con intro diversa) -> dedupe.json

  jsaudio    audio mono a 22050 Hz dei brani CC per js_check.mjs (catena JavaScript dell'app)

Uso:  ml/.venv/bin/python ml/beat_this/prepare_data.py inventory|spect|dedupe|jsaudio [--workers 3]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zlib
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

import numpy as np  # noqa: E402

D = C.ML_DIR / "data"
MIN_S, MAX_S = 60, 720
EVAL_SPLITS = {"test", "val", "tag"}
SKIP_DIRS = ("Myloops Free Hardstyle Sample Pack", "Crossfader Sample Pack")


def bucket(key: str, n: int) -> int:
    return zlib.crc32(key.encode()) % n


def audio_files(root: Path):
    return sorted(p for p in root.rglob("*") if p.suffix.lower() in C.AUDIO_EXT and p.is_file()
                  and not p.name.startswith("._"))


def build_inventory() -> list[dict]:
    items = []
    # set CC: solo valutazione
    for m in json.loads((D / "audio" / "cc" / "manifest.json").read_text()):
        items.append({"id": C.track_id("cc", m["file"]), "source": "cc", "path": str(D / "audio" / "cc" / m["file"]),
                      "split": "test", "bpm": m["bpm"], "title": m["title"]})
    # Gand: solo valutazione
    for path, info in C.gand_clips().items():
        items.append({"id": C.track_id("gand", Path(path).name), "source": "gand", "path": path, "split": "test", **info})
    # chiavetta
    if C.USB_ROOT.exists():
        tagged = json.loads((D / "usb" / "tagged.json").read_text())
        tags = {Path(t["path"]).name: t for t in tagged if not (t["bpm"] == 90 and "(MP3_" in t["path"])}
        files = [p for p in audio_files(C.USB_ROOT) if not any(s in str(p) for s in SKIP_DIRS)]
        groups = defaultdict(list)
        for p in files:
            groups[C.norm_title(str(p))].append(p)
        seen = set()
        for g, ps in sorted(groups.items()):
            # un solo file per tag (lo stesso nome può stare in due cartelle)
            tag = [p for p in ps if p.name in tags and not (p.name in seen or seen.add(p.name))]
            for p in ps:
                rel = str(p.relative_to(C.USB_ROOT))
                it = {"id": C.track_id("usb", rel), "source": "usb", "path": str(p), "group": g, "folder": rel.split("/")[0]}
                if tag:
                    # brani con tag BPM: valutazione; i loro doppioni non entrano nell'addestramento
                    it["split"] = "tag" if p in tag else "skip"
                    if p in tag:
                        it["bpm"] = tags[p.name]["bpm"]
                        it["genre"] = tags[p.name].get("genre", "")
                else:
                    b = bucket(g, 10)
                    it["split"] = "test" if b == 0 else "val" if b == 1 else "train"
                items.append(it)
    else:
        print("chiavetta non collegata: niente brani usb")
    # altre sorgenti locali: addestramento
    for src, root, pat in (("dj-a", D / "dj-a" / "tracks", "*"), ("dj-b", D / "dj-b" / "tracks", "*"),
                           ("djmix", D / "djmix" / "audio", "yt-*"), ("djmix2", D / "djmix2" / "tracks", "*"),
                           ("jamendo", D / "jamendo", "*/*.mp3")):
        for p in sorted(root.glob(pat)):
            if p.suffix.lower() not in C.AUDIO_EXT or p.name.endswith(".part"):
                continue
            if time.time() - p.stat().st_mtime < 300:  # ancora in scaricamento
                continue
            rel = str(p.relative_to(root))
            split = "val" if src == "jamendo" and bucket(rel, 20) == 0 else "train"
            items.append({"id": C.track_id(src, rel), "source": src, "path": str(p), "split": split})
    return items


def inventory():
    old = {it["id"]: it for it in C.load_inventory()} if C.INVENTORY.exists() else {}
    items = build_inventory()
    new = {it["id"] for it in items}
    # brani già noti ma ora non raggiungibili (chiavetta staccata): restano se lo spettrogramma c'è
    for tid, it in old.items():
        if tid not in new and C.spect_path(tid).exists():
            items.append(it)
    C.DATA.mkdir(parents=True, exist_ok=True)
    C.INVENTORY.write_text(json.dumps(items, indent=0, ensure_ascii=False))
    count = defaultdict(int)
    for it in items:
        count[(it["source"], it["split"])] += 1
    for k, v in sorted(count.items()):
        print(f"{k[0]:8s} {k[1]:6s} {v}")


def one_spect(it: dict) -> tuple[str, str]:
    out = C.spect_path(it["id"])
    skip = out.with_suffix(".skip")
    if out.exists() or skip.exists():
        return it["id"], "c'è già"
    try:
        _, _, dur = C.probe(Path(it["path"]))
        if it["source"] not in ("cc", "gand") and not (MIN_S <= dur <= MAX_S):
            skip.write_text(f"{dur:.1f}")
            return it["id"], f"saltato ({dur:.0f} s)"
        mel = C.ref.log_mel(C.decode(Path(it["path"])))
        dtype = np.float32 if it["split"] in EVAL_SPLITS or it["source"] in ("cc", "gand") else np.float16
        tmp = out.with_suffix(".tmp.npy")
        np.save(tmp, mel.astype(dtype))
        tmp.rename(out)
        return it["id"], f"{len(mel) / C.FPS:.0f} s"
    except Exception as e:  # file rotto o non leggibile
        skip.write_text(f"errore: {e}")
        return it["id"], f"errore {e}"


def spect(workers: int):
    import torch
    torch.set_num_threads(1)
    C.SPECT.mkdir(parents=True, exist_ok=True)
    items = [it for it in C.load_inventory() if not C.spect_path(it["id"]).exists()
             and not C.spect_path(it["id"]).with_suffix(".skip").exists() and Path(it["path"]).exists()]
    # prima i brani di valutazione e quelli della chiavetta (può essere staccata)
    items.sort(key=lambda it: (it["split"] not in EVAL_SPLITS, it["source"] != "usb"))
    print(f"{len(items)} spettrogrammi da calcolare", flush=True)
    t0 = time.time()
    with ProcessPoolExecutor(workers, initializer=torch.set_num_threads, initargs=(1,)) as ex:
        for i, (tid, msg) in enumerate(ex.map(one_spect, items, chunksize=4)):
            if i % 50 == 0 or "errore" in msg:
                print(f"{i}/{len(items)} {tid} {msg} ({time.time() - t0:.0f} s)", flush=True)
    print("fatto", flush=True)


def fingerprint(tid: str) -> np.ndarray:
    """Impronta a bit (come Haitsma-Kalker): segno della variazione nel tempo della differenza tra bande vicine,
    16 bande mel, 5 frame/s -> (frame, 15) in ±1. Stesso audio: bit uguali per oltre l'80%; brani diversi: circa 50%."""
    s = np.asarray(C.load_spect(tid, mmap=True), dtype=np.float32)
    n = len(s) // 10
    e = s[: n * 10].reshape(n, 10, 16, 8).mean(axis=(1, 3))
    d = np.diff(np.diff(e, axis=0), axis=1)
    return np.where(d > 0, 1.0, -1.0).astype(np.float32)


def dedupe(max_frames=2048, min_overlap=150, threshold=0.5):
    items = [it for it in C.load_inventory() if C.spect_path(it["id"]).exists()]
    ev = [it for it in items if it["split"] in EVAL_SPLITS or it["source"] in ("cc", "gand")]
    tr = [it for it in items if it["split"] == "train"]
    fps = {it["id"]: fingerprint(it["id"])[:max_frames] for it in ev + tr}
    L = 2 * max_frames
    # correlazione lineare (zeri fino a L) di tutti i brani di addestramento con FFT
    tr_f = np.stack([np.fft.rfft(np.pad(fps[it["id"]], ((0, L - len(fps[it["id"]])), (0, 0))), axis=0)
                     for it in tr]).astype(np.complex64)  # (n, L/2+1, 15)
    tr_len = np.array([len(fps[it["id"]]) for it in tr])
    lags = np.arange(L)
    lags = np.where(lags < L // 2, lags, lags - L)  # spostamento del brano di addestramento rispetto a quello di valutazione
    dup = {}
    for it in ev:
        e = fps[it["id"]]
        ef = np.fft.rfft(np.pad(e, ((0, L - len(e)), (0, 0))), axis=0).astype(np.complex64)
        corr = np.fft.irfft(np.conj(ef)[None] * tr_f, n=L, axis=1).sum(-1)  # (n, L)
        # frame in comune per ogni spostamento: accordo medio dei bit sul tratto comune (1 = identici)
        overlap = np.minimum(len(e), tr_len[:, None] - lags[None]) - np.maximum(0, -lags[None])
        overlap = np.clip(overlap, 0, None)
        score = np.where(overlap >= min_overlap, corr / (15 * np.maximum(overlap, 1)), 0).max(1)
        for j in np.nonzero(score > threshold)[0]:
            dup.setdefault(tr[j]["id"], []).append({"eval": it["id"], "score": round(float(score[j]), 3),
                                                    "train_path": tr[j]["path"], "eval_path": it["path"]})
    (C.DATA / "dedupe.json").write_text(json.dumps(dup, indent=1, ensure_ascii=False))
    print(f"{len(dup)} brani di addestramento uguali a uno di valutazione")
    for k, v in sorted(dup.items(), key=lambda kv: -kv[1][0]["score"]):
        print(f"{v[0]['score']:.2f}  {Path(v[0]['train_path']).name[:50]:50s} = {Path(v[0]['eval_path']).name[:50]}")


def js_audio():
    """Audio mono a 22050 Hz (Float32 grezzo) dei 25 brani CC per la catena JavaScript dell'app (js_check.mjs)."""
    out_dir = C.DATA / "js"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for it in [x for x in C.load_inventory() if x["source"] == "cc"]:
        p = out_dir / f"{it['id']}.f32"
        if not p.exists():
            C.decode(Path(it["path"])).astype("<f4").tofile(p)
        out.append({"id": it["id"], "audio": str(p)})
    (out_dir / "cc.json").write_text(json.dumps(out))
    print(len(out), "brani in", out_dir)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["inventory", "spect", "dedupe", "jsaudio"])
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    if a.step == "inventory":
        inventory()
    elif a.step == "spect":
        spect(a.workers)
    elif a.step == "jsaudio":
        js_audio()
    else:
        dedupe()


if __name__ == "__main__":
    main()
