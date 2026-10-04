"""Anytime-valid streaming alarm: conformal p-values → e-CUSUM detector.

For each closed time bin the coordination score ``C_t`` is ranked against all *past* bins
(smoothed conformal p-value, exact under exchangeability). A mixture power-calibrator
turns ``p_t`` into an e-value ``e_t`` with ``E[e_t] ≤ 1`` under the null, and the
e-CUSUM statistic ``S_t = e_t · max(S_{t-1}, 1)`` raises an alarm when ``S_t ≥ 1/α``.
Under the no-change null this controls the average run length to a false alarm
(ARL ≥ 1/α bins; Shin, Ramdas & Rinaldo 2022, "E-detectors").

Gate (non-promotion): an alarm additionally needs the M axis — mean distinct actors per
coordinated template ≥ ``m_min`` — so a single repetitive bot never fires on its own.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

EPSILONS = (0.05, 0.1, 0.2, 0.35, 0.5)


def mixture_e(p: float) -> float:
    p = min(max(p, 1e-12), 1.0)
    return float(sum(e * p ** (e - 1.0) for e in EPSILONS) / len(EPSILONS))


@dataclass
class EDetector:
    alpha: float = 0.01
    warmup: int = 24
    m_min: float = 3.0
    seed: int = 0
    _past: list[float] = field(default_factory=list)
    _S: float = 1.0
    _n: int = 0

    def __post_init__(self) -> None:
        self._rng = np.random.default_rng(self.seed)

    @property
    def threshold(self) -> float:
        return 1.0 / self.alpha

    def update(self, z: float, m: float) -> dict:
        """Feed one closed bin; returns the timeline row (p, e, S, alarm)."""
        n = len(self._past)
        if n < self.warmup:
            p, e = 1.0, 1.0
        else:
            lo = bisect.bisect_left(self._past, z)
            hi = bisect.bisect_right(self._past, z)
            greater = n - hi
            ties = hi - lo
            u = float(self._rng.random())
            p = (greater + u * (ties + 1)) / (n + 1)
            e = mixture_e(p)
        self._S = e * max(self._S, 1.0)
        gate = m >= self.m_min
        alarm = bool(self._S >= self.threshold and gate)
        row = {"p": p, "e": e, "S": self._S, "gate": gate, "alarm": alarm}
        bisect.insort(self._past, z)
        self._n += 1
        if alarm:
            self._S = 1.0  # restart after each alarm (change-point semantics)
        return row


def detect_bins(
    bins: pd.DataFrame,
    *,
    alpha: float = 0.01,
    warmup: int = 24,
    m_min: float = 3.0,
    seed: int = 0,
    score_col: str = "C",
) -> pd.DataFrame:
    det = EDetector(alpha=alpha, warmup=warmup, m_min=m_min, seed=seed)
    rows = [det.update(float(z), float(m)) for z, m in zip(bins[score_col], bins["M"], strict=True)]
    out = bins.copy()
    tl = pd.DataFrame(rows, index=out.index)
    for c in tl.columns:
        out[c] = tl[c]
    out["log10_S"] = np.log10(out["S"].clip(lower=1e-12))
    return out


def alarm_times(timeline: pd.DataFrame) -> list[pd.Timestamp]:
    return list(timeline.loc[timeline["alarm"], "bin"])


def permutation_arl(
    bins: pd.DataFrame,
    *,
    n_perm: int = 50,
    alpha: float = 0.01,
    warmup: int = 24,
    m_min: float = 3.0,
    seed: int = 0,
) -> dict:
    """Empirical false-alarm rate on time-shuffled bins (exchangeable by construction)."""
    rng = np.random.default_rng(seed)
    n = len(bins)
    if n <= warmup + 1:
        return {"n_perm": 0, "false_alarms_per_1000_bins": None}
    rates = []
    for i in range(n_perm):
        perm = bins.iloc[rng.permutation(n)].reset_index(drop=True)
        tl = detect_bins(perm, alpha=alpha, warmup=warmup, m_min=m_min, seed=seed + i + 1)
        rates.append(1000.0 * tl["alarm"].sum() / max(n - warmup, 1))
    arr = np.array(rates)
    return {
        "n_perm": n_perm,
        "false_alarms_per_1000_bins": float(arr.mean()),
        "ci": [float(np.quantile(arr, 0.025)), float(np.quantile(arr, 0.975))],
        "bound_per_1000_bins": 1000.0 * alpha,
        "note": "ARL ≥ 1/α ⇒ long-run rate ≤ 1000·α alarms per 1000 null bins",
    }


def first_alarm_after(timeline: pd.DataFrame, t0: pd.Timestamp) -> pd.Timestamp | None:
    hits = timeline.loc[timeline["alarm"] & (timeline["bin"] >= t0), "bin"]
    return hits.iloc[0] if len(hits) else None


def lead_hours(alarm: pd.Timestamp | None, landmark: pd.Timestamp) -> float | None:
    if alarm is None:
        return None
    return float((landmark - alarm).total_seconds() / 3600.0)


def finite(x: float | None) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None
