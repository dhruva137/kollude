"""``kollude`` command line."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import typer

# Windows consoles default to cp1252; dossiers contain ≤ / α / — etc.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
from rich.console import Console
from rich.live import Live
from rich.table import Table

app = typer.Typer(no_args_is_help=False, add_completion=False, help="kollude — swarm-collusion forensics for multi-agent logs")
ds_app = typer.Typer(no_args_is_help=True, help="Built-in public agent datasets")
app.add_typer(ds_app, name="datasets")
console = Console()


@app.callback(invoke_without_command=True)
def _root(ctx: typer.Context) -> None:
    from kollude.banner import show
    from kollude.demo_data import COMMANDS

    show()
    if ctx.invoked_subcommand is None:
        console.print(COMMANDS)
        raise typer.Exit()


def _params(**kw) -> dict:
    return {k: v for k, v in kw.items() if v is not None}


def _print_result(res: dict, top: int) -> None:
    s = res["summary"]
    console.print(
        f"[bold]{s['n_events']:,}[/] events · {s['n_actors']:,} actors · {s['n_bins']} bins · "
        f"[bold red]{s['n_alarms']}[/] alarms · coordinated share {s['coordinated_event_share'] or 0:.3f} · "
        f"{s['events_per_s'] or 0:,.0f} ev/s"
    )
    if res["alarms"]:
        t = Table(title="Alarms (anytime-valid; false-alarm rate ≤ alpha)")
        for c in ("t", "C", "M", "S", "top template"):
            t.add_column(c)
        for a in res["alarms"][:top]:
            tpl = (a.get("templates") or [{}])[0].get("template", "")
            t.add_row(a["t"], f"{a['C']:.3f}", f"{a['M']:.1f}", f"{a['S']:.0f}", (tpl or "")[:70])
        console.print(t)
    t = Table(title="Coordinated clusters")
    for c in ("tid", "actors", "events", "span h", "template"):
        t.add_column(c)
    for c in res["clusters"][:top]:
        t.add_row(str(c["tid"])[:12], str(c["n_actors"]), str(c["n_events"]), f"{c['span_h'] or 0:.1f}", (c["template"] or "")[:70])
    console.print(t)


@app.command()
def scan(
    source: str = typer.Argument(..., help="Path to JSONL/JSON/CSV/Parquet log, or a dataset id (synthetic, forge, moltbook, wiki, village)"),
    start: str | None = None,
    end: str | None = None,
    freq: str | None = None,
    min_actors: int | None = None,
    alpha: float | None = None,
    window: int | None = None,
    max_rows: int | None = None,
    top: int = 10,
    all_rows: bool = typer.Option(False, "--all", help="Load a whole heavy corpus. Moltbook is 1.7M posts and wants several GB free."),
    json_out: Path | None = typer.Option(None, "--json", help="Write the full result JSON here"),
) -> None:
    """Scan a log or dataset for coordinated swarms."""
    from kollude import datasets
    from kollude.runs import STORE

    if source == "moltbook" and not all_rows and not start and not end and max_rows is None:
        start, end = "2026-02-03", "2026-02-09"
        console.print("[dim]Moltbook window 2026-02-03 → 2026-02-09 (the mbc-20 wave). Pass --all to read the whole corpus.[/]")
    params = _params(freq=freq, min_actors=min_actors, alpha=alpha, window=window)
    kw = {"dataset": source} if source in datasets.REGISTRY else {"path": source}
    if all_rows:
        kw["allow_full"] = True
    t0 = time.perf_counter()
    with console.status(f"scanning {source} …"):
        run = STORE.start(**kw, start=start, end=end, max_rows=max_rows, params=params, background=False)
    if run.status == "error" or run.result is None:
        console.print(f"[red]{run.error}[/]")
        raise typer.Exit(1)
    _print_result(run.result, top)
    console.print(f"[dim]{time.perf_counter() - t0:.1f}s wall[/]")
    if json_out:
        json_out.write_text(json.dumps(run.result, default=str), encoding="utf-8")
        console.print(f"wrote {json_out}")


@app.command()
def dossier(
    source: str = typer.Argument(..., help="Log path or dataset id"),
    start: str | None = None,
    end: str | None = None,
    min_actors: int | None = None,
    freq: str | None = None,
    md: Path | None = typer.Option(None, "--md", help="Write a Markdown dossier here"),
) -> None:
    """Answer the standard swarm questions about any agent group (scale, rhythm, multiplicity, onset, seeder …)."""
    from kollude import datasets
    from kollude.dossier import to_markdown
    from kollude.runs import STORE

    kw = {"dataset": source} if source in datasets.REGISTRY else {"path": source}
    with console.status(f"scanning {source} …"):
        run = STORE.start(**kw, start=start, end=end, params=_params(min_actors=min_actors, freq=freq), background=False)
    if run.status == "error":
        console.print(f"[red]{run.error}[/]")
        raise typer.Exit(1)
    d = STORE.dossier(run)
    console.print(f"[bold]Verdict:[/] {d['verdict']}\n")
    for q in d["questions"][:-1]:
        console.print(f"[accent]{q['question']}[/]\n  {q['answer']}" + (f"  [red]⚑ {q['flag']}[/]" if q.get("flag") else ""))
    if md:
        md.write_text(to_markdown(d, f"Swarm dossier — {source}"), encoding="utf-8")
        console.print(f"\nwrote {md}")


@app.command()
def spread(
    source: str = typer.Argument(..., help="Log path or dataset id"),
    start: str | None = None,
    end: str | None = None,
    min_actors: int | None = None,
    top: int = 8,
) -> None:
    """Who posted a shared line first, how many hours until others copied it, and who carried it."""
    from kollude import datasets
    from kollude.coord import CoordParams
    from kollude.runs import STORE
    from kollude.spread import trace_spread

    kw = {"dataset": source} if source in datasets.REGISTRY else {"path": source}
    with console.status(f"tracing {source} …"):
        run = STORE.start(**kw, start=start, end=end, params=_params(min_actors=min_actors), background=False)
    if run.status == "error" or run.ann is None:
        console.print(f"[red]{run.error}[/]")
        raise typer.Exit(1)
    rows = trace_spread(run.ann, CoordParams(min_actors=min_actors or 5), top=top)
    if not rows:
        console.print("No template reached the actor minimum.")
        return
    t = Table(title="Spread — first actor, hours until the actor minimum, carriers")
    for c in ("actors", "hours", "seeder", "channel", "carriers", "template"):
        t.add_column(c)
    for row in rows:
        t.add_row(
            str(row["n_actors"]),
            f"{row['hours_to_min_actors']:.1f}",
            row["seeder"],
            str(row["channel"] or ""),
            ", ".join(row["carriers"][:6]),
            row["template"] or "",
        )
    console.print(t)


@app.command()
def watch(
    path: Path = typer.Argument(..., help="Growing JSONL log to tail"),
    freq: str = "5min",
    min_actors: int = 3,
    warmup: int = 12,
    interval: float = 1.0,
) -> None:
    """Live-monitor a JSONL log your agents are appending to (Ctrl+C to stop)."""
    from kollude.engine import ScanParams
    from kollude.runs import Monitor

    mon = Monitor(name=path.stem, params=ScanParams(freq=freq, min_actors=min_actors, warmup=warmup))
    mon.tail_path = str(path)
    assert mon.run is not None

    def render() -> Table:
        t = Table(title=f"kollude watch {path} (bin {freq})")
        for c in ("bin", "events", "actors", "C", "M", "log10 S", "alarm"):
            t.add_column(c)
        for e in [e for e in mon.run.events if e.get("type") == "tick"][-15:]:
            t.add_row(e["t"], str(e["n"]), str(e["actors"]), f"{e['C'] or 0:.3f}", f"{e['M'] or 0:.1f}", f"{e['log10_S'] or 0:.2f}", "[bold red]ALARM[/]" if e["alarm"] else "")
        return t

    with Live(render(), console=console, refresh_per_second=2) as live:
        try:
            while True:
                mon.tail_once()
                live.update(render())
                time.sleep(interval)
        except KeyboardInterrupt:
            pass


@app.command("watch-url")
def watch_url(
    url: str = typer.Argument(..., help="Public JSON feed of posts/messages (list, or {posts|data|items: [...]})"),
    interval: float = 30.0,
    freq: str = "10min",
    min_actors: int = 3,
    warmup: int = 12,
) -> None:
    """Swarmchasing in the wild: poll a public JSON feed and score bins as they close (Ctrl+C to stop)."""
    from kollude.runs import RunStore

    store = RunStore()
    mon = store.watch_url("wild", url, params={"freq": freq, "min_actors": min_actors, "warmup": warmup}, interval_s=interval)
    assert mon.run is not None

    def render() -> Table:
        t = Table(title=f"kollude watch-url {url[:60]} (bin {freq})")
        for c in ("bin", "events", "actors", "C", "M", "log10 S", "alarm"):
            t.add_column(c)
        polls = [e for e in mon.run.events if e.get("type") == "poll"]
        if polls:
            last = polls[-1]
            t.caption = f"last poll: {last.get('new', 0)} new / {last.get('rows', 0)} rows" + (f" · error {last['error']}" if last.get("error") else "")
        for e in [e for e in mon.run.events if e.get("type") == "tick"][-15:]:
            t.add_row(e["t"], str(e["n"]), str(e["actors"]), f"{e['C'] or 0:.3f}", f"{e['M'] or 0:.1f}", f"{e['log10_S'] or 0:.2f}", "[bold red]ALARM[/]" if e["alarm"] else "")
        return t

    with Live(render(), console=console, refresh_per_second=1) as live:
        try:
            while True:
                time.sleep(1)
                live.update(render())
        except KeyboardInterrupt:
            mon.stop.set()


@app.command()
def demo() -> None:
    """Write synthetic fixtures and run every command that finishes on its own."""
    from kollude.attribution import attribute as _attr
    from kollude.demo_data import COMMANDS, ensure
    from kollude.engine import ScanParams
    from kollude.runs import Monitor, RunStore

    console.rule("type these")
    console.print(f'cd "{Path.cwd()}"')
    console.print(COMMANDS)
    console.print()
    paths = ensure()
    for name, path in paths.items():
        console.print(f"[green]✓[/] {name} → {path}")

    console.rule("uv run kollude datasets list")
    ds_list()

    store = RunStore()
    console.rule("uv run kollude scan synthetic")
    run = store.start(dataset="synthetic", background=False)
    if run.result is None:
        console.print(f"[red]{run.error}[/]")
        raise typer.Exit(1)
    _print_result(run.result, top=5)

    console.rule("uv run kollude dossier synthetic")
    d = store.dossier(run)
    console.print(f"[bold]Verdict:[/] {d['verdict']}")
    flagged = [q for q in d["questions"] if q.get("flag")]
    for q in flagged:
        console.print(f"  [red]⚑ {q['flag']}[/] {q['answer']}")

    console.rule("uv run kollude attribute kollude/fixtures/failure.json")
    data = json.loads(paths["failure"].read_text(encoding="utf-8"))
    blamed = _attr(data["history"], data["question"])
    console.print_json(json.dumps({"agent": blamed["agent"], "step": blamed["step"], "question": data["question"]}))

    console.rule("uv run kollude watch kollude/fixtures/swarm.jsonl  (one pass, then it would wait)")
    mon = Monitor(name="swarm", params=ScanParams(freq="1h", min_actors=5, warmup=24, m_min=4.0))
    mon.tail_path = str(paths["swarm"])
    got = mon.tail_once()
    alarms = [e for e in (mon.run.events if mon.run else []) if e.get("type") == "alarm"]
    console.print(f"ingested {got.get('accepted', 0):,} new rows · {len(alarms)} alarm(s) · first {alarms[0]['t'] if alarms else '—'}")

    httpd = _fixture_server(paths["feed"].parent)
    port = httpd.server_address[1]
    console.rule(f"uv run kollude watch-url http://127.0.0.1:{port}/feed.json  (two polls)")
    try:
        url = f"http://127.0.0.1:{port}/feed.json"
        wild = store.watch_url("wild", url, params={"freq": "1h", "min_actors": 5, "warmup": 24, "m_min": 4.0}, interval_s=0.3)
        assert wild.run is not None
        deadline = time.time() + 25
        polls: list[dict] = []
        while time.time() < deadline:
            polls = [e for e in wild.run.events if e.get("type") == "poll" and "error" not in e]
            if polls and polls[0].get("new", 0) > 0 and any(e.get("type") == "tick" for e in wild.run.events):
                break
            time.sleep(0.1)
        wild.stop.set()
        if not polls or polls[0].get("error"):
            err = next((e.get("error") for e in wild.run.events if e.get("type") == "poll" and e.get("error")), "no poll")
            console.print(f"[red]watch-url failed: {err}[/]")
            raise typer.Exit(1)
        ticks = [e for e in wild.run.events if e.get("type") == "tick"]
        console.print(f"polled {polls[0]['rows']:,} rows · {polls[0]['new']:,} new · {len(ticks)} bins scored · {sum(1 for e in ticks if e.get('alarm'))} alarm(s)")
    finally:
        httpd.shutdown()
        httpd.server_close()

    console.rule("uv run kollude backtest synthetic")
    from kollude import backtest as bt

    bt.run(["synthetic"])
    console.print(f"report → {bt.OUT / 'BACKTEST_REPORT.md'}")
    console.rule("done")
    console.print("Interactive ones are still typed by you: [bold]watch[/], [bold]watch-url[/], [bold]serve[/], [bold]mcp[/]. Ctrl+C stops them.")


def _fixture_server(directory: Path):
    """Serve fixture files on a free localhost port. Port 8765 is often already taken."""
    import threading
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    root = str(directory)

    class QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=root, **kwargs)

        def log_message(self, fmt: str, *args) -> None:
            return

    class BoundServer(ThreadingHTTPServer):
        allow_reuse_address = False
        daemon_threads = True

    httpd = BoundServer(("127.0.0.1", 0), QuietHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8787) -> None:
    """HTTP + SSE API and the live web console at http://127.0.0.1:8787."""
    from kollude.server import serve as _serve

    console.print(f"kollude API → http://{host}:{port}/api/health · console → http://{host}:{port}/#/")
    _serve(host, port)


@app.command()
def mcp() -> None:
    """Run the MCP server on stdio (for Claude Desktop, Cursor, any MCP agent)."""
    from kollude.mcp_server import main

    main()


@app.command()
def attribute(path: Path = typer.Argument(..., help="JSON file: list of {name|role, content} or {history: [...], question}")) -> None:
    """Rank which agent / step most likely caused a failed multi-agent run."""
    from kollude.attribution import attribute as _attr

    data = json.loads(path.read_text(encoding="utf-8"))
    traj = data.get("history", data) if isinstance(data, dict) else data
    q = data.get("question", "") if isinstance(data, dict) else ""
    console.print_json(json.dumps(_attr(traj, q)))


@app.command()
def backtest(names: list[str] = typer.Argument(None, help="synthetic moltbook wiki whowhen (default: all that are present)")) -> None:
    """Re-run backtests. `synthetic` needs no download; the others need `kollude datasets fetch`."""
    from kollude import backtest as bt

    bt.run(names or None)
    console.print(f"report → {bt.OUT / 'BACKTEST_REPORT.md'}")


@app.command()
def stress(quick: bool = False) -> None:
    """Synthetic scale / power / evasion / fuzz stress suite."""
    from kollude import stress as st

    st.main(["--quick"] if quick else [])


@app.command()
def version() -> None:
    from kollude import __version__

    console.print(f"kollude {__version__}")


@ds_app.command("list")
def ds_list() -> None:
    from kollude import datasets

    t = Table()
    for c in ("id", "title", "labels", "local", "size"):
        t.add_column(c)
    for d in datasets.list_datasets():
        t.add_row(d["id"], d["title"], d["labels"], "[green]yes[/]" if d["available"] else "no", d["size_hint"])
    console.print(t)


@ds_app.command("fetch")
def ds_fetch(dataset_id: str) -> None:
    from kollude import datasets

    with console.status(f"fetching {dataset_id} …"):
        paths = datasets.fetch(dataset_id)
    for p in paths:
        console.print(f"[green]✓[/] {p}")


if __name__ == "__main__":
    app()
