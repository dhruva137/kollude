"""Stress tests for the engine, with exact ground truth.

* **scale** — synthetic streams of 10k → 2M events with a swarm injected at a known bin:
  throughput, peak frame size, detection delay, false alarms before onset.
* **power** — detection rate vs swarm intensity (share of traffic), many seeds, Wilson CIs,
  plus a no-swarm null arm for the false-alarm rate.
* **evasion** — swarms that paraphrase their opening tokens (honest limitation check).
* **fuzz** — malformed / hostile records must never crash ingest or scan.

Synthetic text only; nothing here touches the network.

    python -m kollude.stress            # full suite → eval/backtest/stress.json + backtests.json
    python -m kollude.stress --quick    # CI-sized
"""

from __future__ import annotations

import json
import math
import sys
import time
from typing import Any

import numpy as np
import pandas as pd

from kollude.attribution import wilson
from kollude.engine import ScanParams, scan
from kollude.frame import finalize, from_records

_VOCAB = np.array(
    [
        f"{a}{b}"
        for a in ("ka", "lo", "mi", "ne", "ru", "sa", "te", "vo", "zu", "pe", "da", "fi", "go", "hu", "ji", "wa")
        for b in ("rn", "lt", "ma", "so", "ki", "be", "ta", "xo", "pu", "de", "ly", "ng", "ck", "ve", "sh", "on")
    ]
    + ["the", "and", "agent", "token", "model", "task", "update", "today", "post", "think", "build", "ship"]
)
_MEMES = [
    "gm everyone hope your day goes well friends",
    "hello world this is my first post here on the network",
    "thanks for sharing this is really interesting to read",
    "what are you all working on this week tell me more",
]
T0 = pd.Timestamp("2026-01-01", tz="UTC")


def synth(
    n_events: int,
    *,
    n_bins: int = 336,
    onset: int | None = 220,
    swarm_share: float = 0.05,
    swarm_actors: int = 40,
    evasive: bool = False,
    seed: int = 0,
) -> tuple[pd.DataFrame, int | None]:
    """Organic chatter (diurnal, with recurring human memes) + optional swarm from ``onset`` on."""
    rng = np.random.default_rng(seed)
    hours = np.arange(n_bins)
    rate = 1.0 + 0.6 * np.sin(2 * np.pi * (hours % 24) / 24)
    n_org = n_events
    bins_org = rng.choice(n_bins, size=n_org, p=rate / rate.sum())
    n_users = max(50, n_events // 20)
    actors = rng.zipf(1.6, size=n_org) % n_users
    words = _VOCAB[rng.integers(0, len(_VOCAB), size=(n_org, 10))]
    text = pd.Series(words[:, 0])
    for j in range(1, 10):
        text = text.str.cat(pd.Series(words[:, j]), sep=" ")
    meme = rng.random(n_org) < 0.03
    text[meme] = np.array(_MEMES)[rng.integers(0, len(_MEMES), size=int(meme.sum()))]
    frames = [
        pd.DataFrame(
            {
                "t": T0 + pd.to_timedelta(bins_org * 3600 + rng.integers(0, 3600, size=n_org), unit="s"),
                "actor": pd.Series(actors).map(lambda a: f"u{a}"),
                "text": text,
                "label": 0.0,
            }
        )
    ]
    if onset is not None:
        per_bin = n_org / n_bins
        n_sw = int(per_bin * swarm_share / (1 - swarm_share) * (n_bins - onset))
        b = rng.integers(onset, n_bins, size=n_sw)
        amt = rng.integers(1, 10_000, size=n_sw)
        base = pd.Series(amt).map(lambda a: f"claim free airdrop now {a} tokens send to wallet and repost to friends")
        if evasive:
            lead = pd.Series(_VOCAB[rng.integers(0, len(_VOCAB), size=(n_sw, 2))].tolist()).map(" ".join)
            base = lead + " " + base
        frames.append(
            pd.DataFrame(
                {
                    "t": T0 + pd.to_timedelta(b * 3600 + rng.integers(0, 3600, size=n_sw), unit="s"),
                    "actor": pd.Series(rng.integers(0, swarm_actors, size=n_sw)).map(lambda a: f"bot{a}"),
                    "text": base,
                    "label": 1.0,
                }
            )
        )
    df = pd.concat(frames, ignore_index=True)
    df["event_id"] = [f"s:{i}" for i in range(len(df))]
    df["channel"] = "general"
    df["kind"] = "message"
    return finalize(df, sanitize=False), onset


def _detect(df: pd.DataFrame, onset: int | None, p: ScanParams) -> dict[str, Any]:
    t = time.perf_counter()
    r = scan(df, p)
    secs = time.perf_counter() - t
    alarms = [int((pd.Timestamp(a["t"]) - T0) / pd.Timedelta(hours=1)) for a in r.alarms]
    out: dict[str, Any] = {"events": len(df), "seconds": secs, "events_per_s": len(df) / max(secs, 1e-9), "n_alarms": len(alarms)}
    if onset is None:
        out["false_alarms"] = len(alarms)
        return out
    after = [a for a in alarms if a >= onset]
    out["detected"] = bool(after) and after[0] - onset <= 24
    out["delay_bins"] = (after[0] - onset) if after else None
    out["false_alarms_before_onset"] = len([a for a in alarms if a < onset])
    return out


def scale(sizes: list[int], p: ScanParams) -> list[dict[str, Any]]:
    rows = []
    for n in sizes:
        t = time.perf_counter()
        df, onset = synth(n, seed=n % 997)
        gen = time.perf_counter() - t
        r = _detect(df, onset, p)
        r["generate_s"] = gen
        r["frame_mb"] = float(df.memory_usage(deep=True).sum() / 1e6)
        rows.append(r)
        print(f"[stress] scale {len(df):>9,}: {r['seconds']:.1f}s ({r['events_per_s']:,.0f} ev/s) delay={r['delay_bins']} fa_pre={r['false_alarms_before_onset']}", file=sys.stderr)
    return rows


def power(shares: list[float], seeds: int, n_events: int, p: ScanParams, *, evasive: bool = False) -> list[dict[str, Any]]:
    rows = []
    for s in shares:
        res = [_detect(*synth(n_events, swarm_share=s, evasive=evasive, seed=1000 + k), p) for k in range(seeds)]
        hits = sum(r["detected"] for r in res)
        delays = [r["delay_bins"] for r in res if r["detected"]]
        fa = sum(r["false_alarms_before_onset"] for r in res)
        rows.append(
            {
                "swarm_share": s,
                "evasive": evasive,
                "seeds": seeds,
                "detection_rate": hits / seeds,
                "detection_ci": wilson(hits, seeds),
                "median_delay_bins": float(np.median(delays)) if delays else None,
                "false_alarms_before_onset_per_1000_bins": 1000 * fa / (seeds * 220),
            }
        )
        print(f"[stress] power share={s:.3f} evasive={evasive}: {hits}/{seeds} delay={rows[-1]['median_delay_bins']}", file=sys.stderr)
    return rows


def null_arm(seeds: int, n_events: int, p: ScanParams) -> dict[str, Any]:
    fa = sum(_detect(synth(n_events, onset=None, seed=5000 + k)[0], None, p)["false_alarms"] for k in range(seeds))
    bins = seeds * 336
    return {"seeds": seeds, "bins": bins, "false_alarms": fa, "per_1000_bins": 1000 * fa / bins, "bound_per_1000_bins": 1000 * p.alpha}


_HOSTILE: list[Any] = [
    {},
    {"text": None},
    {"actor": None, "text": "x"},
    {"actor": {"id": 7}, "text": {"nested": [1, 2, {"a": None}]}, "t": "2026-01-01T00:00:00Z"},
    {"actor": ["a", "b"], "text": ["list", "of", "parts"], "t": 1767225600},
    {"actor": 12345, "text": 3.14159, "t": "not a date"},
    {"actor": "a", "text": "🙂" * 10_000, "t": "2026-13-45"},
    {"actor": "a", "text": "\x00\x01\x02<script>alert(1)</script>", "t": "2026-01-01"},
    {"actor": "a", "text": "A" * 1_000_000, "t": "2026-01-01T01:00:00+05:30"},
    {"actor": "", "text": "", "t": ""},
    {"agent": "b", "content": "https://evil.example/" + "x" * 5000, "timestamp": "2026-01-02"},
    {"speaker": "c", "message": "ok", "created_at": float("nan")},
    {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
    {"user": "d", "body": "y", "ts": -1e18},
    {"name": "e", "msg": "z", "date": "1970-01-01"},
    {"actor": "f", "text": "z", "t": "9999-12-31T23:59:59Z"},
    {"actor": "g", "text": "z", "label": "not-a-number", "t": "2026-01-01"},
    {"actor": "h", "text": "z", "label": True, "t": "2026-01-01"},
    "not a dict",
    None,
    42,
    ["list", "row"],
]


def fuzz(rounds: int = 200, seed: int = 0) -> dict[str, Any]:
    """Random mixtures of hostile rows; every round must ingest and scan without raising."""
    rng = np.random.default_rng(seed)
    failures: list[str] = []
    for i in range(rounds):
        k = int(rng.integers(1, 60))
        rows = [_HOSTILE[j] for j in rng.integers(0, len(_HOSTILE), size=k)]
        try:
            df = from_records(rows)
            scan(df, ScanParams(warmup=2, min_actors=2))
        except Exception as e:
            failures.append(f"round {i}: {type(e).__name__}: {e}"[:300])
    for case in ([], [{}], [None], _HOSTILE):
        try:
            scan(from_records(case), ScanParams())
        except Exception as e:
            failures.append(f"edge {str(case)[:40]}: {type(e).__name__}: {e}"[:300])
    return {"rounds": rounds + 4, "failures": len(failures), "examples": failures[:10]}


def run(quick: bool = False) -> dict[str, Any]:
    p = ScanParams(freq="1h", min_actors=5, alpha=0.01, warmup=48, m_min=4.0)
    sizes = [10_000, 100_000] if quick else [10_000, 100_000, 500_000, 2_000_000]
    seeds = 4 if quick else 12
    n = 20_000 if quick else 50_000
    shares = [0.01, 0.03, 0.1] if quick else [0.005, 0.01, 0.02, 0.05, 0.1]
    out: dict[str, Any] = {
        "params": p.__dict__,
        "scale": scale(sizes, p),
        "power": power(shares, seeds, n, p),
        "evasion": power([0.05, 0.1], seeds, n, p, evasive=True),
        "null": null_arm(seeds, n, p),
        "ablation_per_bin_prefix_only": {
            "params": {"window": 1, "suffix": False},
            "power": power(shares, seeds, n, old := ScanParams(**{**p.__dict__, "window": 1, "suffix": False})),
            "evasion": power([0.05, 0.1], seeds, n, old, evasive=True),
            "null": null_arm(seeds, n, old),
        },
        "fuzz": fuzz(60 if quick else 300),
        "design": (
            "Organic: Zipf-active users, diurnal rate, random 10-word posts + 3% recurring human memes. "
            "Swarm: N bots posting one templated message with varying numbers from a known onset bin. "
            "Detected = first alarm within 24 bins of onset. Evasive = 2 random leading words per post."
        ),
    }
    return out


def _json_default(o: Any) -> Any:
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if math.isnan(o) else float(o)
    return str(o)


def main(argv: list[str] | None = None) -> None:
    from kollude import backtest

    argv = sys.argv[1:] if argv is None else argv
    res = run(quick="--quick" in argv)
    backtest.OUT.mkdir(parents=True, exist_ok=True)
    (backtest.OUT / "stress.json").write_text(json.dumps(res, indent=2, default=_json_default), encoding="utf-8")
    merged = json.loads(backtest.UI.read_text(encoding="utf-8")) if backtest.UI.exists() else {}
    merged["stress"] = json.loads(json.dumps(res, default=_json_default))
    merged["updated_at"] = pd.Timestamp.now(tz="UTC").isoformat()
    backtest.UI.write_text(json.dumps(merged, default=_json_default), encoding="utf-8")
    backtest.write_report(merged)
    print(json.dumps({"fuzz_failures": res["fuzz"]["failures"], "null_per_1000": res["null"]["per_1000_bins"]}))


if __name__ == "__main__":
    main()
