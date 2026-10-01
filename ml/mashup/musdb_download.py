"""Scarica solo le 50 tracce di test di MUSDB18 (Zenodo 10.5281/zenodo.1117372, file STEMS .mp4) in ml/data/musdb/test.

MUSDB18: licenza solo ricerca non commerciale. Su decisione dell'utente si usa solo in locale e solo per misurare
la separazione voce/base (ml/mashup/eval_musdb.py): mai in git, mai ridistribuito.

Lo zip completo è di 4,7 GB; qui si leggono con richieste HTTP a intervalli (Range) solo l'indice dello zip e i
50 file di test (~1,6 GB), dentro un file "sparso" della stessa dimensione che alla fine si cancella.

Uso:  ml/.venv/bin/python ml/mashup/musdb_download.py
"""
import hashlib
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
DEST = ML_DIR / "data" / "musdb"
URL = "https://zenodo.org/api/records/1117372/files/musdb18.zip/content"
SIZE = 4684228845


def get_range(start: int, end: int, retries: int = 5) -> bytes:
    for k in range(retries):
        try:
            req = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) == end - start + 1:
                return data
            print(f"  risposta corta ({len(data)} su {end - start + 1}), riprovo", flush=True)
        except Exception as exc:  # rete instabile: si riprova con pause crescenti
            print(f"  errore {exc!r}, riprovo", flush=True)
        time.sleep(5 * (k + 1))
    raise RuntimeError(f"intervallo {start}-{end} non scaricato")


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    sparse = DEST / "musdb18.zip.sparse"
    with open(sparse, "wb") as f:
        f.truncate(SIZE)
    # indice dello zip (central directory + fine): gli ultimi 2 MB bastano per 150 file
    tail = 2 * 1024 * 1024
    with open(sparse, "r+b") as f:
        f.seek(SIZE - tail)
        f.write(get_range(SIZE - tail, SIZE - 1))
    zf = zipfile.ZipFile(sparse)
    infos = [i for i in zf.infolist() if "/test/" in "/" + i.filename and i.filename.endswith(".stem.mp4")]
    print(f"{len(zf.infolist())} voci nello zip, {len(infos)} tracce di test, "
          f"{sum(i.compress_size for i in infos) / 1e9:.2f} GB", flush=True)
    out_dir = DEST / "test"
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    done = 0
    for n, info in enumerate(infos):
        target = out_dir / Path(info.filename).name
        if target.exists() and target.stat().st_size == info.file_size:
            continue
        # intestazione locale (30 byte + nome + extra) e dati compressi in un'unica richiesta
        start = info.header_offset
        end = min(SIZE - 1, start + 30 + len(info.filename.encode()) + 1024 + info.compress_size)
        data = get_range(start, end)
        with open(sparse, "r+b") as f:
            f.seek(start)
            f.write(data)
        # zip riaperto per ogni traccia: il buffer di lettura potrebbe contenere ancora gli zeri del file sparso
        with zipfile.ZipFile(sparse) as z, z.open(info) as src, open(target, "wb") as dst:  # CRC verificato
            shutil.copyfileobj(src, dst, 1 << 20)
        done += len(data)
        print(f"{n + 1}/{len(infos)} {target.name} {info.file_size / 1e6:.0f} MB "
              f"({done / 1e6 / max(1e-3, time.time() - t0):.1f} MB/s)", flush=True)
    zf.close()
    sparse.unlink()
    files = sorted(out_dir.glob("*.stem.mp4"))
    h = hashlib.sha256()
    for p in files:
        h.update(p.name.encode())
        h.update(str(p.stat().st_size).encode())
    print(f"fatto: {len(files)} tracce in {out_dir}, impronta dei nomi e dimensioni {h.hexdigest()[:16]}")
    return 0 if len(files) == 50 else 1


if __name__ == "__main__":
    sys.exit(main())
