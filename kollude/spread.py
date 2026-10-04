"""Who carried a repeated template, and how fast it reached other actors.

A template is the folded text (digits, URLs, and punctuation collapsed). The seeder is the
first actor to post it. Hours-to-spread is the time until ``min_actors`` distinct actors
have used it. That is the spread of a shared line, not a claim about hidden channels.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from kollude import coord
from kollude.coord import CoordParams
from kollude.frame import sample_text


def trace_spread(df: pd.DataFrame, params: CoordParams | None = None, *, top: int = 12) -> list[dict[str, Any]]:
    p = params or CoordParams()
    if df.empty:
        return []
    ann = coord.annotate(df, p)
    named = ann[ann["actor"].notna() & ann["tid"].notna()]
    rows: list[dict[str, Any]] = []
    for tid, group in named.groupby("tid", sort=False):
        first_seen = group.groupby("actor")["t"].min().sort_values()
        if len(first_seen) < p.min_actors:
            continue
        t0 = first_seen.iloc[0]
        reached = first_seen.iloc[p.min_actors - 1]
        hours = (reached - t0).total_seconds() / 3600.0
        channels = group["channel"].dropna()
        channel = None if channels.empty else str(channels.mode().iloc[0])
        rows.append(
            {
                "tid": str(tid),
                "template": sample_text(str(group["tmpl"].iloc[0]), 80),
                "channel": channel,
                "seeder": str(first_seen.index[0]),
                "t0": pd.Timestamp(t0).isoformat(),
                "hours_to_min_actors": float(hours),
                "n_actors": len(first_seen),
                "n_events": len(group),
                "carriers": [str(actor) for actor in first_seen.index[:12]],
            }
        )
    rows.sort(key=lambda row: (-row["n_actors"], row["hours_to_min_actors"]))
    return rows[:top]
