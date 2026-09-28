"""Scarica con yt-dlp l'audio dei mix del sottoinsieme e dei brani delle loro tracklist.

Solo uso locale (ml/data/djmix/audio, fuori da git): l'audio è protetto da copyright e serve solo
a estrarre caratteristiche. Riprendibile: i file già presenti non si riscaricano; ogni esito finisce
in ml/data/djmix/downloads.jsonl. Si procede mix per mix (mix, poi i suoi brani).

Uso:  ml/.venv/bin/python ml/transitions/download.py [--mix-workers 3] [--yt-workers 2] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yt_dlp

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "djmix"
AUDIO = DATA / "audio"
LOG = DATA / "downloads.jsonl"
_lock = threading.Lock()


def existing(stem: str) -> Path | None:
    for p in AUDIO.glob(f"{stem}.*"):
        if p.suffix not in (".part", ".ytdl") and not p.name.endswith(".part"):
            return p
    return None


def fetch(stem: str, url: str) -> dict:
    if existing(stem):
        return {"stem": stem, "ok": True, "cached": True}
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(AUDIO / f"{stem}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
        "js_runtimes": {"node": {}},
    }
    if stem.startswith("yt-"):
        # YouTube blocca con la verifica anti-bot se le richieste sono troppo fitte
        opts.update({"sleep_interval": 4, "max_sleep_interval": 10, "sleep_interval_requests": 1})
    t0 = time.time()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
        p = existing(stem)
        res = {"stem": stem, "ok": bool(p), "bytes": p.stat().st_size if p else 0, "s": round(time.time() - t0, 1)}
    except Exception as err:  # video rimosso, privato, bloccato…
        res = {"stem": stem, "ok": False, "error": str(err)[:300]}
    with _lock, LOG.open("a") as f:
        f.write(json.dumps(res) + "\n")
    return res


def run_pool(jobs, workers, label):
    ok = fail = blocked = 0
    with ThreadPoolExecutor(workers) as pool:
        for i, res in enumerate(pool.map(lambda j: fetch(*j), jobs), 1):
            if res["ok"]:
                ok += 1
                blocked = 0
            else:
                fail += 1
                blocked = blocked + 1 if "not a bot" in res.get("error", "") or "429" in res.get("error", "") else 0
                if blocked >= 25:
                    print(f"{label}: BLOCCATO, troppe verifiche anti-bot di fila", flush=True)
                    pool.shutdown(wait=False, cancel_futures=True)
                    break
            if i % 50 == 0:
                print(f"{label}: {i}/{len(jobs)} ok {ok} falliti {fail}", flush=True)
    print(f"{label}: FINE {ok} ok, {fail} falliti su {len(jobs)}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mix-workers", type=int, default=3)
    ap.add_argument("--yt-workers", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0, help="solo i primi N mix")
    args = ap.parse_args()
    AUDIO.mkdir(parents=True, exist_ok=True)
    mixes = json.loads((DATA / "subset.json").read_text())
    if args.limit:
        mixes = mixes[: args.limit]
    mix_jobs = [(m["id"], m["audio_url"]) for m in mixes]
    yt_jobs, seen = [], set()
    for m in mixes:
        for t in m["tracklist"]:
            if t.get("id") and t["id"] not in seen:
                seen.add(t["id"])
                yt_jobs.append((f"yt-{t['id']}", f"https://www.youtube.com/watch?v={t['id']}"))
    # mix (SoundCloud/Mixcloud) e brani (YouTube) in due code parallele, nell'ordine dei mix
    threads = [threading.Thread(target=run_pool, args=(mix_jobs, args.mix_workers, "mix")),
               threading.Thread(target=run_pool, args=(yt_jobs, args.yt_workers, "brani"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
