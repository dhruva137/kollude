"""Where an installed copy reads data and writes reports."""

from __future__ import annotations

import os
from pathlib import Path


def checkout_root() -> Path | None:
    here = Path(__file__).resolve().parents[1]
    if (here / "pyproject.toml").exists():
        return here
    return None


def home_dir() -> Path:
    env = os.environ.get("KOLLUDE_HOME")
    if env:
        return Path(env)
    root = checkout_root()
    if root is not None:
        return root
    return Path.home() / ".kollude"


def data_dir() -> Path:
    env = os.environ.get("KOLLUDE_DATA")
    if env:
        return Path(env)
    return home_dir() / "data"


def web_dist() -> Path:
    """Built console. A checkout keeps it at ``web/dist``; a container can set the working directory there."""
    candidates: list[Path] = []
    root = checkout_root()
    if root is not None:
        candidates.append(root / "web" / "dist")
    candidates.append(Path.cwd() / "web" / "dist")
    candidates.append(home_dir() / "web" / "dist")
    for path in candidates:
        if (path / "index.html").is_file():
            return path
    return candidates[0]
