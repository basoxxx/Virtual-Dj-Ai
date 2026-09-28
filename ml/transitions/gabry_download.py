"""Mix di Gabry Ponte e brani originali che suona (dalla v7): solo in locale in ml/data/gabry, fuori da git.
Audio con copyright: si usa solo per calcolare le caratteristiche per battuta (uso deciso dall'utente il 28/09/2026).

- Tracklist (ml/data/gabry/tracklists.txt): da 1001tracklists, con l'inizio di ogni brano nel mix quando c'è
  ("cue") e la durata della versione indicata.
- Mix: SoundCloud (canali di Tomorrowland, 1001Tracklists, EDM Identity, DJ Mag Brasil).
- Brani: YouTube con yt-dlp, scegliendo tra i primi risultati quello con la durata più vicina a quella della
  tracklist (entro 25 s) e il titolo più simile, senza versioni live, rallentate, karaoke o remix non richiesti.

Uso:  ml/.venv/bin/python ml/transitions/gabry_download.py [--mixes] [--tracks] [--limit N]
      -> ml/data/gabry/tracklists.json, mixes/<mix>.<ext>, tracks/<id>.<ext>, downloads.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
import zlib
from pathlib import Path

import yt_dlp

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data" / "gabry"
MIXES = DATA / "mixes"
TRACKS = DATA / "tracks"
LOG = DATA / "downloads.jsonl"

MIX_SOURCES = {
    "spotlight": "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A2359796117",
    "edmidentity": "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A2353671188",
    "tomorrowland": "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A2273625716",
    "sputnik": "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A2107286145",
}
BAD = ("live", "slowed", "sped up", "nightcore", "karaoke", "reverb", "8d", "instrumental", "acapella", "lyrics",
       "1 hour", "loop", "cover", "tutorial", "reaction", "mashup")


def track_id(artist: str, title: str) -> str:
    return f"gp-{zlib.crc32(f'{artist} - {title}'.lower().encode()):08x}"


def parse(path: Path) -> dict:
    """tracklists.txt -> {mix: {title, page, tracks: [{pos, cue, artist, title, duration, id}]}}."""
    out, cur = {}, None
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("@"):
            key, title, page = (p.strip() for p in line[1:].split("|"))
            cur = out[key] = {"title": title, "page": page, "tracks": []}
            continue
        cue, name, dur = line.split("|")
        artist, title = name.split(" - ", 1)
        sec = None
        if cue.strip():
            p = [int(x) for x in cue.split(":")]
            sec = p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else p[0] * 60 + p[1]
        d = None
        if dur.strip():
            m, s = dur.split(":")
            d = int(m) * 60 + int(s)
        cur["tracks"].append({"pos": len(cur["tracks"]) + 1, "cue": sec, "artist": artist.strip(), "title": title.strip(),
                              "duration": d, "id": track_id(artist.strip(), title.strip())})
    return out


def words(s: str) -> set[str]:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return {w for w in re.findall(r"[a-z0-9]+", s) if w not in {"ft", "feat", "the", "and", "x", "vs", "official", "audio",
                                                               "video", "music", "remix", "mix", "edit", "radio"}}


def score(entry: dict, t: dict) -> float | None:
    """Punteggio di un risultato di ricerca per il brano t (None = da scartare)."""
    title = (entry.get("title") or "").lower()
    dur = entry.get("duration") or 0
    wanted = f"{t['artist']} {t['title']}".lower()
    if any(b in title and b not in wanted for b in BAD) or not (90 <= dur <= 600):
        return None
    if "remix" in title and "remix" not in wanted:
        return None
    if t["duration"] and abs(dur - t["duration"]) > 25:
        return None
    w_t, w_e = words(t["title"]), words(title + " " + (entry.get("channel") or entry.get("uploader") or ""))
    overlap = len(w_t & w_e) / max(1, len(w_t))
    if overlap < 0.5:
        return None
    s = overlap + 0.5 * len(words(t["artist"]) & w_e) / max(1, len(words(t["artist"])))
    if (entry.get("channel") or "").endswith("- Topic"):
        s += 0.5  # audio ufficiale caricato dall'etichetta
    if t["duration"]:
        s -= abs(dur - t["duration"]) / 50
    return s


def download(url: str, dest_stem: Path) -> Path | None:
    opts = {"format": "bestaudio/best", "outtmpl": str(dest_stem) + ".%(ext)s", "quiet": True, "no_warnings": True,
            "noplaylist": True, "noprogress": True, "sleep_interval": 4, "max_sleep_interval": 10, "sleep_interval_requests": 1}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = list(dest_stem.parent.glob(dest_stem.name + ".*"))
    return files[0] if files else None, info


def log(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mixes", action="store_true")
    ap.add_argument("--tracks", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="al massimo N brani nuovi (0 = tutti)")
    args = ap.parse_args()
    lists = parse(DATA / "tracklists.txt")
    (DATA / "tracklists.json").write_text(json.dumps(lists, indent=1, ensure_ascii=False))
    MIXES.mkdir(parents=True, exist_ok=True)
    TRACKS.mkdir(parents=True, exist_ok=True)
    if args.mixes:
        for key, url in MIX_SOURCES.items():
            if list(MIXES.glob(f"{key}.*")):
                continue
            path, info = download(url, MIXES / key)
            print(f"mix {key}: {path.name if path else 'ERRORE'} ({info.get('duration')} s)", flush=True)
            log({"kind": "mix", "mix": key, "url": url, "file": path.name if path else None, "duration": info.get("duration")})
    if args.tracks:
        seen, done = {}, 0
        for mix in lists.values():
            for t in mix["tracks"]:
                seen.setdefault(t["id"], t)
        for tid, t in seen.items():
            if list(TRACKS.glob(f"{tid}.*")):
                continue
            if args.limit and done >= args.limit:
                break
            query = f"ytsearch8:{t['artist']} - {t['title']}"
            try:
                with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True}) as ydl:
                    res = ydl.extract_info(query, download=False)
                cands = [(score(e, t), e) for e in res.get("entries", [])]
                cands = sorted([c for c in cands if c[0] is not None], key=lambda c: -c[0])
                if not cands:
                    print(f"NON TROVATO {t['artist']} - {t['title']}", flush=True)
                    log({"kind": "track", "id": tid, "query": query, "found": False})
                    continue
                best = cands[0][1]
                path, info = download(best["url"], TRACKS / tid)
                done += 1
                print(f"{tid} {t['artist']} - {t['title']}  ->  {best.get('title')} [{best.get('channel')}] "
                      f"{best.get('duration')} s (attesa {t['duration']})", flush=True)
                log({"kind": "track", "id": tid, "artist": t["artist"], "title": t["title"], "found": True,
                     "url": best["url"], "ytTitle": best.get("title"), "channel": best.get("channel"),
                     "duration": best.get("duration"), "expected": t["duration"], "file": path.name if path else None})
            except Exception as err:  # blocco anti-bot o video non disponibile: si registra e si prosegue
                print(f"ERRORE {t['artist']} - {t['title']}: {str(err)[:120]}", flush=True)
                log({"kind": "track", "id": tid, "query": query, "error": str(err)[:300]})
                if "Sign in to confirm" in str(err):
                    print("YouTube chiede la verifica anti-bot: mi fermo", flush=True)
                    break
            time.sleep(2)


if __name__ == "__main__":
    main()
