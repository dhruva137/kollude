"""Synthetic swarm used by every CLI command that does not need a downloaded corpus.

``kollude demo`` writes three files under ``kollude/fixtures/`` (gitignored):

* ``swarm.jsonl`` — a log you can ``scan``, ``dossier``, or ``watch``
* ``feed.json`` — the same events as a public JSON feed for ``watch-url``
* ``failure.json`` — one failed multi-agent run for ``attribute``

The dataset id ``synthetic`` generates the same swarm in memory (no file required).
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

FIXTURES = Path(__file__).resolve().parent / "fixtures"
N_EVENTS = 12_000
SEED = 5
SWARM_SHARE = 0.08
T0 = pd.Timestamp("2026-01-01", tz="UTC")
ONSET_BIN = 220  # hours after T0; must match stress.synth's default onset

FAILURE = {
    "question": "What is 17 times 23?",
    "history": [
        {
            "name": "worker",
            "content": "Error: exception, failed, could not compute. I will proceed with a placeholder. Let's assume the answer is 999.",
        },
        {"name": "planner", "content": "Plan: ask the worker to compute 17 times 23."},
        {"name": "checker", "content": "Looks good to me."},
    ],
}

_CACHE: tuple[pd.DataFrame, int] | None = None


def onset_time() -> pd.Timestamp:
    return T0 + pd.Timedelta(hours=ONSET_BIN)


def frame() -> tuple[pd.DataFrame, int]:
    """Organic chatter plus a bot swarm with a known onset. Cached for the process."""
    global _CACHE
    if _CACHE is None:
        from kollude.stress import synth

        df, onset = synth(N_EVENTS, onset=ONSET_BIN, swarm_share=SWARM_SHARE, seed=SEED)
        _CACHE = (df, int(onset if onset is not None else ONSET_BIN))
    df, onset = _CACHE
    return df.copy(), onset


def ensure() -> dict[str, Path]:
    """Write the three fixture files. Safe to call more than once."""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    df, _ = frame()
    jsonl = FIXTURES / "swarm.jsonl"
    feed = FIXTURES / "feed.json"
    failure = FIXTURES / "failure.json"
    posts = []
    lines = []
    for i, r in enumerate(df.itertuples(index=False)):
        row = {
            "id": str(i),
            "actor": r.actor,
            "text": r.text,
            "t": pd.Timestamp(r.t).isoformat(),
            "channel": getattr(r, "channel", "general"),
            "label": float(r.label) if r.label == r.label else None,
        }
        lines.append(json.dumps(row, ensure_ascii=False))
        posts.append(row)
    jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")
    feed.write_text(json.dumps({"posts": posts}), encoding="utf-8")
    failure.write_text(json.dumps(FAILURE, indent=2), encoding="utf-8")
    return {"swarm": jsonl, "feed": feed, "failure": failure}


COMMANDS = """
After `pip install kollude` (or `uv run kollude` from a checkout):

  kollude demo
  kollude datasets list
  kollude scan synthetic
  kollude spread synthetic
  kollude dossier synthetic
  kollude scan kollude/fixtures/swarm.jsonl
  kollude attribute kollude/fixtures/failure.json
  kollude watch kollude/fixtures/swarm.jsonl
  kollude backtest synthetic
  kollude stress --quick
  kollude serve

watch-url needs something to poll. In a second terminal (8877, not 8765 — that port is often already in use):

  python -m http.server 8877 --directory kollude/fixtures

and in the first:

  kollude watch-url http://127.0.0.1:8877/feed.json --interval 2

Ctrl+C stops watch, watch-url, and serve. mcp waits on stdin for an agent:

  kollude mcp
""".strip()
