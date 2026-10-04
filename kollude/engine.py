"""One-call investigation over an event frame, with a progress-event generator for live UIs."""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from kollude import coord
from kollude.frame import sample_text
from kollude.stream import EDetector, finite


@dataclass
class ScanParams:
    freq: str = "1h"
    min_actors: int = 5
    alpha: float = 0.01
    warmup: int = 24
    m_min: float = 3.0
    n_tokens: int = 12
    min_tokens: int = 4
    top_clusters: int = 40
    top_actors: int = 60
    seed: int = 0
    window: int = 6
    suffix: bool = True

    def coord(self) -> coord.CoordParams:
        return coord.CoordParams(
            freq=self.freq,
            min_actors=self.min_actors,
            n_tokens=self.n_tokens,
            min_tokens=self.min_tokens,
            window=self.window,
            suffix=self.suffix,
        )

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> ScanParams:
        d = d or {}
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d and d[k] is not None}
        return cls(**known)


@dataclass
class ScanResult:
    params: dict[str, Any]
    summary: dict[str, Any]
    timeline: list[dict[str, Any]]
    alarms: list[dict[str, Any]]
    clusters: list[dict[str, Any]]
    actors: list[dict[str, Any]]
    timings: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _iso(t: Any) -> str | None:
    if t is None or (isinstance(t, float) and np.isnan(t)) or pd.isna(t):
        return None
    return pd.Timestamp(t).isoformat().replace("+00:00", "Z")


def _clean(v: Any) -> Any:
    if isinstance(v, (pd.Timestamp, np.datetime64)):
        return _iso(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return finite(float(v))
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def explain_bin(ann: pd.DataFrame, b: pd.Timestamp, p: coord.CoordParams, *, top: int = 5) -> list[dict[str, Any]]:
    lo = b - (max(p.window, 1) - 1) * pd.Timedelta(p.freq)
    sub = ann[(ann["bin"] >= lo) & (ann["bin"] <= b) & ann["actor"].notna() & ann["tid"].notna()]
    if sub.empty:
        return []
    g = sub.groupby("tid").agg(
        template=("tmpl", "first"), n_actors=("actor", "nunique"), n_events=("event_id", "size"), sample=("text", "first")
    )
    g = g[g["n_actors"] >= p.min_actors].sort_values("n_actors", ascending=False).head(top)
    g["sample"] = g["sample"].map(lambda s: sample_text(s, 200))
    return _records(g.reset_index())


def scan_iter(df: pd.DataFrame, params: ScanParams | None = None, *, ann: pd.DataFrame | None = None) -> Iterator[dict[str, Any]]:
    """Yield progress events; the last one has ``type == 'result'`` with the ScanResult dict.

    Event types: ``stage`` (name, seconds), ``tick`` (one closed bin), ``alarm``, ``result``.
    Pass ``ann`` (from ``coord.annotate`` with the same params) to skip re-annotating.
    """
    p = params or ScanParams()
    cp = p.coord()
    timings: dict[str, float] = {}
    t0 = time.perf_counter()

    if ann is None:
        ann = coord.annotate(df, cp)
    timings["signatures_s"] = time.perf_counter() - t0
    yield {"type": "stage", "name": "signatures", "seconds": timings["signatures_s"], "n_events": len(df)}

    t1 = time.perf_counter()
    bins = coord.bin_signals(ann, cp)
    timings["bins_s"] = time.perf_counter() - t1
    yield {"type": "stage", "name": "bins", "seconds": timings["bins_s"], "n_bins": len(bins)}

    t2 = time.perf_counter()
    det = EDetector(alpha=p.alpha, warmup=p.warmup, m_min=p.m_min, seed=p.seed)
    timeline: list[dict[str, Any]] = []
    alarms: list[dict[str, Any]] = []
    for row in bins.to_dict(orient="records"):
        r = det.update(float(row["C"]), float(row["M"]))
        tick = {
            "t": _iso(row["bin"]),
            "n": int(row["n_events"]),
            "actors": int(row["n_actors"]),
            "C": finite(row["C"]),
            "M": finite(row["M"]),
            "coord": int(row["n_coord"]),
            "p": finite(r["p"]),
            "log10_S": finite(np.log10(max(r["S"], 1e-12))),
            "alarm": r["alarm"],
            "label_rate": finite(row.get("label_rate")),
        }
        timeline.append(tick)
        yield {"type": "tick", **tick}
        if r["alarm"]:
            a = {
                "t": tick["t"],
                "S": finite(r["S"]),
                "C": tick["C"],
                "M": tick["M"],
                "n_events": tick["n"],
                "label_rate": tick["label_rate"],
                "templates": explain_bin(ann, row["bin"], cp),
            }
            alarms.append(a)
            yield {"type": "alarm", **a}
    timings["detector_s"] = time.perf_counter() - t2

    t3 = time.perf_counter()
    cl = coord.clusters(ann, cp, top=p.top_clusters)
    ac = coord.actor_scores(ann, cp).head(p.top_actors)
    timings["clusters_s"] = time.perf_counter() - t3
    yield {"type": "stage", "name": "clusters", "seconds": timings["clusters_s"], "n_clusters": len(cl)}
    timings["total_s"] = time.perf_counter() - t0

    n_named = int(df["actor"].notna().sum())
    summary = {
        "n_events": len(df),
        "n_actors": int(df["actor"].nunique()),
        "n_named_events": n_named,
        "t_min": _iso(df["t"].min()) if len(df) else None,
        "t_max": _iso(df["t"].max()) if len(df) else None,
        "n_bins": len(bins),
        "n_alarms": len(alarms),
        "first_alarm": alarms[0]["t"] if alarms else None,
        "coordinated_event_share": finite(bins["n_coord"].sum() / max(len(df), 1)),
        "has_labels": bool(df["label"].notna().any()),
        "label_rate": finite(df["label"].mean()) if df["label"].notna().any() else None,
        "events_per_s": finite(len(df) / max(timings["total_s"], 1e-9)),
    }
    result = ScanResult(
        params=asdict(p),
        summary=summary,
        timeline=timeline,
        alarms=alarms,
        clusters=_records(cl),
        actors=_records(ac),
        timings=timings,
    )
    yield {"type": "result", "result": result.as_dict()}


def scan(df: pd.DataFrame, params: ScanParams | None = None) -> ScanResult:
    last: dict[str, Any] | None = None
    for ev in scan_iter(df, params):
        last = ev
    assert last is not None and last["type"] == "result"
    r = last["result"]
    return ScanResult(**r)
