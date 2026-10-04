import json
import time

import pandas as pd
import pytest

import kollude
from kollude import coord, stress
from kollude.engine import ScanParams
from kollude.runs import RunStore
from kollude.stream import EDetector


def test_from_records_accepts_common_shapes():
    rows = [
        {"agent": "a", "content": "hi there", "timestamp": "2026-01-01T00:00:00Z"},
        {"role": "assistant", "content": [{"type": "text", "text": "x"}]},
        {"author": {"id": 7}, "text": "see https://evil.example/x now", "created_at": "2026-01-01T01:00:00Z"},
    ]
    df = kollude.from_records(rows)
    assert len(df) == 2  # the row without a timestamp is dropped once others have one
    assert set(df["actor"]) == {"a", "7"}
    assert "[URL]" in df.loc[df["actor"] == "7", "text"].iloc[0]


def test_suffix_template_catches_random_prefix():
    df = pd.DataFrame(
        {
            "text": [f"{w} {v} claim free airdrop now {i} tokens send to wallet and repost to friends" for i, (w, v) in enumerate(zip("abcdefgh", "hgfedcba", strict=True))],
        }
    )
    pre = coord.templates(df["text"])
    suf = coord.templates(df["text"], from_end=True)
    assert pre.nunique() == 8
    assert suf.nunique() == 1


def test_window_counts_slow_swarm():
    t0 = pd.Timestamp("2026-01-01", tz="UTC")
    rows = [{"actor": f"bot{i}", "text": "claim free airdrop now 5 tokens send to wallet", "t": t0 + pd.Timedelta(hours=i)} for i in range(6)]
    df = kollude.from_records(rows)
    one = coord.bin_signals(coord.annotate(df, coord.CoordParams(min_actors=5, window=1)), coord.CoordParams(min_actors=5, window=1))
    six = coord.bin_signals(coord.annotate(df, coord.CoordParams(min_actors=5, window=6)), coord.CoordParams(min_actors=5, window=6))
    assert one["n_coord"].sum() == 0
    assert six["n_coord"].sum() >= 1


def test_detector_null_is_calibrated():
    import numpy as np

    rng = np.random.default_rng(0)
    alarms = 0
    for k in range(20):
        det = EDetector(alpha=0.05, warmup=10, m_min=0.0, seed=k)
        for z in rng.random(200):
            alarms += det.update(float(z), 10.0)["alarm"]
    assert alarms / (20 * 200) <= 0.05


def test_injected_swarm_detected_quickly():
    df, onset = stress.synth(20_000, swarm_share=0.05, seed=3)
    r = kollude.scan(df, ScanParams(warmup=48, m_min=4.0))
    first = [pd.Timestamp(a["t"]) for a in r.alarms]
    t_on = stress.T0 + pd.Timedelta(hours=onset)
    assert first and min(t for t in first if t >= t_on) - t_on <= pd.Timedelta(hours=12)
    assert not [t for t in first if t < t_on]
    assert r.clusters[0]["n_actors"] >= 20


def test_fuzz_never_crashes():
    assert stress.fuzz(15)["failures"] == 0


def test_stray_timestamps_do_not_explode_bins():
    df = kollude.from_records([{"actor": "a", "text": "x y z w", "t": "1970-01-02"}, {"actor": "b", "text": "x y z w", "t": "2200-01-01"}])
    bins = coord.bin_signals(coord.annotate(df))
    assert len(bins) <= coord.MAX_BINS


def test_monitor_incremental_matches_batch():
    df, _ = stress.synth(6_000, n_bins=120, onset=70, swarm_share=0.1, seed=1)
    p = ScanParams(warmup=24, m_min=4.0)
    batch = kollude.scan(df, p)
    store = RunStore()
    mon = store.monitor("t", p.__dict__)
    for _, chunk in df.groupby(df["t"].dt.floor("6h")):
        mon.ingest(chunk)
    mon.ingest([], flush=True)
    live_alarms = [e["t"] for e in mon.run.events if e["type"] == "alarm"]
    assert live_alarms == [a["t"] for a in batch.alarms]


def test_dossier_flags_injected_swarm():
    from kollude import dossier

    df, _ = stress.synth(15_000, swarm_share=0.08, seed=5)
    p = ScanParams(warmup=48, m_min=4.0)
    r = kollude.scan(df, p)
    d = dossier.build(coord.annotate(df, p.coord()), r.as_dict(), p.coord())
    by = {q["id"]: q for q in d["questions"]}
    assert by["multiplicity"]["value"]["largest"]["n_actors"] >= 20
    assert by["onset"]["value"]["patient_zero"]["first_actors"][0].startswith("bot")
    assert "bot" == dossier._name_family("bot17")
    assert by["naming"]["value"]["largest_family"] in {"u", "bot"}
    assert "Swarm signature present" in d["verdict"]
    assert "airdrop" in by["topics"]["value"]["coordinated_terms"]
    assert dossier.to_markdown(d).startswith("# ")


def test_watch_url_polls_and_dedupes(monkeypatch):
    import httpx

    from kollude.runs import RunStore

    df, _ = stress.synth(3_000, n_bins=48, onset=24, swarm_share=0.3, seed=2)
    rows = [{"id": str(i), **r} for i, r in enumerate(df.assign(t=df["t"].astype(str)).to_dict("records"))]
    calls = {"n": 0}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url):
            calls["n"] += 1
            # the same first half every time, plus the rest on the second poll — dedupe must handle it
            body = rows[:1500] if calls["n"] == 1 else rows
            return httpx.Response(200, json={"posts": body}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "Client", FakeClient)
    store = RunStore()
    with pytest.raises(ValueError):
        store.watch_url("bad", "file:///etc/passwd")
    mon = store.watch_url("wild", "https://example.test/feed.json", params={"freq": "1h", "warmup": 6, "min_actors": 5}, interval_s=0.05)
    deadline = time.time() + 20
    polls: list[dict] = []
    while time.time() < deadline:
        polls = [e for e in mon.run.events if e.get("type") == "poll" and "error" not in e]
        if len(polls) >= 3:
            break
        time.sleep(0.05)
    mon.stop.set()
    assert [p["new"] for p in polls[:3]] == [1500, len(rows) - 1500, 0], polls
    assert mon.run.source == "https://example.test/feed.json"
    assert sum(len(f) for f in mon.frames) == len(rows)


def test_moltbook_refuses_unbounded_load_and_forge_episode_scans():
    from kollude import datasets
    from kollude.banner import show

    show()
    with pytest.raises(ValueError, match="1.7M"):
        datasets.load("moltbook")
    df = datasets.load("forge")
    assert len(df) > 20
    assert df["actor"].nunique() >= 3


def test_synthetic_powers_scan_dossier_and_attribute():
    from kollude import datasets
    from kollude.attribution import attribute
    from kollude.demo_data import FAILURE, ensure
    from kollude.runs import RunStore

    assert datasets.REGISTRY["synthetic"].available()
    paths = ensure()
    assert paths["swarm"].stat().st_size > 1000
    assert paths["feed"].stat().st_size > 1000
    assert json.loads(paths["failure"].read_text(encoding="utf-8"))["history"][0]["name"] == "worker"
    df = datasets.load("synthetic")
    assert set(df["label"].dropna().unique()) >= {0.0, 1.0}
    run = RunStore().start(dataset="synthetic", background=False)
    assert run.status == "done" and run.result is not None
    assert run.result["summary"]["n_alarms"] >= 1
    d = RunStore().dossier(run)
    assert "Swarm signature present" in d["verdict"]
    assert attribute(FAILURE["history"], FAILURE["question"])["agent"] == "worker"


def test_spread_names_the_first_actor_and_the_carriers():
    from kollude import datasets
    from kollude.spread import trace_spread

    rows = trace_spread(datasets.load("synthetic"))
    assert rows
    top = rows[0]
    assert top["n_actors"] >= 5
    assert top["seeder"] in top["carriers"]
    assert top["hours_to_min_actors"] >= 0


def test_attribute_api():
    traj = [
        {"name": "Planner", "content": "Plan: search the docs"},
        {"name": "WebSurfer", "content": "I could not find it, let's assume the value is 42"},
        {"name": "Planner", "content": "Final answer 42"},
    ]
    out = kollude.attribute(traj, "what is x")
    assert out["agent"] in {"Planner", "WebSurfer"}
    assert out["ranking"]


def test_http_api_roundtrip():
    from fastapi.testclient import TestClient

    from kollude.server import app

    c = TestClient(app)
    assert c.get("/api/health").json()["ok"]
    rows = [{"actor": f"a{i}", "text": "join the raid now at the usual place friends", "t": f"2026-01-01T00:{i:02d}:00Z"} for i in range(8)]
    r = c.post("/api/runs", json={"events": rows, "params": {"min_actors": 3, "warmup": 1}, "wait": True}).json()
    assert r["status"] == "done"
    assert r["result"]["clusters"][0]["n_actors"] == 8
    spread = c.get(f"/api/runs/{r['id']}/spread").json()
    assert spread[0]["n_actors"] == 8
    assert spread[0]["seeder"] in spread[0]["carriers"]
    tape = c.get(f"/api/runs/{r['id']}/replay").json()
    assert tape["events"]
    assert tape["sandboxes"][0]["id"] == "world"
    assert tape["events"][0]["actor"]
    tid = r["result"]["clusters"][0]["tid"]
    assert c.get(f"/api/runs/{r['id']}/cluster/{tid}").json()["n_events"] == 8
    with c.stream("GET", f"/api/runs/{r['id']}/stream") as s:
        body = "".join(s.iter_text())
    assert "event: done" in body
    ing = c.post("/api/live/test/ingest", json={"events": rows, "flush": True}).json()
    assert ing["accepted"] == 8


@pytest.mark.parametrize("bad", [[], [{}], [None, 3, "x"]])
def test_scan_empty_inputs(bad):
    r = kollude.scan(kollude.from_records(bad))
    assert r.summary["n_events"] == 0
    json.dumps(r.as_dict(), default=str)
