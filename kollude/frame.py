"""Columnar event frame — the fast path for million-event streams.

Every adapter produces the same pandas frame:

    event_id  str
    t         datetime64[ns, UTC]
    actor     str | None
    text      str            (sanitized, truncated)
    channel   str | None
    kind      str
    label     float | NaN    optional ground-truth (e.g. Moltbook ``is_spam``)

Dataset text is untrusted: it is sanitized on ingest and never executed or rendered as HTML.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from kollude.sanitize import sanitize_text

COLUMNS = ["event_id", "t", "actor", "text", "channel", "kind", "label"]

_ACTOR_KEYS = ("actor", "agent", "author", "author_id", "speaker", "user", "name", "role", "sender")
_TEXT_KEYS = ("text", "content", "message", "body", "msg", "output")
_TIME_KEYS = ("t", "timestamp", "time", "created_at", "ts", "date")
_CHANNEL_KEYS = ("channel", "room", "thread", "page", "submolt", "conversation_id")


def empty_frame() -> pd.DataFrame:
    df = pd.DataFrame({c: pd.Series(dtype="object") for c in COLUMNS})
    df["t"] = pd.to_datetime(df["t"], utc=True)
    df["label"] = df["label"].astype("float64")
    return df


def _pick(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for k in keys:
        v = row.get(k)
        if v is not None and v != "":
            return v
    return None


def _flatten_actor(v: Any) -> Any:
    if isinstance(v, dict):
        return v.get("id") or v.get("name")
    return v


def finalize(df: pd.DataFrame, *, max_chars: int = 2000, sanitize: bool = True) -> pd.DataFrame:
    """Coerce any partially-filled frame to the canonical schema, sorted by time."""
    for c in COLUMNS:
        if c not in df.columns:
            df[c] = np.nan if c == "label" else None
    df = df[COLUMNS].copy()
    df["t"] = pd.to_datetime(df["t"], utc=True, errors="coerce", format="mixed")
    df = df[df["t"].notna()]
    actor = df["actor"].astype("string").str.strip()
    df["actor"] = actor.where(actor.notna() & (actor != ""), None).astype("object")
    text = df["text"].astype("string").fillna("")
    if sanitize:
        text = text.str.slice(0, max_chars + 200)
        text = text.str.replace(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", regex=True)
        text = text.str.replace(r"https?://[^\s<>\"']+", "[URL]", regex=True)
        text = text.str.replace(r"[A-Za-z0-9+/]{200,}={0,2}", "[BLOB]", regex=True)
    df["text"] = text.str.slice(0, max_chars).astype("object")
    df["label"] = pd.to_numeric(df["label"], errors="coerce").astype("float64")
    df["kind"] = df["kind"].fillna("message").astype("object")
    ids = df["event_id"].astype("string")
    missing = ids.isna() | (ids == "")
    if missing.any():
        ids = ids.where(~missing, pd.Series([f"ev:{i}" for i in range(len(df))], index=df.index))
    df["event_id"] = ids.astype("object")
    return df.sort_values("t", kind="stable").reset_index(drop=True)


def from_records(rows: Iterable[dict[str, Any]], *, source: str = "ext", max_chars: int = 2000) -> pd.DataFrame:
    """Flexible dict rows → frame. Accepts most agent-log shapes (OpenAI chat, JSONL logs, …)."""
    out: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        text = _pick(r, _TEXT_KEYS)
        actor = _flatten_actor(_pick(r, _ACTOR_KEYS))
        if text is None and actor is None:
            continue
        if isinstance(text, (list, dict)):
            text = json.dumps(text, ensure_ascii=False, default=str)[:max_chars]
        out.append(
            {
                "event_id": f"{source}:{r.get('id') or r.get('event_id') or i}",
                "t": _pick(r, _TIME_KEYS),
                "actor": actor,
                "text": text,
                "channel": _flatten_actor(_pick(r, _CHANNEL_KEYS)),
                "kind": r.get("kind") or r.get("type") or "message",
                "label": r.get("label"),
            }
        )
    if not out:
        return empty_frame()
    df = pd.DataFrame(out)
    # Logs without timestamps: keep order, space events 1s apart from epoch-ish anchor.
    if df["t"].isna().all():
        df["t"] = pd.Timestamp("2026-01-01", tz="UTC") + pd.to_timedelta(np.arange(len(df)), unit="s")
    return finalize(df, max_chars=max_chars)


def from_sef(events: Iterable[Any]) -> pd.DataFrame:
    rows = [
        {
            "event_id": e.event_id,
            "t": e.t,
            "actor": e.actor,
            "text": e.text or "",
            "channel": e.channel,
            "kind": e.kind.value if hasattr(e.kind, "value") else str(e.kind),
            "label": (e.payload or {}).get("label") if isinstance(e.payload, dict) else None,
        }
        for e in events
    ]
    if not rows:
        return empty_frame()
    return finalize(pd.DataFrame(rows), sanitize=False)


def read_any(path: Path | str, *, max_rows: int | None = None, max_chars: int = 2000) -> pd.DataFrame:
    """Read JSONL / JSON / CSV / Parquet agent logs into a frame."""
    p = Path(path)
    suf = "".join(p.suffixes).lower()
    if suf.endswith(".parquet"):
        raw = pd.read_parquet(p)
        if max_rows:
            raw = raw.head(max_rows)
        return from_records(raw.to_dict(orient="records"), source=p.stem, max_chars=max_chars)
    if suf.endswith(".csv"):
        raw = pd.read_csv(p, nrows=max_rows)
        return from_records(raw.to_dict(orient="records"), source=p.stem, max_chars=max_chars)
    if suf.endswith((".jsonl", ".ndjson", ".jsonl.gz")):
        import gzip

        opener = gzip.open if suf.endswith(".gz") else open
        rows: list[dict[str, Any]] = []
        with opener(p, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if max_rows and len(rows) >= max_rows:
                    break
        return from_records(rows, source=p.stem, max_chars=max_chars)
    data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
    if isinstance(data, dict):
        for key in ("events", "messages", "history", "data", "rows"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise TypeError(f"{p}: expected a list of events")
    return from_records(data[:max_rows] if max_rows else data, source=p.stem, max_chars=max_chars)


def sample_text(text: str | None, n: int = 280) -> str:
    """Display-safe excerpt (sanitized again; never HTML)."""
    return sanitize_text(text or "", max_chars=n) or ""
