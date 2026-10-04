"""Stream an AI Village transcript day by day. Screenshots are never read."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import ijson

from kollude.sanitize import sanitize_text

_KIND = {
    "AGENT_TALK": "message",
    "USER_TALK": "message",
    "CONSOLIDATE": "memory",
    "START_USING_COMPUTER": "action",
    "STOP_USING_COMPUTER": "summary",
    "SEARCH_HISTORY": "observation",
    "WAIT": "observation",
    "PAUSE": "observation",
}


def iter_transcript_days(path: Path | str) -> Iterator[dict[str, Any]]:
    with Path(path).open("rb") as handle:
        yield from ijson.items(handle, "days.item")


def iter_day_rows(day: dict[str, Any], *, max_chars: int = 1500) -> Iterator[dict[str, Any]]:
    day_n = day.get("day")
    day_date = day.get("date")
    for i, ev in enumerate(day.get("events") or []):
        if not isinstance(ev, dict):
            continue
        etype = str(ev.get("type") or ev.get("actionType") or "")
        if etype == "USER_TALK":
            continue
        text = ev.get("content") or ev.get("summary") or ev.get("sessionGoal") or ev.get("query") or ev.get("thinking")
        text = sanitize_text(text, max_chars=max_chars)
        if not text:
            continue
        speaker = ev.get("speakerName") or ev.get("agentName") or ev.get("speaker") or ev.get("agentId")
        native = str(ev.get("id") or ev.get("messageId") or f"d{day_n}-e{i}")
        yield {
            "id": native,
            "agent": speaker,
            "timestamp": ev.get("timestamp") or ev.get("created_at"),
            "text": text,
            "channel": ev.get("roomId") or ev.get("room") or f"day-{day_date}",
            "kind": _KIND.get(etype, "message"),
        }
