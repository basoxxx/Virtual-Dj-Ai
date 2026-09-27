"""Modello C: pianificatore delle transizioni. Transformer bidirezionale (circa 6M parametri) che, per ogni
battuta della finestra di transizione, prevede i controlli del mixer dell'app:
    [crossfader 0..1, EQ A basso/medio/alto, EQ B basso/medio/alto (-1..0 = fino a -30 dB), filtro A, filtro B (-1..1)]

Idee riprese da DJtransGAN (Chen et al., ICASSP 2022, MIT): curve di fader ed EQ applicate agli spettri dei due
brani con un mixer differenziabile, così il modello si confronta anche con il suono del mix reale e non solo
con curve stimate (che non distinguono sempre fader ed EQ).
"""

from __future__ import annotations

import math

import torch
from torch import nn

N_OUT = 9
MAX_BEATS = 128


class Block(nn.Module):
    def __init__(self, d: int, heads: int, ff: int, dropout: float):
        super().__init__()
        self.heads = heads
        self.n1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.n2 = nn.LayerNorm(d)
        self.ff = nn.Sequential(nn.Linear(d, ff), nn.GELU(), nn.Dropout(dropout), nn.Linear(ff, d))
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, bias: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        q, k, v = self.qkv(self.n1(x)).reshape(b, t, 3, self.heads, d // self.heads).permute(2, 0, 3, 1, 4)
        att = (q @ k.transpose(-1, -2)) / math.sqrt(d // self.heads) + bias
        h = (att.softmax(-1) @ v).transpose(1, 2).reshape(b, t, d)
        x = x + self.drop(self.proj(h))
        return x + self.drop(self.ff(self.n2(x)))


class TransitionPlanner(nn.Module):
    def __init__(self, n_in: int, d: int = 256, layers: int = 8, heads: int = 4, ff: int = 1024, dropout: float = 0.1):
        super().__init__()
        self.inp = nn.Sequential(nn.Linear(n_in, d), nn.GELU(), nn.Linear(d, d))
        self.pos = nn.Parameter(torch.randn(1, MAX_BEATS, d) * 0.02)
        self.blocks = nn.ModuleList(Block(d, heads, ff, dropout) for _ in range(layers))
        self.norm = nn.LayerNorm(d)
        self.out = nn.Linear(d, N_OUT)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """x: (B, 128, n_in); mask: (B, 128) 1 = battuta valida. Restituisce (B, 128, 9)."""
        bias = (1.0 - mask[:, None, None, :].float()) * -1e4
        h = self.inp(x) + self.pos
        for blk in self.blocks:
            h = blk(h, bias)
        o = self.out(self.norm(h))
        return torch.cat([torch.sigmoid(o[..., :1]), -torch.sigmoid(o[..., 1:7]), torch.tanh(o[..., 7:9])], -1)


def crossfader_gains(xf: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Curva 'smooth' del crossfader dell'app (AudioEngine.crossfaderGains)."""
    a = torch.clamp(torch.cos(xf * math.pi / 2) * math.sqrt(2), max=1.0)
    b = torch.clamp(torch.sin(xf * math.pi / 2) * math.sqrt(2), max=1.0)
    return a, b


def eq_gain(v: torch.Tensor) -> torch.Tensor:
    """Knob EQ -1..0 -> guadagno d'ampiezza (fino a -30 dB), come ChannelStrip.setEq."""
    return torch.pow(10.0, 1.5 * v)


def mix_power(ctrl: torch.Tensor, pow_a: torch.Tensor, pow_b: torch.Tensor) -> torch.Tensor:
    """Mixer differenziabile: potenza per banda (B, T, 3) del mix ottenuto con i controlli."""
    ga, gb = crossfader_gains(ctrl[..., 0])
    amp_a = ga[..., None] * eq_gain(ctrl[..., 1:4])
    amp_b = gb[..., None] * eq_gain(ctrl[..., 4:7])
    return amp_a ** 2 * pow_a + amp_b ** 2 * pow_b


CONTROL_WEIGHTS = torch.tensor([1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.1, 0.1])


def losses(pred: torch.Tensor, target: torch.Tensor, powers: torch.Tensor, mask: torch.Tensor,
           weights: torch.Tensor | None = None, mixer_on: torch.Tensor | None = None) -> dict:
    """powers: (B, T, 9) = potenze per banda di A (0:3), B (3:6) e del mix reale (6:9).
    weights: (B, T, 9) pesi per controllo (0 = controllo non noto, es. EQ nei dati di solo crossfader);
    mixer_on: (B,) 1 dove le potenze del mix sono note (perdita del mixer differenziabile)."""
    m = mask.float()[..., None]
    n = m.sum().clamp(min=1)
    w = CONTROL_WEIGHTS.to(pred.device) if weights is None else weights * CONTROL_WEIGHTS.to(pred.device)
    wm = w * m
    curve = ((pred - target).abs() * wm).sum() / wm.sum().clamp(min=1e-6)
    est = mix_power(pred, powers[..., 0:3], powers[..., 3:6])
    ref = powers[..., 6:9]
    db = lambda p: 10 * torch.log10(p + 1e-6 * (ref.mean() + 1e-12))  # noqa: E731
    mm = m if mixer_on is None else m * mixer_on.float()[:, None, None]
    mixer = ((db(est) - db(ref)).abs() * mm).sum() / (mm.sum().clamp(min=1) * 3) / 10  # in unità di 10 dB
    tv = ((pred[:, 1:] - pred[:, :-1]).abs() * m[:, 1:] * m[:, :-1]).sum() / (n * N_OUT)
    return {"curve": curve, "mixer": mixer, "tv": tv, "total": curve + 0.5 * mixer + 0.05 * tv}


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


if __name__ == "__main__":
    net = TransitionPlanner(35)
    x = torch.randn(2, MAX_BEATS, 35)
    mask = torch.ones(2, MAX_BEATS)
    print(net(x, mask).shape, f"{count_params(net) / 1e6:.2f}M parametri")
