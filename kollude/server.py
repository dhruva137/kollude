"""Local HTTP + SSE API (and the web console) — ``kollude serve``.

Binds 127.0.0.1 by default. Every response is JSON derived from sanitized text; dataset text is
never executed, rendered as HTML, or followed.

    GET  /api/health
    GET  /api/datasets                       registry + local availability
    POST /api/datasets/{id}/fetch            download a public dataset (background)
    POST /api/runs                           {dataset|path|events, start, end, max_rows, params}
    GET  /api/runs  /api/runs/{id}           list / full result
    GET  /api/runs/{id}/stream?pace=0.02     SSE: stage, tick, alarm, done (pace = s per tick replayed)
    GET  /api/runs/{id}/cluster/{tid}        drill-down
    GET  /api/runs/{id}/actor/{actor}
    GET  /api/runs/{id}/search?q=
    GET  /api/runs/{id}/bin?t=
    POST /api/live/replay                    {dataset|synthetic, start, end, pace_s, params} → live monitor
    POST /api/live/{name}/ingest             push your agents' events (list of dicts)
    POST /api/live/watch                     {name, path} tail a JSONL log
    POST /api/live/{name}/stop
    POST /api/attribute                      {trajectory, question} → who / which step failed
    GET  /api/backtests                      measured backtest + stress results
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse

from kollude import __version__, datasets
from kollude.attribution import attribute
from kollude.paths import home_dir, web_dist
from kollude.runs import STORE, Run

WEB_DIST = web_dist()
BACKTESTS = home_dir() / "web" / "public" / "data" / "backtests.json"
_FETCH: dict[str, dict[str, Any]] = {}

app = FastAPI(title="kollude", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _run(run_id: str) -> Run:
    if run_id in STORE.runs:
        return STORE.runs[run_id]
    name = run_id.removeprefix("live-")
    if name in STORE.monitors and STORE.monitors[name].run is not None:
        return STORE.monitors[name].run  # type: ignore[return-value]
    raise HTTPException(404, f"unknown run {run_id}")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__, "runs": len(STORE.runs), "monitors": list(STORE.monitors)}


@app.get("/api/datasets")
def list_datasets() -> list[dict[str, Any]]:
    out = datasets.list_datasets()
    for d in out:
        d["fetch"] = _FETCH.get(d["id"])
    return out


@app.post("/api/datasets/{dataset_id}/fetch")
def fetch_dataset(dataset_id: str) -> dict[str, Any]:
    if dataset_id not in datasets.REGISTRY:
        raise HTTPException(404, "unknown dataset")
    if (_FETCH.get(dataset_id) or {}).get("status") == "running":
        return _FETCH[dataset_id]
    _FETCH[dataset_id] = {"status": "running"}

    def work() -> None:
        try:
            paths = datasets.fetch(dataset_id)
            _FETCH[dataset_id] = {"status": "done", "files": [str(p.name) for p in paths]}
        except Exception as e:
            _FETCH[dataset_id] = {"status": "error", "error": f"{type(e).__name__}: {e}"}

    threading.Thread(target=work, daemon=True).start()
    return _FETCH[dataset_id]


@app.post("/api/runs")
def create_run(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    ds = body.get("dataset")
    if ds and ds not in datasets.REGISTRY:
        raise HTTPException(404, "unknown dataset")
    if ds == "moltbook" and not (body.get("start") or body.get("end") or body.get("max_rows") or body.get("allow_full")):
        raise HTTPException(413, "Moltbook is 1.7M posts. Pass start and end (2026-02-03 to 2026-02-09 covers the wave) or max_rows.")
    if ds == "whowhen":
        raise HTTPException(422, "Who&When is a blame set. Use GET /api/cases, not a swarm scan.")
    if ds and not datasets.REGISTRY[ds].available():
        info = datasets.REGISTRY[ds]
        tip = "needs HF_TOKEN in .env" if info.requires_token else f"download with: kollude datasets fetch {ds}"
        raise HTTPException(
            409,
            f"{info.title} is not on disk yet ({tip}). Synthetic and forge work with no download.",
        )
    if not (ds or body.get("path") or body.get("events") is not None):
        raise HTTPException(422, "need one of dataset / path / events")
    run = STORE.start(
        dataset=ds,
        path=body.get("path"),
        events=body.get("events"),
        start=body.get("start"),
        end=body.get("end"),
        max_rows=body.get("max_rows"),
        params=body.get("params"),
        allow_full=bool(body.get("allow_full")),
        background=not body.get("wait", False),
    )
    return run.brief() | ({"result": run.result} if body.get("wait") else {})


@app.get("/api/runs")
def list_runs() -> list[dict[str, Any]]:
    runs = [r.brief() for r in STORE.runs.values()]
    runs += [m.run.brief() for m in STORE.monitors.values() if m.run is not None]
    return sorted(runs, key=lambda r: -r["created"])


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    r = _run(run_id)
    return r.brief() | {"result": r.result, "landmarks": r.landmarks, "params": r.params.__dict__}


@app.get("/api/runs/{run_id}/stream")
async def stream(
    run_id: str,
    pace: float = Query(0.0, ge=0.0, le=2.0),
    since: int = Query(0, ge=0),
    last_event_id: str | None = Header(None),
) -> EventSourceResponse:
    r = _run(run_id)
    start = int(last_event_id) if last_event_id and last_event_id.isdigit() else since

    async def gen():
        i = start
        while True:
            with r.cond:
                batch = r.events[i:]
            if batch:
                for ev in batch:
                    i += 1
                    yield {"event": ev.get("type", "message"), "id": str(i), "data": json.dumps(ev, default=str)}
                    if pace and ev.get("type") == "tick":
                        await asyncio.sleep(pace)
                    if ev.get("type") in ("done", "error") and r.kind != "monitor":
                        return
                continue
            if r.status in ("done", "error") and i >= len(r.events):
                return
            await asyncio.sleep(0.15)

    return EventSourceResponse(gen(), ping=10)


@app.get("/api/runs/{run_id}/cluster/{tid}")
def cluster(run_id: str, tid: str, limit: int = 60) -> dict[str, Any]:
    return STORE.cluster_events(_run(run_id), tid, limit=min(limit, 500))


@app.get("/api/runs/{run_id}/actor/{actor:path}")
def actor(run_id: str, actor: str, limit: int = 200) -> dict[str, Any]:
    return STORE.actor_profile(_run(run_id), actor, limit=min(limit, 1000))


@app.get("/api/runs/{run_id}/search")
def search(run_id: str, q: str = Query(..., min_length=2, max_length=200), limit: int = 50) -> list[dict[str, Any]]:
    return STORE.search(_run(run_id), q, limit=min(limit, 500))


@app.get("/api/runs/{run_id}/spread")
def run_spread(run_id: str, top: int = 12) -> list[dict[str, Any]]:
    from kollude.spread import trace_spread

    run = _run(run_id)
    if run.ann is None:
        raise HTTPException(409, "run has not finished")
    return trace_spread(run.ann, run.params.coord(), top=min(max(top, 1), 50))


@app.get("/api/runs/{run_id}/replay")
def run_replay(run_id: str, max_events: int = 1500, sandboxes: int = 6) -> dict[str, Any]:
    """Capped event tape for the multi-sandbox console. Synthetic/forge stay small; large corpora are strided."""
    run = _run(run_id)
    if run.ann is None:
        raise HTTPException(409, "run has not finished")
    return STORE.replay_tape(run, max_events=min(max(max_events, 100), 3000), sandboxes=min(max(sandboxes, 2), 12))


@app.get("/api/runs/{run_id}/dossier")
def dossier(run_id: str, format: str = "json") -> Any:
    d = STORE.dossier(_run(run_id))
    if format == "md":
        from fastapi.responses import PlainTextResponse

        from kollude.dossier import to_markdown

        return PlainTextResponse(to_markdown(d, f"Swarm dossier — {_run(run_id).source}"), media_type="text/markdown")
    return d


@app.get("/api/runs/{run_id}/bin")
def explain(run_id: str, t: str) -> list[dict[str, Any]]:
    return STORE.explain(_run(run_id), t)


@app.post("/api/live/replay")
def live_replay(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    name = body.get("name") or "replay"
    ds = body.get("dataset")
    params = dict(body.get("params") or {})
    landmarks: list[dict[str, str]] = []
    if body.get("synthetic"):
        from kollude.stress import synth

        df, _ = synth(int(body.get("n_events", 30_000)), swarm_share=float(body.get("swarm_share", 0.05)), seed=int(body.get("seed", 0)))
        landmarks = [{"t": "2026-01-10T04:00:00Z", "label": "Injected swarm onset (ground truth)", "kind": "ground_truth"}]
        params = {"warmup": 48, "m_min": 4.0, **params}
    elif ds in datasets.REGISTRY:
        if ds == "whowhen":
            raise HTTPException(422, "Who&When is a blame set. Use GET /api/cases.")
        if not datasets.REGISTRY[ds].available():
            raise HTTPException(409, f"dataset {ds} not downloaded")
        try:
            df = datasets.load(ds, start=body.get("start"), end=body.get("end"), max_rows=body.get("max_rows"))
        except ValueError as e:
            raise HTTPException(413, str(e)) from e
        params = {**datasets.REGISTRY[ds].defaults, **params}
        landmarks = datasets.REGISTRY[ds].landmarks
    else:
        raise HTTPException(422, "need dataset or synthetic=true")
    if len(df) > 400_000:
        raise HTTPException(413, f"{len(df):,} events — narrow start/end for live replay (≤400k); use POST /api/runs for full scans")
    mon = STORE.replay(name, df.reset_index(drop=True), params=params, landmarks=landmarks, bins_per_step=int(body.get("bins_per_step", 1)), pace_s=float(body.get("pace_s", 0.15)))
    assert mon.run is not None
    return mon.run.brief() | {"n_events": len(df)}


@app.post("/api/live/{name}/ingest")
def live_ingest(name: str, body: Any = Body(...)) -> dict[str, Any]:
    rows = body.get("events") if isinstance(body, dict) else body
    if not isinstance(rows, list):
        raise HTTPException(422, "body must be a list of events or {events: [...]}")
    mon = STORE.monitor(name, body.get("params") if isinstance(body, dict) else None)
    flush = bool(body.get("flush")) if isinstance(body, dict) else False
    return mon.ingest(rows[:50_000], flush=flush) | {"run_id": mon.run.id if mon.run else None}


@app.post("/api/live/watch")
def live_watch(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    path = body.get("path")
    if not path or not Path(path).exists():
        raise HTTPException(404, "path not found")
    mon = STORE.watch(body.get("name") or Path(path).stem, path, params=body.get("params"))
    assert mon.run is not None
    return mon.run.brief()


@app.post("/api/live/watch_url")
def live_watch_url(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    url = str(body.get("url") or "")
    try:
        mon = STORE.watch_url(body.get("name") or "wild", url, params=body.get("params"), interval_s=float(body.get("interval_s", 30)))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    assert mon.run is not None
    return mon.run.brief()


@app.post("/api/live/{name}/stop")
def live_stop(name: str) -> dict[str, Any]:
    if name in STORE.monitors:
        STORE.monitors[name].stop.set()
        return {"stopped": name}
    raise HTTPException(404, "no such monitor")


@app.post("/api/attribute")
def attribute_failure(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    traj = body.get("trajectory") or body.get("history")
    if not isinstance(traj, list):
        raise HTTPException(422, "trajectory must be a list of {name|role, content}")
    return attribute(traj, body.get("question", ""), body.get("weights"))


@app.get("/api/cases")
def cases(n: int = 4) -> dict[str, Any]:
    """Sample failures for the blame panel. Who&When is read only if the parquet is already local."""
    from kollude.demo_data import FAILURE

    n = max(1, min(n, 8))
    out: dict[str, Any] = {
        "sample": {"question": FAILURE["question"], "history": FAILURE["history"], "source": "synthetic failure fixture"},
        "whowhen": [],
    }
    path = datasets.DATA / "whowhen" / "Hand-Crafted.parquet"
    if not path.exists():
        path = datasets.DATA / "whowhen" / "Algorithm-Generated.parquet"
    if not path.exists():
        return out
    import pandas as pd

    df = pd.read_parquet(path).head(n)
    rows = []
    for rec in df.to_dict(orient="records"):
        hist = rec.get("history") or []
        if hasattr(hist, "tolist"):
            hist = hist.tolist()
        steps = []
        for m in list(hist)[:12]:
            if not isinstance(m, dict):
                continue
            steps.append({"name": str(m.get("name") or m.get("role") or "agent"), "content": str(m.get("content") or "")[:500]})
        rows.append(
            {
                "question": str(rec.get("question") or "")[:300],
                "history": steps,
                "gold_agent": str(rec.get("mistake_agent") or ""),
                "source": path.name,
            }
        )
    out["whowhen"] = rows
    return out


@app.get("/api/backtests")
def backtests() -> JSONResponse:
    if not BACKTESTS.exists():
        raise HTTPException(404, "run `kollude backtest` first")
    return JSONResponse(json.loads(BACKTESTS.read_text(encoding="utf-8")))


if WEB_DIST.exists():

    @app.get("/{full:path}", include_in_schema=False)
    def web(full: str) -> FileResponse:
        target = (WEB_DIST / full).resolve()
        if full and target.is_file() and WEB_DIST.resolve() in target.parents:
            return FileResponse(target)
        return FileResponse(WEB_DIST / "index.html")


def serve(host: str = "127.0.0.1", port: int = 8787) -> None:
    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")
