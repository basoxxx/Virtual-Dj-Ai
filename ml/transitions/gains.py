"""Curve di fader ed EQ di una transizione reale, stimate dal mix (riscritto da zero, idea da Kim, Yang e Nam,
"Joint Estimation of Fader and Equalizer Gains of DJ Mixers using Convex Optimization", DAFx 2022).

Per ogni banda dell'EQ dell'app (bassi <220 Hz, medi, alti >3500 Hz), per ogni sua sotto-banda f (64 bande
logaritmiche in tutto) e per ogni battuta j del mix:
    potenza_mix[j, f] ≈ a[j] · rA[f] · potenza_A[kA(j), f] + b[j] · rB[f] · potenza_B[kB(j), f]
con a, b ≥ 0 (guadagni di potenza della banda, condivisi dalle sue sotto-bande) e una penalità sulle
variazioni tra battute consecutive: minimi quadrati convessi con vincoli di limite. rA e rB calibrano il livello
"pieno" di ogni sotto-banda nel mix sulle battute in cui il brano suona da solo (prima della transizione per A,
dopo per B).
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import lsq_linear

SMOOTH = 1.0
MAX_POWER_GAIN = 1.5


def solve_band(M: np.ndarray, PA: np.ndarray, PB: np.ndarray, smooth: float = SMOOTH) -> tuple[np.ndarray, np.ndarray, float]:
    """Guadagni di potenza a, b (uno per battuta) condivisi da tutte le sotto-bande di una banda dell'EQ.

    M, PA, PB: (n battute, F sotto-bande). Con più sotto-bande il problema è identificabile anche quando
    i due brani hanno la stessa potenza totale (es. due casse a tempo): conta il "colore" spettrale."""
    n, F = M.shape
    W = 1.0 / (M + 1e-3 * (M.mean() + 1e-12))  # errore relativo
    rows = np.zeros((n * F, 2 * n))
    for j in range(n):
        rows[j * F:(j + 1) * F, j] = PA[j] * W[j]
        rows[j * F:(j + 1) * F, n + j] = PB[j] * W[j]
    D = np.zeros((2 * (n - 1), 2 * n))
    k = np.arange(n - 1)
    D[k, k], D[k, k + 1] = -smooth, smooth
    D[n - 1 + k, n + k], D[n - 1 + k, n + k + 1] = -smooth, smooth
    A = np.vstack([rows, D])
    y = np.concatenate([(M * W).reshape(-1), np.zeros(2 * (n - 1))])
    res = lsq_linear(A, y, bounds=(0, MAX_POWER_GAIN), lsmr_tol="auto")
    a, b = res.x[:n], res.x[n:]
    fit = a[:, None] * PA + b[:, None] * PB
    err = float(np.median(np.abs(fit - M) / (M + 1e-12)))
    return a, b, err


def estimate(mix_fine: np.ndarray, a_fine: np.ndarray, b_fine: np.ndarray, band_of_bin: np.ndarray,
             solo_a: slice, solo_b: slice, smooth: float = SMOOTH) -> dict:
    """mix_fine, a_fine, b_fine: (n battute, 64 sotto-bande) di potenza, già allineate battuta per battuta.
    band_of_bin: banda dell'EQ (0, 1, 2) di ogni sotto-banda. solo_a/solo_b: battute (dentro gli array) in cui
    suona solo A / solo B, per calibrare il livello "pieno" di ogni sotto-banda nel mix."""
    ga, gb, errs, band_a, band_b, band_mix = [], [], [], [], [], []
    for band in range(3):
        bins = np.where((band_of_bin == band) & (a_fine.sum(0) > 0) & (b_fine.sum(0) > 0) & (mix_fine.sum(0) > 0))[0]
        M, PA, PB = mix_fine[:, bins], a_fine[:, bins], b_fine[:, bins]
        ra = np.median(M[solo_a] / (PA[solo_a] + 1e-12), 0) if solo_a.stop > solo_a.start else np.ones(len(bins))
        rb = np.median(M[solo_b] / (PB[solo_b] + 1e-12), 0) if solo_b.stop > solo_b.start else np.ones(len(bins))
        a, b, err = solve_band(M, ra * PA, rb * PB, smooth)
        ga.append(np.sqrt(a))
        gb.append(np.sqrt(b))
        errs.append(err)
        band_a.append((ra * PA).sum(1))
        band_b.append((rb * PB).sum(1))
        band_mix.append(M.sum(1))
    return {"gainA": np.stack(ga, 1), "gainB": np.stack(gb, 1), "fitError": float(np.mean(errs)),
            # potenze per banda calibrate sul mix (stessa scala del fit), per il mixer differenziabile
            "bandA": np.stack(band_a, 1), "bandB": np.stack(band_b, 1), "bandMix": np.stack(band_mix, 1)}


def smooth_crossfader(x: float) -> tuple[float, float]:
    """AudioEngine.crossfaderGains con la curva 'smooth' dell'app (x in 0..1 dal deck uscente all'entrante)."""
    a = min(1.0, np.cos(x * np.pi / 2) * np.sqrt(2))
    b = min(1.0, np.sin(x * np.pi / 2) * np.sqrt(2))
    return a, b


_XF_GRID = np.linspace(0, 1, 201)
_XF_GAINS = np.array([smooth_crossfader(x) for x in _XF_GRID])


def to_controls(gain_a: np.ndarray, gain_b: np.ndarray) -> np.ndarray:
    """Guadagni d'ampiezza per banda (n, 3) dei due brani -> controlli dell'app per battuta:
    [crossfader 0..1, EQ A basso/medio/alto, EQ B basso/medio/alto (-1..0 = fino a -30 dB), filtro A, filtro B]."""
    fa = np.clip(gain_a.max(1), 0, 1)
    fb = np.clip(gain_b.max(1), 0, 1)
    err = (_XF_GAINS[None, :, 0] - fa[:, None]) ** 2 + (_XF_GAINS[None, :, 1] - fb[:, None]) ** 2
    xf = _XF_GRID[np.argmin(err, 1)]
    # l'EQ si esprime rispetto al fader del proprio deck
    eq = lambda g, f: np.clip(20 * np.log10(np.clip(g / (f[:, None] + 1e-6), 1e-4, 1)) / 30, -1, 0)  # noqa: E731
    # con il deck quasi muto l'EQ non si osserva: si tiene neutra
    eq_a = np.where(fa[:, None] > 0.05, eq(gain_a, fa), 0)
    eq_b = np.where(fb[:, None] > 0.05, eq(gain_b, fb), 0)
    n = len(xf)
    return np.concatenate([xf[:, None], eq_a, eq_b, np.zeros((n, 2))], 1).astype(np.float32)


CONTROL_NAMES = ["crossfader", "eqA_low", "eqA_mid", "eqA_high", "eqB_low", "eqB_mid", "eqB_high", "filterA", "filterB"]
