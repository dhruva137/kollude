"""Sanitize untrusted Village / wiki text before any analysis.

Never execute, eval, render HTML, or follow URLs from dataset content.
"""

from __future__ import annotations

import re
import unicodedata

# Control chars except tab/newline
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# Extremely long base64-looking blobs already marked, but also catch leftovers
_BLOBBY = re.compile(r"(?:[A-Za-z0-9+/]{200,}={0,2})")
_URL = re.compile(r"https?://[^\s<>\"']+")


def sanitize_text(text: str | None, *, max_chars: int = 4000) -> str | None:
    if text is None:
        return None
    s = str(text)
    s = unicodedata.normalize("NFKC", s)
    s = _CTRL.sub("", s)
    # Keep URL strings as opaque tokens — do not fetch
    s = _URL.sub("[URL]", s)
    s = _BLOBBY.sub("[BLOB]", s)
    s = s.replace("\x00", "")
    if len(s) > max_chars:
        s = s[: max_chars - 20] + "…[truncated]"
    return s


def lookalike_fold(text: str) -> str:
    """Fold common Cyrillic look-alikes used as handle evasion (display only)."""
    table = str.maketrans(
        {
            "а": "a",
            "е": "e",
            "о": "o",
            "р": "p",
            "с": "c",
            "у": "y",
            "х": "x",
            "і": "i",
            "А": "A",
            "Е": "E",
            "О": "O",
            "Р": "P",
            "С": "C",
            "У": "Y",
            "Х": "X",
        }
    )
    return text.translate(table)
