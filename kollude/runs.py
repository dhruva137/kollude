"""In-process run store shared by the HTTP server, MCP server and CLI.

A *run* is a batch scan (dataset / file / posted events). A *monitor* is a live session that
ingests events incrementally (HTTP push or file tail) and emits ticks as bins close.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from kollude import coord, datasets
from kollude.engine import ScanParams, _iso, _records, explain_bin, scan_iter
from kollude.frame import from_records, read_any, sample_text
from kollude.stream import EDetector, finite

_FRAME_CACHE: dict[str, pd.DataFrame] = {}
_CACHE_LOCK = threading.Lock()


def load_dataset_cached(dataset_id: str) -> pd.DataFrame:
    with _CACHE_LOCK:
        if dataset_id not in _FRAME_CACHE:
            _FRAME_CACHE[dataset_id] = datasets.load(dataset_id)
        return _FRAME_CACHE[dataset_id]


@dataclass
class Run:
    id: str
    kind: str
    source: str
    params: ScanParams
    status: str = "queued"
    created: float = field(default_factory=time.time)
    events: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    ann: pd.DataFrame | None = None
    landmarks: list[dict[str, str]] = field(default_factory=list)
    cond: threading.Condition = field(default_factory=threading.Condition)

    def push(self, ev: dict[str, Any]) -> None:
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def brief(self) -> dict[str, Any]:
        s = (self.result or {}).get("summary") or {}
        return {
            "id": self.id,
            "kind": self.kind,
            "source": self.source,
            "status": self.status,
            "created": self.created,
            "n_events": s.get("n_events"),
            "n_alarms": s.get("n_alarms"),
            "error": self.error,
        }


class RunStore:
    def __init__(self, max_runs: int = 24) -> None:
        self.runs: dict[str, Run] = {}
        self.monitors: dict[str, Monitor] = {}
        self.max_runs = max_runs
        self.lock = threading.Lock()

    # ------------------------------------------------------------ batch runs

    def start(
        self,
        *,
        dataset: str | None = None,
        path: str | None = None,
        events: list[dict[str, Any]] | None = None,
        start: str | None = None,
        end: str | None = None,
        max_rows: int | None = None,
        params: dict[str, Any] | None = None,
        allow_full: bool = False,
        background: bool = True,
    ) -> Run:
        defaults = datasets.REGISTRY[dataset].defaults if dataset in datasets.REGISTRY else {}
        p = ScanParams.from_dict({**defaults, **(params or {})})
        source = dataset or path or "posted-events"
        run = Run(id=uuid.uuid4().hex[:10], kind="dataset" if dataset else ("file" if path else "events"), source=source, params=p)
        if dataset in datasets.REGISTRY:
            run.landmarks = datasets.REGISTRY[dataset].landmarks
        with self.lock:
            self.runs[run.id] = run
            while len(self.runs) > self.max_runs:
                self.runs.pop(next(iter(self.runs)))

        def work() -> None:
            try:
                run.status = "loading"
                t0 = time.perf_counter()
                run.push({"type": "stage", "name": "loading", "source": source})
                if dataset:
                    # Windowed load: Moltbook must not be materialised in full just to slice a week.
                    df = datasets.load(dataset, start=start, end=end, max_rows=max_rows, allow_full=allow_full)
                elif path:
                    df = read_any(path, max_rows=max_rows)
                else:
                    df = from_records(events or [], source="posted")
                if max_rows:
                    df = df.head(max_rows)
                df = df.reset_index(drop=True)
                run.push({"type": "stage", "name": "loaded", "seconds": time.perf_counter() - t0, "n_events": len(df), "landmarks": run.landmarks})
                run.status = "running"
                run.ann = coord.annotate(df, p.coord())
                for ev in scan_iter(df, p, ann=run.ann):
                    if ev["type"] == "result":
                        run.result = ev["result"]
                        run.result["landmarks"] = run.landmarks
                        run.result["source"] = source
                        run.push({"type": "done", "summary": run.result["summary"], "timings": run.result["timings"]})
                    else:
                        run.push(ev)
                run.status = "done"
            except Exception as e:
                run.status = "error"
                run.error = f"{type(e).__name__}: {e}"
                run.push({"type": "error", "error": run.error})

        if background:
            threading.Thread(target=work, daemon=True).start()
        else:
            work()
        return run

    def get(self, run_id: str) -> Run:
        return self.runs[run_id]

    # ------------------------------------------------------------ drill-down

    @staticmethod
    def cluster_events(run: Run, tid: str, limit: int = 60) -> dict[str, Any]:
        ann = run.ann
        if ann is None:
            return {"events": []}
        sub = ann[ann["tid"] == tid].sort_values("t")
        actors = sub["actor"].value_counts().head(25)
        rows = [
            {"t": _iso(r.t), "actor": r.actor, "text": sample_text(r.text, 300), "label": finite(r.label), "channel": r.channel}
            for r in sub.head(limit).itertuples()
        ]
        hourly = sub.groupby(sub["t"].dt.floor("1h")).size()
        return {
            "tid": tid,
            "template": sub["tmpl"].iloc[0] if len(sub) else None,
            "n_events": len(sub),
            "n_actors": int(sub["actor"].nunique()),
            "label_rate": finite(sub["label"].mean()) if len(sub) else None,
            "top_actors": [{"actor": a, "n": int(n)} for a, n in actors.items()],
            "hourly": [{"t": _iso(t), "n": int(n)} for t, n in hourly.items()],
            "events": rows,
        }

    @staticmethod
    def actor_profile(run: Run, actor: str, limit: int = 200) -> dict[str, Any]:
        ann = run.ann
        if ann is None:
            return {"events": []}
        sub = ann[ann["actor"] == actor].sort_values("t")
        ta = ann[ann["tid"].isin(sub["tid"].dropna().unique())].groupby("tid")["actor"].nunique()
        coord_tids = set(ta[ta >= run.params.min_actors].index)
        rows = [
            {
                "t": _iso(r.t),
                "text": sample_text(r.text, 300),
                "tid": r.tid,
                "coordinated": r.tid in coord_tids,
                "label": finite(r.label),
                "channel": r.channel,
            }
            for r in sub.head(limit).itertuples()
        ]
        peers = ann[ann["tid"].isin(coord_tids) & (ann["actor"] != actor)]["actor"].value_counts().head(15)
        return {
            "actor": actor,
            "n_events": len(sub),
            "first_t": _iso(sub["t"].min()) if len(sub) else None,
            "last_t": _iso(sub["t"].max()) if len(sub) else None,
            "coord_frac": finite(sub["tid"].isin(coord_tids).mean()) if len(sub) else None,
            "label_rate": finite(sub["label"].mean()) if len(sub) else None,
            "co_actors": [{"actor": a, "shared_events": int(n)} for a, n in peers.items()],
            "events": rows,
        }

    @staticmethod
    def search(run: Run, q: str, limit: int = 50) -> list[dict[str, Any]]:
        ann = run.ann
        if ann is None or not q:
            return []
        hit = ann[ann["text"].str.contains(q, case=False, regex=False, na=False)].head(limit)
        return [{"t": _iso(r.t), "actor": r.actor, "text": sample_text(r.text, 300), "tid": r.tid, "label": finite(r.label)} for r in hit.itertuples()]

    @staticmethod
    def dossier(run: Run) -> dict[str, Any]:
        from kollude import dossier

        if run.ann is None:
            return {"questions": [], "verdict": "run not finished"}
        return dossier.build(run.ann, run.result, run.params.coord(), landmarks=run.landmarks)

    @staticmethod
    def explain(run: Run, t: str) -> list[dict[str, Any]]:
        if run.ann is None:
            return []
        return explain_bin(run.ann, pd.Timestamp(t), run.params.coord(), top=10)

    @staticmethod
    def replay_tape(run: Run, *, max_events: int = 1500, sandboxes: int = 6) -> dict[str, Any]:
        """Capped event tape for the sandbox UI. Never returns full corpora."""
        ann = run.ann
        if ann is None or ann.empty:
            return {"events": [], "sandboxes": [], "t0": None, "t1": None, "n_total": 0, "n_actors": 0, "stride": 1}
        p = run.params.coord()
        named = ann[ann["actor"].notna()].sort_values("t")
        n_total = len(named)
        stride = max(1, (n_total + max_events - 1) // max_events) if n_total > max_events else 1
        tape = named.iloc[::stride].head(max_events)
        actor_n = named.groupby("tid")["actor"].nunique()
        hot = set(actor_n[actor_n >= p.min_actors].index)

        chans = named["channel"].fillna("").astype(str)
        if (chans != "").any():
            top_ch = [c for c in chans.value_counts().head(sandboxes).index.tolist() if c]
            kind = "channel"
        else:
            top_ch = named.loc[named["tid"].isin(hot), "tid"].value_counts().head(sandboxes).index.tolist()
            kind = "template"

        events: list[dict[str, Any]] = []
        for r in tape.itertuples():
            ch = str(r.channel) if pd.notna(r.channel) and str(r.channel) else ""
            tid = str(r.tid) if pd.notna(r.tid) else ""
            box = ch if kind == "channel" and ch in top_ch else (tid if kind == "template" and tid in top_ch else "world")
            events.append(
                {
                    "t": _iso(r.t),
                    "actor": str(r.actor),
                    "channel": ch or None,
                    "tid": tid or None,
                    "sandbox": box if box in top_ch else "world",
                    "text": sample_text(r.text, 120),
                    "coordinated": bool(r.tid in hot) if pd.notna(r.tid) else False,
                }
            )

        boxes = [{"id": "world", "label": "world · all traffic", "kind": "world", "n_events": n_total, "n_actors": int(named["actor"].nunique())}]
        for bid in top_ch:
            sub = named[chans == bid] if kind == "channel" else named[named["tid"] == bid]
            label = bid if kind == "channel" else sample_text(str(sub["tmpl"].iloc[0]) if len(sub) else bid, 48)
            boxes.append(
                {
                    "id": bid,
                    "label": label,
                    "kind": kind,
                    "n_events": int(len(sub)),
                    "n_actors": int(sub["actor"].nunique()),
                }
            )
        return {
            "events": events,
            "sandboxes": boxes,
            "t0": _iso(named["t"].min()),
            "t1": _iso(named["t"].max()),
            "n_total": n_total,
            "n_actors": int(named["actor"].nunique()),
            "stride": stride,
            "source": run.source,
        }

    # ------------------------------------------------------------ monitors

    def monitor(self, name: str, params: dict[str, Any] | None = None, *, reset: bool = False) -> Monitor:
        with self.lock:
            if reset and name in self.monitors:
                self.monitors[name].stop.set()
                self.monitors.pop(name)
            if name not in self.monitors:
                self.monitors[name] = Monitor(name=name, params=ScanParams.from_dict(params))
            return self.monitors[name]

    def replay(
        self,
        name: str,
        df: pd.DataFrame,
        *,
        params: dict[str, Any] | None = None,
        landmarks: list[dict[str, str]] | None = None,
        bins_per_step: int = 1,
        pace_s: float = 0.25,
    ) -> Monitor:
        """Feed a recorded stream into a live monitor bin-by-bin (the detector only sees the past)."""
        mon = self.monitor(name, params, reset=True)
        assert mon.run is not None
        mon.run.landmarks = landmarks or []
        freq = pd.Timedelta(mon.params.freq) * max(bins_per_step, 1)
        steps = df.groupby(df["t"].dt.floor(freq), sort=True)
        mon.run.push({"type": "stage", "name": "replay", "n_events": len(df), "n_steps": steps.ngroups, "landmarks": mon.run.landmarks})

        def work() -> None:
            try:
                for _, chunk in steps:
                    if mon.stop.is_set():
                        break
                    mon.ingest(chunk)
                    time.sleep(pace_s)
                if not mon.stop.is_set():
                    mon.ingest([], flush=True)
                    mon.run.status = "done"
                    mon.run.push({"type": "done", "summary": (mon.run.result or {}).get("summary", {})})
            except Exception as e:  # surfaced to the UI stream
                mon.run.status = "error"
                mon.run.push({"type": "error", "error": f"{type(e).__name__}: {e}"})

        threading.Thread(target=work, daemon=True).start()
        return mon

    def watch(self, name: str, path: str, *, params: dict[str, Any] | None = None, interval_s: float = 1.0) -> Monitor:
        """Tail a growing JSONL file (e.g. your agents' log) and score bins as they close."""
        mon = self.monitor(name, params, reset=True)
        mon.tail_path = path

        def work() -> None:
            while not mon.stop.is_set():
                try:
                    mon.tail_once()
                except Exception as e:
                    assert mon.run is not None
                    mon.run.push({"type": "error", "error": f"{type(e).__name__}: {e}"})
                mon.stop.wait(interval_s)

        threading.Thread(target=work, daemon=True).start()
        return mon

    def watch_url(self, name: str, url: str, *, params: dict[str, Any] | None = None, interval_s: float = 30.0) -> Monitor:
        """Poll a public JSON feed (list of posts / messages) and score it live — swarmchasing in the wild.

        Only http(s); ≤ 8 MB per poll; the body is parsed as data and never followed or rendered.
        Rows are de-duplicated by id so repeated polls only ingest new events.
        """
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("only http(s) URLs")
        mon = self.monitor(name, params, reset=True)
        assert mon.run is not None
        mon.run.source = url
        seen: set[str] = set()

        def rows_of(data: Any) -> list[dict[str, Any]]:
            if isinstance(data, dict):
                for k in ("posts", "data", "items", "events", "results", "messages", "edits", "rows"):
                    if isinstance(data.get(k), list):
                        return data[k]
                    if isinstance(data.get(k), dict):
                        inner = rows_of(data[k])
                        if inner:
                            return inner
                return []
            return data if isinstance(data, list) else []

        def work() -> None:
            from urllib.parse import urlparse

            import httpx

            assert mon.run is not None
            host = (urlparse(url).hostname or "").lower()
            # A machine-wide HTTP proxy must not swallow the local fixture server.
            trust_env = host not in {"127.0.0.1", "localhost", "::1"}
            while not mon.stop.is_set():
                try:
                    with httpx.Client(timeout=20, follow_redirects=True, trust_env=trust_env, headers={"user-agent": "kollude/0.3 (+swarm forensics)"}) as c:
                        r = c.get(url)
                    r.raise_for_status()
                    if len(r.content) > 8_000_000:
                        raise ValueError("response > 8 MB")
                    rows = [x for x in rows_of(r.json()) if isinstance(x, dict)]
                    fresh = []
                    for x in rows:
                        key = str(x.get("id") or x.get("event_id") or hash(json.dumps(x, sort_keys=True, default=str)))
                        if key not in seen:
                            seen.add(key)
                            fresh.append(x)
                    mon.run.push({"type": "poll", "url": url, "rows": len(rows), "new": len(fresh), "t": _iso(pd.Timestamp.now(tz="UTC"))})
                    if fresh:
                        mon.ingest(fresh)
                except Exception as e:
                    mon.run.push({"type": "poll", "url": url, "error": f"{type(e).__name__}: {e}"[:200]})
                mon.stop.wait(interval_s)

        threading.Thread(target=work, daemon=True).start()
        return mon


@dataclass
class Monitor:
    """Live incremental scan. Bins are scored once they close (event time passes bin end)."""

    name: str
    params: ScanParams
    frames: list[pd.DataFrame] = field(default_factory=list)
    last_bin: pd.Timestamp | None = None
    run: Run | None = None
    tail_path: str | None = None
    tail_offset: int = 0
    _det: EDetector | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)
    stop: threading.Event = field(default_factory=threading.Event)

    def __post_init__(self) -> None:
        self._det = EDetector(alpha=self.params.alpha, warmup=self.params.warmup, m_min=self.params.m_min, seed=self.params.seed)
        self.run = Run(id=f"live-{self.name}", kind="monitor", source=self.name, params=self.params, status="live")

    def ingest(self, rows: list[dict[str, Any]] | pd.DataFrame, *, flush: bool = False) -> dict[str, Any]:
        with self._lock:
            cp = self.params.coord()
            new = rows if isinstance(rows, pd.DataFrame) else from_records(rows, source=self.name)
            if not new.empty:
                self.frames.append(coord.signatures(new, cp))
            if not self.frames:
                return {"accepted": 0, "ticks": 0}
            sig = pd.concat(self.frames, ignore_index=True).sort_values("t", kind="stable").reset_index(drop=True)
            self.frames = [sig]
            ann = coord.choose_keys(sig.copy())
            df = ann
            bins = coord.bin_signals(ann, cp)
            assert self.run is not None and self._det is not None
            self.run.ann = ann
            now_bin = df["t"].max().floor(self.params.freq)
            ready = bins[(bins["bin"] < now_bin) | flush]
            if self.last_bin is not None:
                ready = ready[ready["bin"] > self.last_bin]
            n_ticks = 0
            for row in ready.to_dict(orient="records"):
                r = self._det.update(float(row["C"]), float(row["M"]))
                tick = {
                    "type": "tick",
                    "t": _iso(row["bin"]),
                    "n": int(row["n_events"]),
                    "actors": int(row["n_actors"]),
                    "C": finite(row["C"]),
                    "M": finite(row["M"]),
                    "coord": int(row["n_coord"]),
                    "p": finite(r["p"]),
                    "log10_S": finite(__import__("math").log10(max(r["S"], 1e-12))),
                    "alarm": r["alarm"],
                    "label_rate": finite(row.get("label_rate")),
                }
                self.run.push(tick)
                if r["alarm"]:
                    self.run.push({"type": "alarm", **{k: tick[k] for k in ("t", "C", "M")}, "S": finite(r["S"]), "n_events": tick["n"], "templates": explain_bin(ann, row["bin"], cp)})
                self.last_bin = row["bin"]
                n_ticks += 1
            cl = coord.clusters(ann, cp, top=self.params.top_clusters)
            ac = coord.actor_scores(ann, cp).head(self.params.top_actors)
            self.run.result = {
                "summary": {"n_events": len(df), "n_actors": int(df["actor"].nunique()), "n_bins": len(bins), "t_min": _iso(df["t"].min()), "t_max": _iso(df["t"].max())},
                "clusters": _records(cl),
                "actors": _records(ac),
                "timeline": [e for e in self.run.events if e.get("type") == "tick"],
                "alarms": [e for e in self.run.events if e.get("type") == "alarm"],
                "params": self.params.__dict__,
                "source": self.name,
                "landmarks": self.run.landmarks,
            }
            self.run.push({"type": "snapshot", "n_events": len(df), "n_clusters": len(cl)})
            return {"accepted": len(new), "ticks": n_ticks, "n_events": len(df)}

    def tail_once(self) -> dict[str, Any]:
        """Read newly appended JSONL lines from ``tail_path`` and ingest them."""
        if not self.tail_path:
            return {"accepted": 0}
        p = Path(self.tail_path)
        if not p.exists():
            return {"accepted": 0, "error": "missing file"}
        with p.open("rb") as f:
            f.seek(self.tail_offset)
            chunk = f.read()
        if not chunk:
            return {"accepted": 0}
        last_nl = chunk.rfind(b"\n")
        if last_nl < 0:
            return {"accepted": 0}
        self.tail_offset += last_nl + 1
        rows = []
        for line in chunk[: last_nl + 1].splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return self.ingest(rows)


STORE = RunStore()
