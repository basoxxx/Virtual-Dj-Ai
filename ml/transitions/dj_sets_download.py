"""Mix di DJ veri (Gabry Ponte dalla v7, LUM!X dalla v8) e brani originali che suonano: solo in locale in
ml/data/<dj>, fuori da git. Audio con copyright: si usa solo per calcolare le caratteristiche per battuta (uso deciso
dall'utente il 28/09/2026).

- Tracklist (ml/data/<dj>/tracklists.txt): righe "@ chiave | titolo | pagina | url dell'audio" per ogni mix, poi
  "cue|artista - titolo|durata" per ogni brano (cue = inizio del brano nel mix, se noto). Fonti: 1001tracklists,
  capitoli e descrizioni dei video.
- Mix: SoundCloud o YouTube (canali ufficiali quando ci sono).
- Brani: YouTube con yt-dlp, scegliendo tra i primi risultati quello con la durata più vicina a quella della
  tracklist (entro 25 s) e il titolo più simile, senza versioni live, rallentate, karaoke o remix non richiesti.

Uso:  ml/.venv/bin/python ml/transitions/dj_sets_download.py --dj gabry|lumix [--mixes] [--tracks] [--limit N]
      -> ml/data/<dj>/tracklists.json, mixes/<mix>.<ext>, tracks/<id>.<ext>, downloads.jsonl
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
DJS = {"gabry": "gp-", "lumix": "lx-"}  # cartella in ml/data e prefisso degli id dei brani
BAD = ("live", "slowed", "sped up", "nightcore", "karaoke", "reverb", "8d", "instrumental", "acapella", "lyrics",
       "1 hour", "loop", "cover", "tutorial", "reaction", "mashup")


def track_id(artist: str, title: str, prefix: str = "gp-") -> str:
    return f"{prefix}{zlib.crc32(f'{artist} - {title}'.lower().encode()):08x}"


def parse(path: Path, prefix: str = "gp-") -> dict:
    """tracklists.txt -> {mix: {title, page, source, tracks: [{pos, cue, artist, title, duration, id}]}}."""
    out, cur = {}, None
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("@"):
            key, title, page, source = (p.strip() for p in line[1:].split("|"))
            cur = out[key] = {"title": title, "page": page, "source": source, "tracks": []}
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
                              "duration": d, "id": track_id(artist.strip(), title.strip(), prefix)})
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
            "noplaylist": True, "noprogress": True, "sleep_interval": 6, "max_sleep_interval": 15, "sleep_interval_requests": 1}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = list(dest_stem.parent.glob(dest_stem.name + ".*"))
    return files[0] if files else None, info


def log(rec: dict, path: Path) -> None:
    with path.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dj", choices=sorted(DJS), default="gabry")
    ap.add_argument("--mixes", action="store_true")
    ap.add_argument("--tracks", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="al massimo N brani nuovi (0 = tutti)")
    args = ap.parse_args()
    DATA = ML_DIR / "data" / args.dj
    MIXES, TRACKS, LOG = DATA / "mixes", DATA / "tracks", DATA / "downloads.jsonl"
    lists = parse(DATA / "tracklists.txt", DJS[args.dj])
    (DATA / "tracklists.json").write_text(json.dumps(lists, indent=1, ensure_ascii=False))
    MIXES.mkdir(parents=True, exist_ok=True)
    TRACKS.mkdir(parents=True, exist_ok=True)
    if args.mixes:
        for key, url in ((k, m["source"]) for k, m in lists.items()):
            if list(MIXES.glob(f"{key}.*")):
                continue
            path, info = download(url, MIXES / key)
            print(f"mix {key}: {path.name if path else 'ERRORE'} ({info.get('duration')} s)", flush=True)
            log({"kind": "mix", "mix": key, "url": url, "file": path.name if path else None, "duration": info.get("duration")}, LOG)
    if args.tracks:
        seen, done, refused = {}, 0, 0
        for mix in lists.values():
            for t in mix["tracks"]:
                seen.setdefault(t["id"], t)
        for tid, t in seen.items():
            if list(TRACKS.glob(f"{tid}.*")):
                continue
            if args.limit and done >= args.limit:
                break
            time.sleep(4)  # pausa anche tra le sole ricerche
            query = f"ytsearch8:{t['artist']} - {t['title']}"
            try:
                with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": True}) as ydl:
                    res = ydl.extract_info(query, download=False)
                cands = [(score(e, t), e) for e in res.get("entries", [])]
                cands = sorted([c for c in cands if c[0] is not None], key=lambda c: -c[0])
                if not cands:
                    print(f"NON TROVATO {t['artist']} - {t['title']}", flush=True)
                    log({"kind": "track", "id": tid, "query": query, "found": False}, LOG)
                    continue
                best = cands[0][1]
                path, info = download(best["url"], TRACKS / tid)
                done += 1
                print(f"{tid} {t['artist']} - {t['title']}  ->  {best.get('title')} [{best.get('channel')}] "
                      f"{best.get('duration')} s (attesa {t['duration']})", flush=True)
                log({"kind": "track", "id": tid, "artist": t["artist"], "title": t["title"], "found": True,
                     "url": best["url"], "ytTitle": best.get("title"), "channel": best.get("channel"),
                     "duration": best.get("duration"), "expected": t["duration"], "file": path.name if path else None}, LOG)
            except Exception as err:  # blocco anti-bot o video non disponibile: si registra e si prosegue
                print(f"ERRORE {t['artist']} - {t['title']}: {str(err)[:120]}", flush=True)
                log({"kind": "track", "id": tid, "query": query, "error": str(err)[:300]}, LOG)
                refused = refused + 1 if "403" in str(err) else 0
                if "Sign in to confirm" in str(err) or refused >= 3:
                    # nessun login né cookie: il limite è solo sull'indirizzo IP, meglio fermarsi subito
                    print("YouTube chiede la verifica anti-bot o rifiuta i download: mi fermo", flush=True)
                    break
                continue
            refused = 0


if __name__ == "__main__":
    main()
