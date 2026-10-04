"""Dataset registry + loaders. Everything streams or reads columnar; nothing bulk-downloads media.

Local files live under ``data/`` (gitignored). ``pz datasets fetch <id>`` pulls the public ones.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from kollude.frame import empty_frame, finalize, from_records
from kollude.paths import data_dir

DATA = data_dir()
CACHE = DATA / "cache"


@dataclass
class DatasetInfo:
    id: str
    title: str
    description: str
    url: str
    license: str
    labels: str
    files: list[str]
    landmarks: list[dict[str, str]] = field(default_factory=list)
    defaults: dict[str, Any] = field(default_factory=dict)
    requires_token: bool = False
    size_hint: str = ""

    def local_paths(self) -> list[Path]:
        return [DATA / f for f in self.files]

    def available(self) -> bool:
        return all(p.exists() for p in self.local_paths())

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["available"] = self.available()
        d["local_bytes"] = sum(p.stat().st_size for p in self.local_paths() if p.exists())
        return d


REGISTRY: dict[str, DatasetInfo] = {
    "synthetic": DatasetInfo(
        id="synthetic",
        title="Synthetic swarm (known onset, no download)",
        description="Organic chatter plus a bot swarm that starts copying one airdrop template at a known hour. "
        "Same stream as `kollude demo`. Labels are the generator's, for the synthetic backtest only.",
        url="",
        license="generated in-process",
        labels="1 = injected swarm post, 0 = organic (generator ground truth)",
        files=[],
        landmarks=[{"t": "2026-01-10T04:00:00Z", "label": "Injected swarm onset (ground truth)", "kind": "ground_truth"}],
        defaults={"freq": "1h", "min_actors": 5, "alpha": 0.01, "warmup": 24, "m_min": 4.0},
        size_hint="generated, ~12k events",
    ),
    "moltbook": DatasetInfo(
        id="moltbook",
        title="Moltbook — AI-agent social network (Jan–Feb 2026)",
        description="Reddit-style platform populated only by LLM agents. Jan 27 launch → mbc-20 token-mint bot wave "
        "(Feb 6–17, ~29.5k agents) → platform anti-spam enforcement (Feb 17–18).",
        url="https://huggingface.co/datasets/jscmp4/Moltbook",
        license="see dataset card",
        labels="per-post platform `is_spam` flag (valid before 2026-05-06)",
        files=["moltbook/parquet/posts/2026-01.parquet", "moltbook/parquet/posts/2026-02.parquet"],
        landmarks=[
            {"t": "2026-01-27T00:00:00Z", "label": "Platform launch", "kind": "context"},
            {"t": "2026-02-06T00:00:00Z", "label": "mbc-20 bot wave begins", "kind": "ground_truth"},
            {"t": "2026-02-17T00:00:00Z", "label": "Anti-spam enforcement", "kind": "intervention"},
        ],
        defaults={"freq": "1h", "min_actors": 5, "alpha": 0.01, "warmup": 48, "m_min": 5.0},
        size_hint="330 MB parquet, 1.75M posts",
    ),
    "wiki": DatasetInfo(
        id="wiki",
        title="collusion.wiki — German wiki agent-swarm incident",
        description="Public revision dump of the wiki the 2026 agent swarm wrote to (May–Jul 2026).",
        url="https://collusion.wiki",
        license="public dump",
        labels="human landmark dates only (no per-edit labels)",
        files=["wiki/revisions.jsonl.gz"],
        landmarks=[
            {"t": "2026-06-02T00:00:00Z", "label": "Moderator notices spam", "kind": "human"},
            {"t": "2026-06-16T00:00:00Z", "label": "Mass coordination begins", "kind": "ground_truth"},
            {"t": "2026-06-21T00:00:00Z", "label": "OpenAI-HQ IPs appear", "kind": "human"},
        ],
        defaults={"freq": "1h", "min_actors": 5, "alpha": 0.01, "warmup": 48, "m_min": 3.0},
        size_hint="3 MB gz, ~14.6k revisions",
    ),
    "village": DatasetInfo(
        id="village",
        title="AI Village transcript (aidigestorg/ai-village)",
        description="404 days of multi-agent chat/actions from the AI Village (gated HF dataset, text only).",
        url="https://huggingface.co/datasets/aidigestorg/ai-village",
        license="gated — inference only, no re-identification",
        labels="none (unlabelled; investigation only)",
        files=["aivillage/village-transcript.json"],
        defaults={"freq": "1h", "min_actors": 3, "alpha": 0.01, "warmup": 48, "m_min": 3.0},
        requires_token=True,
        size_hint="362 MB json, ~375k events",
    ),
    "forge": DatasetInfo(
        id="forge",
        title="FORGE ep001 — labelled wind-tunnel episode",
        description="Air-gapped rule-based swarm shipped in the repo, with known planted facts. Synthetic agents, not a downloaded corpus.",
        url="",
        license="generated in-repo",
        labels="episode truth is in forge/fixtures/ep001/truth.json (not fed to the detector)",
        files=[],
        landmarks=[{"t": "2026-06-16T12:00:00Z", "label": "FORGE episode start", "kind": "context"}],
        defaults={"freq": "1h", "min_actors": 3, "alpha": 0.01, "warmup": 1, "m_min": 3.0},
        size_hint="in repo, ~900 events",
    ),
    "whowhen": DatasetInfo(
        id="whowhen",
        title="Who&When — multi-agent failure attribution (ICML 2025)",
        description="184 failed multi-agent tasks (CaptainAgent + Magentic-One) annotated with the responsible "
        "agent and decisive error step.",
        url="https://huggingface.co/datasets/Kevin355/Who_and_When",
        license="see dataset card",
        labels="responsible agent + decisive step per task",
        files=["whowhen/Algorithm-Generated.parquet", "whowhen/Hand-Crafted.parquet"],
        size_hint="2 MB parquet",
    ),
}


def list_datasets() -> list[dict[str, Any]]:
    return [d.as_dict() for d in REGISTRY.values()]


def fetch(dataset_id: str) -> list[Path]:
    """Download a registered public dataset into ``data/`` (never media / screenshots).

    ``synthetic`` only writes the local demo fixtures; it does not touch the network.
    """
    if dataset_id == "synthetic":
        from kollude.demo_data import ensure

        return list(ensure().values())
    from huggingface_hub import hf_hub_download

    info = REGISTRY[dataset_id]
    out: list[Path] = []
    if dataset_id == "moltbook":
        for f in info.files:
            rel = f.removeprefix("moltbook/")
            out.append(Path(hf_hub_download("jscmp4/Moltbook", rel, repo_type="dataset", local_dir=DATA / "moltbook")))
    elif dataset_id == "whowhen":
        for f in info.files:
            rel = f.removeprefix("whowhen/")
            out.append(Path(hf_hub_download("Kevin355/Who_and_When", rel, repo_type="dataset", local_dir=DATA / "whowhen")))
    elif dataset_id == "village":
        out.append(
            Path(
                hf_hub_download(
                    "aidigestorg/ai-village",
                    "village-transcript.json",
                    repo_type="dataset",
                    local_dir=DATA / "aivillage",
                    token=os.environ.get("HF_TOKEN"),
                )
            )
        )
    elif dataset_id == "wiki":
        import httpx

        dest = DATA / "wiki" / "revisions.jsonl.gz"
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = httpx.get("https://collusion.wiki/explorer/download/revisions.jsonl.gz", follow_redirects=True, timeout=120)
        r.raise_for_status()
        dest.write_bytes(r.content)
        out.append(dest)
    return out


def _cached(name: str, build) -> pd.DataFrame:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}.parquet"
    if path.exists():
        df = pd.read_parquet(path)
        df["t"] = pd.to_datetime(df["t"], utc=True)
        return df
    df = build()
    df.to_parquet(path, index=False)
    return df


def load_moltbook(
    *,
    months: list[str] | None = None,
    max_rows: int | None = None,
    start: str | None = None,
    end: str | None = None,
) -> pd.DataFrame:
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    info = REGISTRY["moltbook"]
    paths = [p for p in info.local_paths() if p.exists() and (not months or any(m in p.name for m in months))]
    t0 = pd.Timestamp(start, tz="UTC") if start else None
    t1 = pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1) if end else None
    frames = []
    kept = 0
    # Streamed by row group. A start/end window is applied per batch so a wave
    # slice never materialises the 1.7M-post table (that path peaked above 3 GB).
    for path in paths:
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=200_000, columns=["id", "title", "content", "author_id", "submolt", "is_spam", "created_at"]):
            if t0 is not None or t1 is not None:
                stamps = pd.to_datetime(batch.column("created_at").to_pandas(), utc=True, errors="coerce")
                keep = np.ones(len(stamps), dtype=bool)
                if t0 is not None:
                    keep &= stamps >= t0
                if t1 is not None:
                    keep &= stamps < t1
                idx = np.flatnonzero(keep)
                if max_rows is not None:
                    idx = idx[: max(0, max_rows - kept)]
                if len(idx) == 0:
                    del batch, stamps
                    continue
                batch = batch.take(idx)
                del stamps
            elif max_rows is not None and kept >= max_rows:
                break
            title = pc.fill_null(batch.column("title"), "")
            content = pc.utf8_slice_codeunits(pc.fill_null(batch.column("content"), ""), 0, 400)
            text = pc.binary_join_element_wise(title, content, "\n")
            frames.append(
                pd.DataFrame(
                    {
                        "event_id": pc.binary_join_element_wise("moltbook", batch.column("id"), ":").to_pandas(),
                        "t": batch.column("created_at").to_pandas(),
                        "actor": batch.column("author_id").to_pandas(),
                        "text": text.to_pandas(),
                        "channel": pc.struct_field(batch.column("submolt"), "name").to_pandas(),
                        "kind": "message",
                        "label": batch.column("is_spam").to_pandas().astype("float64"),
                    }
                )
            )
            kept += len(frames[-1])
            del batch, title, content, text
            if max_rows is not None and kept >= max_rows:
                break
        if max_rows is not None and kept >= max_rows:
            break
    if not frames:
        return empty_frame()
    df = pd.concat(frames, ignore_index=True)
    del frames
    if max_rows:
        df = df.sort_values("t").head(max_rows)
    return finalize(df, max_chars=600, sanitize=True)


def load_wiki() -> pd.DataFrame:
    def build() -> pd.DataFrame:
        from kollude.wiki import load_revisions

        return from_records(load_revisions(DATA / "wiki" / "revisions.jsonl.gz"), source="wiki", max_chars=1500)

    return _cached("wiki_sef", build)


def load_village(*, start: str | None = None, end: str | None = None) -> pd.DataFrame:
    def build() -> pd.DataFrame:
        from kollude.village import iter_day_rows, iter_transcript_days

        rows: list[dict[str, Any]] = []
        for day in iter_transcript_days(DATA / "aivillage" / "village-transcript.json"):
            rows.extend(iter_day_rows(day, max_chars=1500))
        return from_records(
            [
                {"id": r["id"], "actor": r["agent"], "t": r["timestamp"], "text": r["text"], "channel": r["channel"], "kind": r["kind"]}
                for r in rows
            ],
            source="village",
            max_chars=1500,
        )

    df = _cached("village_all", build)
    if start:
        df = df[df["t"] >= pd.Timestamp(start, tz="UTC")]
    if end:
        df = df[df["t"] < pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)]
    return df.reset_index(drop=True)


def load(
    dataset_id: str,
    *,
    start: str | None = None,
    end: str | None = None,
    max_rows: int | None = None,
    allow_full: bool = False,
) -> pd.DataFrame:
    if dataset_id == "moltbook" and not (start or end or max_rows or allow_full):
        raise ValueError(
            "Moltbook is 1.7M posts. Pass start and end (wave window 2026-02-03 to 2026-02-09) "
            "or max_rows. The full labelled backtest is already computed; CLI --all loads the corpus."
        )
    if dataset_id == "whowhen":
        raise KeyError("Who&When is a failure-attribution set. Use the Blame panel or `kollude attribute`, not scan.")
    if dataset_id == "synthetic":
        from kollude.demo_data import frame

        df, _ = frame()
    elif dataset_id == "moltbook":
        df = load_moltbook(start=start, end=end, max_rows=max_rows)
    elif dataset_id == "wiki":
        df = load_wiki()
    elif dataset_id == "village":
        df = load_village(start=start, end=end)
    elif dataset_id == "forge":
        import json

        raw = json.loads((Path(__file__).resolve().parent / "bundled" / "ep001.json").read_text(encoding="utf-8"))
        df = from_records(
            [{"id": e["event_id"], "actor": e["actor"], "t": e["t"], "text": e.get("text") or "", "channel": e.get("channel"), "kind": e.get("kind")} for e in raw],
            source="forge",
        )
    else:
        raise KeyError(f"unknown or non-stream dataset: {dataset_id}")
    if start and dataset_id != "village":
        df = df[df["t"] >= pd.Timestamp(start, tz="UTC")]
    if end and dataset_id != "village":
        df = df[df["t"] < pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)]
    if max_rows:
        df = df.head(max_rows)
    return df.reset_index(drop=True)
