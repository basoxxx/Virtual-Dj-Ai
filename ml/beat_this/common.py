"""Parti comuni per rifinire Beat This! small0 (dati, etichette, metriche, griglia dell'app).

Cartelle (solo in locale, ml/data/ è fuori da git):
  ml/data/beat_this/inventory.json      brani, sorgente, suddivisione (train/val/test/...)
  ml/data/beat_this/spect/<id>.npy      log-mel (frame, 128) come l'app; float16 per l'addestramento,
                                        float32 per i brani di valutazione
  ml/data/beat_this/teacher/<id>.npz    logit, battute e battute forti di final0 (insegnante)
"""

from __future__ import annotations

import gzip
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
REPO = ML_DIR.parent
os.environ.setdefault("TORCH_HOME", str(ML_DIR / "data" / "torch"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import soxr  # noqa: E402

import reference as ref  # noqa: E402

DATA = ML_DIR / "data" / "beat_this"
SPECT = DATA / "spect"
TEACHER = DATA / "teacher"
INVENTORY = DATA / "inventory.json"
CKPT = ML_DIR / "data" / "checkpoints"
ONNX_DIR = ML_DIR / "data" / "onnx"
WERTHEN = ML_DIR / "data" / "werthen" / "extracted"
USB_ROOT = Path("/Volumes/Untitled/musicaa")
FPS = ref.FPS
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".flac", ".webm", ".opus", ".ogg", ".aac"}


# ---------------------------------------------------------------- audio e spettrogrammi

def probe(path: Path) -> tuple[int, int, float]:
    """Frequenza di campionamento, canali e durata (s) del primo flusso audio."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels:format=duration",
         "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    st = j["streams"][0]
    return int(st["sample_rate"]), int(st["channels"]), float(j["format"].get("duration") or 0)


def decode(path: Path) -> np.ndarray:
    """Audio mono float32 a 22050 Hz come reference.to_mono_22050: media dei canali e soxr (qualità HQ)."""
    sr, ch, _ = probe(path)
    ch = min(ch, 2)
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le",
                          "-ac", str(ch), "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, ch)
    return ref.to_mono_22050(x if ch > 1 else x[:, 0], sr)


def spect_path(tid: str) -> Path:
    return SPECT / f"{tid}.npy"


def load_spect(tid: str, mmap: bool = False) -> np.ndarray:
    return np.load(spect_path(tid), mmap_mode="r" if mmap else None)


def load_teacher(tid: str) -> dict:
    with np.load(TEACHER / f"{tid}.npz") as z:
        return {k: z[k] for k in z.files}


def track_id(source: str, key: str) -> str:
    return f"{source}-{zlib.crc32(key.encode()):08x}"


def load_inventory() -> list[dict]:
    return json.loads(INVENTORY.read_text())


# ---------------------------------------------------------------- etichette di Gand (warp marker di Ableton)

def gand_clips() -> dict[str, dict]:
    """Griglia di ogni brano originale dei 5 set (refsongs): dai due warp marker di ogni clip (tempo costante).

    Restituisce {percorso del wav: {"set", "period", "sec0", "loop_end"}}; la battuta 0 (BeatTime 0) è una battuta
    forte (inizio di battuta da 4/4 per Ableton). Le clip dei mix stessi (Mixotic_*) sono escluse."""
    out = {}
    for als in sorted(WERTHEN.glob("*/*.als")):
        refs = {p.stem: p for p in (als.parent / "refsongs").iterdir()}
        root = ET.fromstring(gzip.decompress(als.read_bytes()))
        for clip in root.iter("AudioClip"):
            name = clip.find("SampleRef/FileRef/Name").get("Value")
            stem = Path(name).stem
            if stem.startswith("Mixotic_") or stem not in refs:
                continue
            wm = [(float(m.get("SecTime")), float(m.get("BeatTime"))) for m in clip.find("WarpMarkers")]
            (s0, b0), (s1, b1) = wm[0], wm[-1]
            period = (s1 - s0) / (b1 - b0)
            sec0 = s0 - b0 * period
            key = str(refs[stem])
            if key in out:
                # stessa canzone in due clip: deve avere la stessa griglia
                o = out[key]
                k = round((sec0 - o["sec0"]) / o["period"])
                assert abs(period - o["period"]) < 1e-4 and abs(sec0 - o["sec0"] - k * o["period"]) < 0.01, key
                continue
            out[key] = {"set": als.parent.name, "period": period, "sec0": sec0,
                        "loop_end": float(clip.find("Loop/LoopEnd").get("Value"))}
    return out


def audible_span(spect: np.ndarray, db=-40.0) -> tuple[float, float]:
    """Primo e ultimo istante (s) in cui il brano suona: energia del frame entro `db` dal massimo del brano."""
    mag = np.expm1(np.asarray(spect, dtype=np.float32)).mean(1) / 1000
    level = 20 * np.log10(mag + 1e-9)
    on = np.nonzero(level > level.max() + db)[0]
    return on[0] / FPS, on[-1] / FPS


def kick_offset(info: dict, spect: np.ndarray) -> float:
    """Controllo dei warp marker senza modelli: flusso spettrale delle bande basse (cassa) ripiegato sul periodo
    della griglia; restituisce dove cade il picco (ms) rispetto alla battuta della griglia. Vicino a 0 = marker
    sull'attacco della cassa."""
    low = np.asarray(spect, dtype=np.float32)[:, :12].mean(1)
    flux = np.maximum(0, np.diff(low, prepend=low[0]))
    ph = ((np.arange(len(flux)) / FPS - info["sec0"]) / info["period"]) % 1.0
    h = np.bincount((ph * 100).astype(int) % 100, weights=flux, minlength=100)
    k = int(np.argmax(h))
    return (k / 100 if k < 50 else k / 100 - 1) * info["period"] * 1000


def gand_truth(info: dict, spect: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Battute e battute forti di riferimento: la griglia dei warp marker (tempo costante, battuta 0 = battuta
    forte) estesa a tutto il tratto udibile del brano, in entrambe le direzioni."""
    p, s0 = info["period"], info["sec0"]
    a, b = audible_span(spect)
    k = np.arange(int(np.ceil((a - s0) / p)), int(np.floor((b - s0) / p)) + 1)
    t = s0 + k * p
    return t, t[k % 4 == 0]


# ---------------------------------------------------------------- metriche

def f_measure(ref_times, est_times, window=0.07, skip=5.0) -> float:
    """F-measure come mir_eval.beat.f_measure (finestra ±70 ms, battute dei primi 5 s escluse)."""
    r = np.asarray([t for t in ref_times if t >= skip])
    e = np.asarray([t for t in est_times if t >= skip])
    if len(r) == 0 and len(e) == 0:
        return 1.0
    if len(r) == 0 or len(e) == 0:
        return 0.0
    used = np.zeros(len(e), dtype=bool)
    hits = 0
    for t in r:
        d = np.abs(e - t)
        d[used] = np.inf
        j = int(np.argmin(d))
        if d[j] <= window:
            used[j] = True
            hits += 1
    if hits == 0:
        return 0.0
    p, rc = hits / len(e), hits / len(r)
    return 2 * p * rc / (p + rc)


def ok_bpm(est, true, tol=0.5) -> bool:
    return est is not None and abs(est - true) <= tol


def ok_acc2(est, true, factors=(1, 2, 0.5, 3, 1 / 3)) -> bool:
    return bool(est) and any(abs(est - true * f) <= 0.04 * true * f for f in factors)


def on_downbeat(offset: float, downbeats, tol=0.07, before=30.0) -> bool:
    """L'offset della griglia cade (±70 ms) su una battuta forte di riferimento dei primi 30 s (come summarize.py)."""
    d = np.asarray([x for x in downbeats if x < before])
    return bool(len(d)) and float(np.min(np.abs(d - offset))) <= tol


def grid_phase_ok(bpm: float, offset: float, period: float, sec0: float, tol=0.07) -> bool:
    """La griglia dell'app ha la battuta forte nello stesso punto della griglia vera (a meno di battute intere da 4)."""
    if not bpm:
        return False
    bar = 4 * period
    d = (offset - sec0) % bar
    return min(d, bar - d) <= tol


# ---------------------------------------------------------------- griglia dell'app (beatGrid di beat-this.js, in Node)

GRID_JS = Path(__file__).resolve().parent / "grid.mjs"


def app_grids(items: dict[str, dict]) -> dict[str, dict]:
    """{id: {"beats", "downbeats"}} -> {id: griglia di beatGrid()} eseguendo il codice JavaScript dell'app."""
    payload = json.dumps({k: {"beats": [round(float(x), 4) for x in v["beats"]],
                              "downbeats": [round(float(x), 4) for x in v["downbeats"]]} for k, v in items.items()})
    out = subprocess.run(["node", str(GRID_JS)], input=payload, capture_output=True, text=True, check=True, cwd=REPO)
    return json.loads(out.stdout)


# ---------------------------------------------------------------- nomi dei brani (duplicati tra cartelle)

def norm_title(path: str) -> str:
    """Titolo normalizzato per riconoscere lo stesso brano in cartelle diverse o con suffissi (1), _2…"""
    s = Path(path).stem.lower()
    s = re.sub(r"spotifymate\.com - |y2mate\.com - |\(mp3_\d+k\)", " ", s)
    s = re.sub(r"[\(\[][^\)\]]*(official|video|lyric|audio|visuali[sz]er|mp3)[^\)\]]*[\)\]]", " ", s)
    s = re.sub(r"\(\d+\)|_\d+$| \d+$", " ", s)
    s = re.sub(r"[^a-z0-9àèéìòù]+", " ", s)
    return " ".join(s.split())
