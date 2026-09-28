"""Riconoscimento dei brani di un mix senza tracklist (dalla v8, per i set di DJ Matrix): il mix si confronta per
battuta con una raccolta di brani già analizzati (chiavetta dell'utente, brani di Gabry Ponte e di LUM!X).

Per ogni brano si prendono 8 campioni da 32 battute (dal 10 all'80% del brano) e si cercano in tutto il mix con un
solo prodotto tra matrici (vettori per battuta come in align.similarity, senza trasposizione). Per ogni campione:
punteggio massimo, sua posizione e z robusto (mediana e MAD dei punteggi su tutto il mix). Un brano è riconosciuto se
il campione migliore supera Z_BEST e almeno un altro supera Z_AGREE sulla stessa diagonale (entro ±4 battute): stessa
parte del brano nello stesso punto del mix, una coincidenza molto improbabile per caso. Soglie tarate sul mix
Spotlight di Gabry Ponte (tracklist nota): 20 brani su 30 trovati e nessun falso su 453 brani che non ci sono
(83 di Gabry Ponte e 400 della chiavetta). Le copie dello stesso audio si tengono una volta sola.

Uscita: tracklist con i tempi stimati (ml/data/<dj>/tracklists.json, come quella di dj_sets_download.py) e
collegamenti alle caratteristiche dei brani in ml/data/<dj>/features, per dj_sets_dataset.py --no-features.

Uso:  ml/.venv/bin/python ml/transitions/identify_tracks.py --dj matrix
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

ML_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_DIR / "transitions"))
from align import _unit, _zunit  # noqa: E402

POOLS = [ML_DIR / "data" / "usb" / "features", ML_DIR / "data" / "gabry" / "features", ML_DIR / "data" / "lumix" / "features"]
PROBE = 32
FRACS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
Z_BEST = 5.0
Z_AGREE = 3.5
W = (np.sqrt(0.3), np.sqrt(0.5), np.sqrt(0.2))  # pesi di croma, schema ritmico e timbro come in align.similarity


def beat_vectors(f) -> np.ndarray:
    return np.concatenate([W[0] * _unit(f["chroma"]), W[1] * _zunit(f["mel4"]), W[2] * _zunit(f["mel"])], 1).astype(np.float32)


def names() -> dict:
    """id -> "artista - titolo" dove si sa (inventario della chiavetta, tracklist di Gabry Ponte e LUM!X)."""
    import zlib

    out = {}
    inv = ML_DIR / "data" / "usb" / "inventory.json"
    if inv.exists():
        for it in json.loads(inv.read_text()):
            out[f"usb-{zlib.crc32(it['path'].encode()):08x}"] = f"{it.get('artist') or ''} - {it.get('title') or Path(it['path']).stem}".strip(" -")
    for dj in ("gabry", "lumix"):
        p = ML_DIR / "data" / dj / "tracklists.json"
        if p.exists():
            for m in json.loads(p.read_text()).values():
                for t in m["tracks"]:
                    out[t["id"]] = f"{t['artist']} - {t['title']}"
    return out


def identify(mix_path: Path) -> list[dict]:
    fm = np.load(mix_path)
    mb = fm["beats"]
    vm = beat_vectors(fm)
    nm, D = vm.shape
    win = np.lib.stride_tricks.sliding_window_view(vm, (PROBE, D))[:, 0].reshape(nm - PROBE + 1, PROBE * D)
    files = [p for pool in POOLS if pool.exists() for p in sorted(pool.glob("*.npz")) if not p.stem.startswith("mix-")]
    probes, owners = [], []
    for fi, p in enumerate(files):
        ft = np.load(p)
        n = len(ft["beats"])
        if n < 2 * PROBE:
            continue
        vt = beat_vectors(ft)
        for fr in FRACS:
            k = int(fr * (n - PROBE))
            probes.append(vt[k:k + PROBE].reshape(-1))
            owners.append((fi, k, n))
    P = np.stack(probes)
    dets = {}
    for s in range(0, len(P), 2048):  # a blocchi per contenere la memoria
        sc = P[s:s + 2048] @ win.T / PROBE
        med = np.median(sc, 1, keepdims=True)
        mad = np.median(np.abs(sc - med), 1, keepdims=True) * 1.4826 + 1e-6
        j = sc.argmax(1)
        z = (sc[np.arange(len(sc)), j] - med[:, 0]) / mad[:, 0]
        for i in range(len(sc)):
            fi, k, n = owners[s + i]
            dets.setdefault(fi, []).append({"z": float(z[i]), "j": int(j[i]), "k": k, "n": n})
    found = []
    for fi, ps in dets.items():
        best = max(ps, key=lambda p: p["z"])
        if best["z"] < Z_BEST:
            continue
        d = best["j"] - best["k"]
        agree = [p for p in ps if abs((p["j"] - p["k"]) - d) <= 4 and p["z"] >= Z_AGREE]
        if len(agree) < 2:
            continue
        j0 = min(p["j"] for p in agree)
        found.append({"id": files[fi].stem, "file": str(files[fi]), "d": int(d), "z": round(best["z"], 1),
                      "probes": len(agree), "firstBeat": int(j0), "time": float(mb[min(j0, len(mb) - 1)])})
    # copie dello stesso audio: stessa diagonale nello stesso punto del mix -> si tiene la più forte
    found.sort(key=lambda f: -f["z"])
    kept = []
    for f in found:
        if any(abs(f["d"] - g["d"]) <= 8 and abs(f["firstBeat"] - g["firstBeat"]) <= 64 for g in kept):
            continue
        kept.append(f)
    return sorted(kept, key=lambda f: f["time"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dj", default="matrix")
    args = ap.parse_args()
    data = ML_DIR / "data" / args.dj
    feat = data / "features"
    nm = names()
    lists = {}
    for mix in sorted(feat.glob("mix-*.npz")):
        key = mix.stem[4:]
        found = identify(mix)
        print(f"== {key}: {len(found)} brani riconosciuti")
        tracks = []
        for pos, f in enumerate(found):
            title = nm.get(f["id"], f["id"])
            artist, _, t = title.partition(" - ")
            # cue: un po' prima del primo campione riconosciuto (il brano entra prima della sua parte centrale)
            cue = max(0.0, f["time"] - 30.0)
            tracks.append({"pos": pos + 1, "cue": round(cue, 1), "artist": artist or "?", "title": t or title,
                           "duration": None, "id": f["id"], "z": f["z"], "probes": f["probes"]})
            link = feat / f"{f['id']}.npz"
            if not link.exists():
                os.symlink(f["file"], link)
            print(f"  {f['time'] / 60:6.1f} min  z {f['z']:5.1f}  campioni {f['probes']}  {title[:70]}")
        lists[key] = {"title": f"{args.dj} {key} (brani riconosciuti)", "page": "", "source": "", "tracks": tracks}
    (data / "tracklists.json").write_text(json.dumps(lists, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
