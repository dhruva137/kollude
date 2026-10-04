"""collusion.wiki revision dump → event rows. Text is data. It is never executed."""

from __future__ import annotations

import difflib
import gzip
import json
from pathlib import Path
from typing import Any

from kollude.sanitize import sanitize_text


def inserted_spans(prev: str, curr: str) -> list[str]:
    matcher = difflib.SequenceMatcher(a=prev or "", b=curr or "")
    spans: list[str] = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in ("insert", "replace") and j2 > j1:
            chunk = curr[j1:j2].strip()
            if chunk:
                spans.append(chunk)
    return spans


def load_revisions(path: Path | str) -> list[dict[str, Any]]:
    path = Path(path)
    opener = gzip.open if str(path).endswith(".gz") else open
    rows: list[dict[str, Any]] = []
    prev_by_page: dict[str, str] = {}
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        for i, line in enumerate(handle):
            line = line.strip()
            if not line:
                continue
            try:
                rev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rev, dict):
                continue
            page = str(rev.get("page_key") or rev.get("page_id") or rev.get("name") or "page")
            body = str(rev.get("body") or rev.get("text") or rev.get("content") or "")
            spans = inserted_spans(prev_by_page.get(page, ""), body)
            text = "\n".join(spans) if spans else body[:500]
            author = rev.get("label") or rev.get("name") or rev.get("author") or ""
            rows.append(
                {
                    "id": str(rev.get("rev_id") or rev.get("id") or f"rev{i}"),
                    "actor": str(author).strip() or None,
                    "t": rev.get("time") or rev.get("timestamp") or rev.get("created_at"),
                    "text": sanitize_text(text, max_chars=4000) or "",
                    "channel": page,
                    "kind": "revision",
                }
            )
            prev_by_page[page] = body
    return rows
