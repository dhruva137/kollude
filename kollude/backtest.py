"""Backtests on real, labelled data. Every number ships with a named baseline and a 95% interval.

    uv run pz backtest            # all available datasets
    uv run pz backtest moltbook   # one

Outputs ``eval/backtest/<name>.json`` + ``eval/backtest/BACKTEST_REPORT.md`` and a UI copy at
``web/public/data/backtests.json``.
"""

from __future__ import annotations

import gzip
import json
import time
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from kollude import attribution, coord, datasets
from kollude.engine import ScanParams
from kollude.paths import home_dir
from kollude.stream import detect_bins, finite, permutation_arl

OUT = home_dir() / "eval" / "backtest"
UI = home_dir() / "web" / "public" / "data" / "backtests.json"


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- statistics


def boot_auc(y: np.ndarray, s: np.ndarray, *, n_boot: int = 200, seed: int = 0, max_n: int = 200_000) -> dict[str, float]:
    rng = np.random.default_rng(seed)
    mask = ~np.isnan(y)
    y, s = y[mask].astype(int), s[mask]
    if len(y) > max_n:
        idx = rng.choice(len(y), max_n, replace=False)
        y, s = y[idx], s[idx]
    if len(np.unique(y)) < 2:
        return {"auc": None, "ci_low": None, "ci_high": None, "ap": None, "n": len(y)}
    auc = roc_auc_score(y, s)
    ap = average_precision_score(y, s)
    vals = []
    n = len(y)
    for _ in range(n_boot):
        i = rng.integers(0, n, n)
        if len(np.unique(y[i])) < 2:
            continue
        vals.append(roc_auc_score(y[i], s[i]))
    lo, hi = (np.quantile(vals, [0.025, 0.975]) if vals else (auc, auc))
    return {"auc": float(auc), "ci_low": float(lo), "ci_high": float(hi), "ap": float(ap), "prevalence": float(y.mean()), "n": int(n)}


def boot_diff_auc(y: np.ndarray, a: np.ndarray, b: np.ndarray, *, n_boot: int = 200, seed: int = 0, max_n: int = 200_000) -> dict[str, float]:
    """Paired bootstrap CI of AUC(a) − AUC(b)."""
    rng = np.random.default_rng(seed)
    mask = ~np.isnan(y)
    y, a, b = y[mask].astype(int), a[mask], b[mask]
    if len(y) > max_n:
        idx = rng.choice(len(y), max_n, replace=False)
        y, a, b = y[idx], a[idx], b[idx]
    d0 = roc_auc_score(y, a) - roc_auc_score(y, b)
    vals = []
    for _ in range(n_boot):
        i = rng.integers(0, len(y), len(y))
        if len(np.unique(y[i])) < 2:
            continue
        vals.append(roc_auc_score(y[i], a[i]) - roc_auc_score(y[i], b[i]))
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {"delta": float(d0), "ci_low": float(lo), "ci_high": float(hi)}


def boot_spearman(x: np.ndarray, y: np.ndarray, *, n_boot: int = 500, seed: int = 0) -> dict[str, float]:
    from scipy.stats import spearmanr

    rng = np.random.default_rng(seed)
    m = ~(np.isnan(x) | np.isnan(y))
    x, y = x[m], y[m]
    if len(x) < 5:
        return {"rho": None, "ci_low": None, "ci_high": None, "n": len(x)}
    rho = spearmanr(x, y).statistic
    vals = [spearmanr(x[i], y[i]).statistic for i in (rng.integers(0, len(x), len(x)) for _ in range(n_boot))]
    vals = [v for v in vals if np.isfinite(v)]
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {"rho": float(rho), "ci_low": float(lo), "ci_high": float(hi), "n": len(x)}


def boot_mean_diff(a: np.ndarray, b: np.ndarray, *, n_boot: int = 2000, seed: int = 0) -> dict[str, float]:
    rng = np.random.default_rng(seed)
    d = float(np.mean(a) - np.mean(b))
    vals = [np.mean(rng.choice(a, len(a))) - np.mean(rng.choice(b, len(b))) for _ in range(n_boot)]
    lo, hi = np.quantile(vals, [0.025, 0.975])
    return {"before": float(np.mean(a)), "after": float(np.mean(b)), "delta": d, "ci_low": float(lo), "ci_high": float(hi)}


# ---------------------------------------------------------------- alarm evaluation


def volume_alarms(bins: pd.DataFrame, *, z: float = 3.0, window: int = 24) -> np.ndarray:
    """Baseline detector: rolling z-score of event volume (past-only)."""
    v = bins["n_events"].astype(float)
    mu = v.shift(1).rolling(window, min_periods=window).mean()
    sd = v.shift(1).rolling(window, min_periods=window).std()
    return ((v - mu) / sd.replace(0, np.nan) >= z).fillna(False).to_numpy()


def dup_alarms(ann: pd.DataFrame, bins: pd.DataFrame, freq: str, *, z: float = 3.0, window: int = 24) -> np.ndarray:
    """Baseline detector: rolling z-score of exact-duplicate share (past-only)."""
    named = ann[ann["xid"].notna()]
    dupe = named.duplicated(["bin", "xid"], keep=False)
    share = dupe.groupby(named["bin"]).mean().reindex(bins["bin"]).fillna(0.0).reset_index(drop=True)
    mu = share.shift(1).rolling(window, min_periods=window).mean()
    sd = share.shift(1).rolling(window, min_periods=window).std()
    return ((share - mu) / sd.replace(0, np.nan) >= z).fillna(False).to_numpy()


def onsets_from_share(share: np.ndarray, *, up: float = 0.2, down: float = 0.1, smooth: int = 6) -> list[int]:
    """Campaign onsets: rolling share crosses ``up`` after having been below ``down`` (hysteresis)."""
    s = pd.Series(share).fillna(0.0).rolling(smooth, min_periods=1).mean().to_numpy()
    out, armed = [], True
    for i, v in enumerate(s):
        if armed and v >= up:
            out.append(i)
            armed = False
        elif not armed and v < down:
            armed = True
    return out


def onset_eval(alarms: np.ndarray, onsets: list[int], *, before: int = 6, after: int = 48) -> dict[str, Any]:
    """Detection delay per onset + alarms outside every onset window (false alarms)."""
    n = len(alarms)
    in_win = np.zeros(n, dtype=bool)
    delays: list[int | None] = []
    for o in onsets:
        lo, hi = max(0, o - before), min(n, o + after + 1)
        in_win[lo:hi] = True
        hit = np.flatnonzero(alarms[lo:hi])
        delays.append(int(lo + hit[0] - o) if len(hit) else None)
    a = np.flatnonzero(alarms)
    false = int((~in_win[a]).sum()) if len(a) else 0
    det = [d for d in delays if d is not None]
    return {
        "n_onsets": len(onsets),
        "detected": len(det),
        "delays_h": delays,
        "median_delay_h": float(np.median(det)) if det else None,
        "n_alarms": len(a),
        "false_alarms": false,
    }


def episode_eval(alarms: np.ndarray, surge: np.ndarray, *, tol: int = 3) -> dict[str, Any]:
    """Precision of alarm bins vs labelled surge bins (±tol), recall over surge episodes."""
    n = len(alarms)
    near = np.zeros(n, dtype=bool)
    idx = np.flatnonzero(surge)
    for i in idx:
        near[max(0, i - tol) : min(n, i + tol + 1)] = True
    a_idx = np.flatnonzero(alarms)
    prec_hits = int(near[a_idx].sum()) if len(a_idx) else 0
    # Episodes = maximal runs of surge bins
    eps: list[tuple[int, int]] = []
    start = None
    for i, s in enumerate(surge):
        if s and start is None:
            start = i
        if not s and start is not None:
            eps.append((start, i - 1))
            start = None
    if start is not None:
        eps.append((start, n - 1))
    detected, delays = 0, []
    for s0, s1 in eps:
        lo, hi = max(0, s0 - tol), min(n, s1 + 1)
        hit = np.flatnonzero(alarms[lo:hi])
        if len(hit):
            detected += 1
            delays.append(int(lo + hit[0] - s0))
    k = len(a_idx)
    p_lo, p_hi = attribution.wilson(prec_hits, k)
    r_lo, r_hi = attribution.wilson(detected, len(eps))
    return {
        "n_alarms": k,
        "precision": prec_hits / k if k else None,
        "precision_ci": [p_lo, p_hi],
        "n_episodes": len(eps),
        "recall": detected / len(eps) if eps else None,
        "recall_ci": [r_lo, r_hi],
        "median_delay_bins": float(np.median(delays)) if delays else None,
    }


# ---------------------------------------------------------------- Moltbook


def backtest_moltbook() -> dict[str, Any]:
    info = datasets.REGISTRY["moltbook"]
    if not info.available():
        return {"dataset": "moltbook", "skipped": "data not downloaded (pz datasets fetch moltbook)"}
    t0 = time.perf_counter()
    df = datasets.load_moltbook()
    load_s = time.perf_counter() - t0
    log(f"[moltbook] {len(df):,} posts loaded in {load_s:.1f}s")
    p = ScanParams.from_dict(info.defaults)
    cp = p.coord()
    t1 = time.perf_counter()
    ann = coord.annotate(df, cp)
    bins = coord.bin_signals(ann, cp)
    engine_s = time.perf_counter() - t1
    log(f"[moltbook] signatures+bins in {engine_s:.1f}s ({len(bins)} bins)")

    # 1. Post-level: does the coordination score rank platform-flagged spam above organic posts?
    es = coord.event_scores(ann, cp)
    y = es["label"].to_numpy(dtype=float)
    rng = np.random.default_rng(0)
    post = {
        "ours_template_cluster": boot_auc(y, es["ours"].to_numpy()),
        "baseline_exact_duplicate": boot_auc(y, es["exact_dup"].to_numpy()),
        "baseline_author_volume": boot_auc(y, es["author_volume"].to_numpy()),
        "baseline_random": boot_auc(y, rng.random(len(y))),
    }
    post["delta_vs_exact_dup"] = boot_diff_auc(y, es["ours"].to_numpy(), es["exact_dup"].to_numpy())
    post["delta_vs_volume"] = boot_diff_auc(y, es["ours"].to_numpy(), es["author_volume"].to_numpy())
    log(f"[moltbook] post AUROC ours={post['ours_template_cluster']['auc']:.3f} dup={post['baseline_exact_duplicate']['auc']:.3f} vol={post['baseline_author_volume']['auc']:.3f}")

    # 2. Agent-level: majority-spam agents vs the rest.
    ac = coord.actor_scores(ann, cp)
    ac = ac[ac["n_events"] >= 2]
    ya = (ac["label_rate"] >= 0.5).astype(float).to_numpy()
    agent = {
        "ours_coord_score": boot_auc(ya, ac["score"].to_numpy()),
        "baseline_dup_frac": boot_auc(ya, ac["dup_frac"].to_numpy()),
        "baseline_n_posts": boot_auc(ya, ac["n_events"].to_numpy(dtype=float)),
        "n_agents": len(ac),
    }
    log(f"[moltbook] agent AUROC ours={agent['ours_coord_score']['auc']:.3f} dup={agent['baseline_dup_frac']['auc']:.3f} vol={agent['baseline_n_posts']['auc']:.3f}")

    # 3. Bin-level: does C_t track the hourly spam share better than raw volume?
    lr = bins["label_rate"].to_numpy(dtype=float)
    bin_level = {
        "spearman_C_vs_spam_share": boot_spearman(bins["C"].to_numpy(dtype=float), lr),
        "spearman_volume_vs_spam_share": boot_spearman(bins["n_events"].to_numpy(dtype=float), lr),
    }

    # 4. Online alarms vs labelled spam surges (top-decile hourly spam share), against baselines.
    tl = detect_bins(bins, alpha=p.alpha, warmup=p.warmup, m_min=p.m_min, seed=0)
    active = bins["n_events"].to_numpy() >= 20
    thr = np.nanquantile(lr[active], 0.9)
    surge = np.nan_to_num(lr, nan=0.0) >= thr
    surge &= active
    warm = np.arange(len(bins)) >= p.warmup
    detectors = {
        "ours_e_detector": tl["alarm"].to_numpy() & warm,
        "baseline_volume_z3": volume_alarms(bins) & warm,
        "baseline_dup_share_z3": dup_alarms(ann, bins, p.freq) & warm,
    }
    alarms_eval = {k: episode_eval(v, surge & warm) for k, v in detectors.items()}
    alarms_eval["surge_threshold_spam_share"] = float(thr)

    landmarks = {lm["label"]: pd.Timestamp(lm["t"]) for lm in info.landmarks}
    wave = landmarks["mbc-20 bot wave begins"]
    first_after = tl.loc[tl["alarm"] & (tl["bin"] >= wave - pd.Timedelta(hours=24)), "bin"]
    wave_alarm = first_after.iloc[0] if len(first_after) else None

    # 4b. Campaign ground truth: the mbc-20 inscription protocol marker. The engine never sees this
    # rule (it folds text into generic templates), so this asks whether an unsupervised detector
    # recovers a known bot campaign. ``is_spam`` above is kept as reported, but it is a noisy
    # platform flag (19% of wave posts vs 11% of others; collapses on Feb 14 mid-wave).
    wave_y = df["text"].str.contains(r"mbc-?20", case=False, regex=True, na=False).astype(float)
    ann_w = ann.assign(label=wave_y.to_numpy())
    es_w = coord.event_scores(ann_w, cp)
    yw = es_w["label"].to_numpy(dtype=float)
    ac_w = coord.actor_scores(ann_w, cp)
    ac_w = ac_w[ac_w["n_events"] >= 2]
    yaw = (ac_w["label_rate"] >= 0.5).astype(float).to_numpy()
    bins_w = coord.bin_signals(ann_w, cp)
    share = bins_w["label_rate"].to_numpy(dtype=float)
    onsets = onsets_from_share(share)
    wave_eval = {
        "label": "post carries the mbc-20 protocol marker (regex mbc-?20); not used by the engine",
        "prevalence": finite(yw.mean()),
        "post_level": {
            "ours_template_cluster": boot_auc(yw, es_w["ours"].to_numpy()),
            "baseline_exact_duplicate": boot_auc(yw, es_w["exact_dup"].to_numpy()),
            "baseline_author_volume": boot_auc(yw, es_w["author_volume"].to_numpy()),
            "delta_vs_exact_dup": boot_diff_auc(yw, es_w["ours"].to_numpy(), es_w["exact_dup"].to_numpy()),
        },
        "agent_level": {
            "ours_coord_score": boot_auc(yaw, ac_w["score"].to_numpy()),
            "baseline_dup_frac": boot_auc(yaw, ac_w["dup_frac"].to_numpy()),
            "baseline_n_posts": boot_auc(yaw, ac_w["n_events"].to_numpy(dtype=float)),
            "n_agents": len(ac_w),
        },
        "bin_level": {
            "spearman_C_vs_wave_share": boot_spearman(bins_w["C"].to_numpy(dtype=float), share),
            "spearman_volume_vs_wave_share": boot_spearman(bins_w["n_events"].to_numpy(dtype=float), share),
        },
        "onsets": [bins_w["bin"].iloc[i].isoformat() for i in onsets],
        "onset_detection": {k: onset_eval(v, onsets) for k, v in detectors.items()},
    }
    log(
        f"[moltbook] wave post AUROC ours={wave_eval['post_level']['ours_template_cluster']['auc']:.3f} "
        f"dup={wave_eval['post_level']['baseline_exact_duplicate']['auc']:.3f}; onsets={wave_eval['onsets']}"
    )

    # 5. Natural experiment: anti-spam enforcement (Feb 17) — coordinated share 7d before vs after.
    enf = landmarks["Anti-spam enforcement"]
    pre = bins[(bins["bin"] >= enf - pd.Timedelta(days=7)) & (bins["bin"] < enf) & (bins["n_events"] > 0)]["C"].to_numpy()
    post_ = bins[(bins["bin"] >= enf + pd.Timedelta(days=1)) & (bins["bin"] < enf + pd.Timedelta(days=8)) & (bins["n_events"] > 0)]["C"].to_numpy()
    intervention = boot_mean_diff(pre, post_) if len(pre) and len(post_) else None

    arl = permutation_arl(bins, n_perm=30, alpha=p.alpha, warmup=p.warmup, m_min=p.m_min)

    cl = coord.clusters(ann, cp, top=10)
    top_clusters = [
        {"template": r["template"], "n_actors": int(r["n_actors"]), "n_events": int(r["n_events"]), "label_rate": finite(r["label_rate"]), "sample": r["sample"]}
        for r in cl.to_dict(orient="records")
    ]
    timeline = [
        {"t": b.isoformat().replace("+00:00", "Z"), "C": finite(c), "spam": finite(s), "n": int(n), "log10_S": finite(ls), "alarm": bool(a)}
        for b, c, s, n, ls, a in zip(tl["bin"], tl["C"], tl["label_rate"], tl["n_events"], tl["log10_S"], tl["alarm"], strict=True)
    ]
    return {
        "dataset": "moltbook",
        "source": info.url,
        "n_posts": len(df),
        "n_agents": int(df["actor"].nunique()),
        "spam_rate": finite(df["label"].mean()),
        "params": p.__dict__,
        "post_level": post,
        "agent_level": agent,
        "bin_level": bin_level,
        "alarms": alarms_eval,
        "wave_campaign": wave_eval,
        "wave_onset": wave.isoformat(),
        "first_alarm_near_wave": wave_alarm.isoformat() if wave_alarm is not None else None,
        "wave_alarm_lead_h": finite((wave - wave_alarm).total_seconds() / 3600) if wave_alarm is not None else None,
        "intervention_feb17": intervention,
        "null_false_alarms": arl,
        "top_clusters": top_clusters,
        "timeline": timeline,
        "timings": {"load_s": load_s, "engine_s": engine_s, "events_per_s": len(df) / max(engine_s, 1e-9)},
    }


# ---------------------------------------------------------------- collusion.wiki


def backtest_wiki() -> dict[str, Any]:
    info = datasets.REGISTRY["wiki"]
    if not info.available():
        return {"dataset": "wiki", "skipped": "data not downloaded"}
    df = datasets.load_wiki()
    p = ScanParams.from_dict(info.defaults)
    cp = p.coord()
    t1 = time.perf_counter()
    ann = coord.annotate(df, cp)
    bins = coord.bin_signals(ann, cp)
    tl = detect_bins(bins, alpha=p.alpha, warmup=p.warmup, m_min=p.m_min, seed=0)
    engine_s = time.perf_counter() - t1
    alarms = [b.isoformat().replace("+00:00", "Z") for b in tl.loc[tl["alarm"], "bin"]]
    lms = {lm["label"]: pd.Timestamp(lm["t"]) for lm in info.landmarks}
    hq = lms["OpenAI-HQ IPs appear"]
    before = [a for a in tl.loc[tl["alarm"], "bin"] if a < hq]
    out: dict[str, Any] = {
        "dataset": "wiki",
        "n_revisions": len(df),
        "n_actors": int(df["actor"].nunique()),
        "params": p.__dict__,
        "alarms": alarms,
        "first_alarm": alarms[0] if alarms else None,
        "landmarks": info.landmarks,
        "lead_h_first_alarm_vs_21jun": finite((hq - before[0]).total_seconds() / 3600) if before else None,
        "null_false_alarms": arl if (arl := permutation_arl(bins, n_perm=50, alpha=p.alpha, warmup=p.warmup, m_min=p.m_min)) else None,
        "timeline": [
            {"t": b.isoformat().replace("+00:00", "Z"), "C": finite(c), "n": int(n), "log10_S": finite(ls), "alarm": bool(a)}
            for b, c, n, ls, a in zip(tl["bin"], tl["C"], tl["n_events"], tl["log10_S"], tl["alarm"], strict=True)
        ],
        "timings": {"engine_s": engine_s},
    }
    # Sensitivity: the headline uses the engine's standard params (no wiki tuning); every
    # alternative bin size / threshold is reported, including the ones that miss.
    grid = []
    for freq, warm, win in (("1h", 48, 6), ("3h", 24, 2), ("6h", 20, 2)):
        for ma in (3, 5):
            q = ScanParams(freq=freq, min_actors=ma, warmup=warm, m_min=p.m_min, window=win, alpha=p.alpha)
            qa = coord.annotate(df, q.coord())
            qt = detect_bins(coord.bin_signals(qa, q.coord()), alpha=q.alpha, warmup=q.warmup, m_min=q.m_min, seed=0)
            al = qt.loc[qt["alarm"], "bin"]
            first = al.iloc[0] if len(al) else None
            grid.append(
                {
                    "freq": freq,
                    "min_actors": ma,
                    "n_alarms": len(al),
                    "first_alarm": first.isoformat() if first is not None else None,
                    "lead_h_vs_21jun": finite((hq - first).total_seconds() / 3600) if first is not None and first < hq else None,
                    "max_log10_S": finite(qt["log10_S"].max()),
                }
            )
    out["sensitivity"] = grid
    # Actor-level labels: archive handle table marks human vs agent handles.
    lab_path = datasets.DATA / "wiki" / "labels.jsonl.gz"
    if lab_path.exists():
        with gzip.open(lab_path, "rt", encoding="utf-8") as fh:
            labels = [json.loads(line) for line in fh]
        is_agent = {f"wiki:{r['label']}": 0.0 if r.get("is_human_handle") else 1.0 for r in labels if r.get("label")}
        ac = coord.actor_scores(ann, cp)
        ac["y"] = ac["actor"].map(is_agent)
        ac = ac[ac["y"].notna()]
        y = ac["y"].to_numpy(dtype=float)
        out["actor_level"] = {
            "task": "agent handle (1) vs human handle (0), archive labels.jsonl",
            "n_actors": len(ac),
            "n_human": int((y == 0).sum()),
            "ours_coord_score": boot_auc(y, ac["score"].to_numpy()) if (y == 0).any() else None,
            "baseline_n_edits": boot_auc(y, ac["n_events"].to_numpy(dtype=float)) if (y == 0).any() else None,
            "baseline_dup_frac": boot_auc(y, ac["dup_frac"].to_numpy()) if (y == 0).any() else None,
        }
    return out


# ---------------------------------------------------------------- Who&When


def backtest_whowhen() -> dict[str, Any]:
    info = datasets.REGISTRY["whowhen"]
    if not info.available():
        return {"dataset": "whowhen", "skipped": "data not downloaded"}
    alg = attribution._rows(pd.read_parquet(datasets.DATA / "whowhen" / "Algorithm-Generated.parquet"))
    hand = attribution._rows(pd.read_parquet(datasets.DATA / "whowhen" / "Hand-Crafted.parquet"))
    out: dict[str, Any] = {"dataset": "whowhen", "source": info.url, "splits": {}}
    out["cv5"] = {}
    for name, rows in (("algorithm", alg), ("hand", hand)):
        cv = attribution.cross_validate(rows, k=5, seed=0)
        out["cv5"][name] = cv
        log(f"[whowhen] cv5 {name}: agent={cv['agent_acc']:.3f} step={cv['step_acc']:.3f} baselines={ {k: round(v, 3) for k, v in cv['baselines_agent_acc'].items()} }")
    for train_name, train, test_name, test in (("algorithm", alg, "hand", hand), ("hand", hand, "algorithm", alg)):
        prior = attribution.role_prior(train)
        w, train_m = attribution.fit(train, prior)
        m = attribution.evaluate(test, w, attribution.featurize(test, prior))
        a_ci = attribution.wilson(m["agent_hits"], m["n"])
        s_ci = attribution.wilson(m["step_hits"], m["n"])
        out["splits"][f"train_{train_name}_test_{test_name}"] = {
            "weights": dict(zip(attribution.FEATURES, w.tolist(), strict=True)),
            "train": {k: train_m[k] for k in ("agent_acc", "step_acc", "n")},
            "test": {"agent_acc": m["agent_acc"], "agent_ci": a_ci, "step_acc": m["step_acc"], "step_ci": s_ci, "n": m["n"]},
            "baselines_on_test": attribution.baselines(test, train),
        }
        log(f"[whowhen] train={train_name} test={test_name}: agent={m['agent_acc']:.3f} step={m['step_acc']:.3f}")
    out["reference"] = "Zhang et al. ICML 2025: best LLM method 53.5% agent-level, 14.2% step-level (paper abstract)."
    return out


# ---------------------------------------------------------------- driver


def backtest_synthetic() -> dict[str, Any]:
    """Labelled swarm from the in-process generator. No download. The label is not an input to the detector."""
    from kollude.demo_data import frame, onset_time

    df, onset = frame()
    p = ScanParams.from_dict(datasets.REGISTRY["synthetic"].defaults)
    cp = p.coord()
    ann = coord.annotate(df, cp)
    es = coord.event_scores(ann, cp)
    y = es["label"].fillna(0).to_numpy(dtype=float)
    post = {
        "ours_template_cluster": boot_auc(y, es["ours"].to_numpy(), n_boot=80),
        "baseline_author_volume": boot_auc(y, es["author_volume"].to_numpy(), n_boot=80),
    }
    tl = detect_bins(coord.bin_signals(ann, cp), alpha=p.alpha, warmup=p.warmup, m_min=p.m_min, seed=0)
    alarm_at = np.flatnonzero(tl["alarm"].to_numpy())
    after = alarm_at[alarm_at >= onset] if len(alarm_at) else alarm_at
    first = int(after[0]) if len(after) else None
    delay = (first - onset) if first is not None else None
    # Same rule as stress._detect: catch the injected onset, and count earlier organic alarms apart from it.
    detected = delay is not None and delay <= 24
    before = int(np.sum(alarm_at < onset)) if len(alarm_at) else 0
    log(f"[synthetic] post AUROC ours={post['ours_template_cluster']['auc']:.3f} vol={post['baseline_author_volume']['auc']:.3f} delay={delay} detected={detected} early={before}")
    return {
        "dataset": "synthetic",
        "n_events": len(df),
        "onset": onset_time().isoformat(),
        "onset_bin": int(onset),
        "post_level": post,
        "first_alarm_bin": first,
        "delay_bins": delay,
        "detected": bool(detected),
        "n_alarms": len(alarm_at),
        "alarms_before_window": before,
        "note": "Generator label (injected swarm vs organic). The detector sees text only. "
        "Delay is the first alarm at or after the injected onset. Earlier alarms are recurring human catchphrases, counted separately.",
    }


RUNNERS = {"synthetic": backtest_synthetic, "moltbook": backtest_moltbook, "wiki": backtest_wiki, "whowhen": backtest_whowhen}


def run(names: list[str] | None = None) -> dict[str, Any]:
    OUT.mkdir(parents=True, exist_ok=True)
    results: dict[str, Any] = {}
    for name in names or list(RUNNERS):
        t0 = time.perf_counter()
        try:
            res = RUNNERS[name]()
        except Exception as e:  # one dataset failing must not hide the others
            import traceback

            res = {"dataset": name, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc(limit=4)}
        res["wall_s"] = time.perf_counter() - t0
        results[name] = res
        (OUT / f"{name}.json").write_text(json.dumps(res, indent=2, default=str), encoding="utf-8")
        log(f"[{name}] done in {res['wall_s']:.1f}s")
    merged = {}
    if UI.exists():
        try:
            merged = json.loads(UI.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            merged = {}
    merged.update(results)
    merged["updated_at"] = pd.Timestamp.now(tz="UTC").isoformat()
    if UI.parent.exists():
        UI.write_text(json.dumps(merged, default=str), encoding="utf-8")
    write_report(merged)
    return results


def _f(x: Any, nd: int = 3) -> str:
    return "—" if x is None else f"{x:.{nd}f}"


def _auc(d: dict | None) -> str:
    if not d or d.get("auc") is None:
        return "—"
    return f"{d['auc']:.3f} [{d['ci_low']:.3f}, {d['ci_high']:.3f}]"


def write_report(r: dict[str, Any]) -> None:
    L = ["# Backtest report — real labelled data", "", f"_Generated {r.get('updated_at')}. 95% bootstrap / Wilson intervals._", ""]
    m = r.get("moltbook") or {}
    if m and not m.get("skipped") and not m.get("error"):
        pl, al = m["post_level"], m["agent_level"]
        L += [
            "## Moltbook (AI-agent social network, platform `is_spam` labels)",
            f"{m['n_posts']:,} posts · {m['n_agents']:,} agents · spam rate {_f(m['spam_rate'])}",
            "",
            "| Task | Ours | Exact-duplicate | Volume | Random |",
            "|---|---|---|---|---|",
            f"| Post AUROC | **{_auc(pl['ours_template_cluster'])}** | {_auc(pl['baseline_exact_duplicate'])} | {_auc(pl['baseline_author_volume'])} | {_auc(pl['baseline_random'])} |",
            f"| Agent AUROC | **{_auc(al['ours_coord_score'])}** | {_auc(al['baseline_dup_frac'])} | {_auc(al['baseline_n_posts'])} | 0.5 |",
            "",
            f"- ΔAUROC vs exact-dup: {_f(pl['delta_vs_exact_dup']['delta'])} [{_f(pl['delta_vs_exact_dup']['ci_low'])}, {_f(pl['delta_vs_exact_dup']['ci_high'])}]",
            f"- Spearman(C_t, hourly spam share): {_f(m['bin_level']['spearman_C_vs_spam_share']['rho'])} vs volume {_f(m['bin_level']['spearman_volume_vs_spam_share']['rho'])}",
            "",
            "| Online detector | Alarms | Precision | Surge recall | Median delay (h) |",
            "|---|---:|---|---|---:|",
        ]
        for k in ("ours_e_detector", "baseline_volume_z3", "baseline_dup_share_z3"):
            e = m["alarms"][k]
            L.append(
                f"| {k} | {e['n_alarms']} | {_f(e['precision'])} [{_f(e['precision_ci'][0])}, {_f(e['precision_ci'][1])}] | "
                f"{_f(e['recall'])} [{_f(e['recall_ci'][0])}, {_f(e['recall_ci'][1])}] | {_f(e['median_delay_bins'], 1)} |"
            )
        wc = m.get("wave_campaign") or {}
        if wc:
            wp, wa, wb = wc["post_level"], wc["agent_level"], wc["bin_level"]
            L += [
                "",
                "### Campaign ground truth: mbc-20 bot wave (protocol marker, unseen by the engine)",
                f"Prevalence {_f(wc['prevalence'])} · onsets {', '.join(o[:13] for o in wc['onsets'])}",
                "",
                "| Task | Ours | Exact-duplicate | Volume |",
                "|---|---|---|---|",
                f"| Post AUROC | **{_auc(wp['ours_template_cluster'])}** | {_auc(wp['baseline_exact_duplicate'])} | {_auc(wp['baseline_author_volume'])} |",
                f"| Agent AUROC | **{_auc(wa['ours_coord_score'])}** | {_auc(wa['baseline_dup_frac'])} | {_auc(wa['baseline_n_posts'])} |",
                f"| Spearman(bin, wave share) | **{_f(wb['spearman_C_vs_wave_share']['rho'])}** | — | {_f(wb['spearman_volume_vs_wave_share']['rho'])} |",
                "",
                "| Online detector | Onsets detected | Delays (h) | Alarms | Alarms outside onset windows |",
                "|---|---|---|---:|---:|",
            ]
            for k, e in wc["onset_detection"].items():
                L.append(f"| {k} | {e['detected']}/{e['n_onsets']} | {e['delays_h']} | {e['n_alarms']} | {e['false_alarms']} |")
        iv = m.get("intervention_feb17") or {}
        nf = m.get("null_false_alarms") or {}
        L += [
            "",
            f"- First alarm near mbc-20 wave onset ({m['wave_onset'][:10]}): {m.get('first_alarm_near_wave')} (lead {_f(m.get('wave_alarm_lead_h'), 1)} h)",
            f"- Feb 17 enforcement: coordinated share {_f(iv.get('before'))} → {_f(iv.get('after'))}, Δ {_f(iv.get('delta'))} [{_f(iv.get('ci_low'))}, {_f(iv.get('ci_high'))}]",
            f"- Null (time-shuffled) false alarms / 1000 bins: {_f(nf.get('false_alarms_per_1000_bins'), 2)} (bound {nf.get('bound_per_1000_bins')})",
            f"- Throughput: {m['timings']['events_per_s']:,.0f} events/s",
            "",
        ]
    w = r.get("wiki") or {}
    if w and not w.get("skipped") and not w.get("error"):
        al = w.get("actor_level") or {}
        nf = w.get("null_false_alarms") or {}
        L += [
            "## collusion.wiki",
            f"{w['n_revisions']:,} revisions · {w['n_actors']} handles · first alarm {w.get('first_alarm')} · lead vs 21 Jun {_f(w.get('lead_h_first_alarm_vs_21jun'), 1)} h",
            f"- Null false alarms / 1000 bins: {_f(nf.get('false_alarms_per_1000_bins'), 2)} (bound {nf.get('bound_per_1000_bins')})",
        ]
        if al:
            L.append(
                f"- Agent-vs-human handle AUROC: ours {_auc(al.get('ours_coord_score'))} · edits {_auc(al.get('baseline_n_edits'))} · dup {_auc(al.get('baseline_dup_frac'))} "
                f"(n={al['n_actors']}, humans={al['n_human']} — too few human handles for a reliable interval; not a headline)"
            )
        if w.get("sensitivity"):
            L += ["", "| Bin | min_actors | Alarms | First alarm | Lead vs 21 Jun (h) | max log10 S |", "|---|---:|---:|---|---:|---:|"]
            for g_ in w["sensitivity"]:
                L.append(f"| {g_['freq']} | {g_['min_actors']} | {g_['n_alarms']} | {g_['first_alarm'] or '—'} | {_f(g_['lead_h_vs_21jun'], 1)} | {_f(g_['max_log10_S'], 2)} |")
        L.append("")
    ww = r.get("whowhen") or {}
    if ww and not ww.get("skipped") and not ww.get("error"):
        L += ["## Who&When failure attribution (no LLM)", ""]
        if ww.get("cv5"):
            L += [
                "5-fold CV within each subset (role prior + weights fit on training folds only):",
                "",
                "| Subset | Agent acc | Step acc | Random | Most-msgs | First | Last | Train-prior |",
                "|---|---|---|---|---|---|---|---|",
            ]
            for k, c in ww["cv5"].items():
                b = c["baselines_agent_acc"]
                L.append(
                    f"| {k} (n={c['n']}) | **{_f(c['agent_acc'])}** [{_f(c['agent_ci'][0])}, {_f(c['agent_ci'][1])}] | {_f(c['step_acc'])} [{_f(c['step_ci'][0])}, {_f(c['step_ci'][1])}] | "
                    f"{_f(b.get('random'))} | {_f(b.get('most_messages'))} | {_f(b.get('first_agent'))} | {_f(b.get('last_agent'))} | {_f(b.get('train_prior'))} |"
                )
            L += [""]
        L += [
            "Cross-domain transfer (train on one system, test on the other — agent names do not overlap):",
            "",
            "| Split | Agent acc | Step acc | Random | Most-msgs | First | Last | Train-prior |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for k, s in ww["splits"].items():
            t, b = s["test"], s["baselines_on_test"]
            L.append(
                f"| {k} | **{_f(t['agent_acc'])}** [{_f(t['agent_ci'][0])}, {_f(t['agent_ci'][1])}] | {_f(t['step_acc'])} [{_f(t['step_ci'][0])}, {_f(t['step_ci'][1])}] | "
                f"{_f(b['random']['agent_acc'])} | {_f(b['most_messages']['agent_acc'])} | {_f(b.get('first_agent', {}).get('agent_acc'))} | "
                f"{_f(b.get('last_agent', {}).get('agent_acc'))} | {_f(b['train_prior']['agent_acc'])} |"
            )
        L += ["", f"_{ww['reference']}_", ""]
    syn = r.get("synthetic") or {}
    if syn and not syn.get("error") and syn.get("post_level"):
        pl = syn["post_level"]
        L += [
            "## Synthetic swarm (generator ground truth, no download)",
            f"{syn['n_events']:,} events · onset {syn.get('onset')} · swarm caught {syn.get('detected')} · delay after onset {syn.get('delay_bins')} bins · organic alarms before onset {syn.get('alarms_before_window')}",
            "",
            "| Task | Ours | Volume |",
            "|---|---|---|",
            f"| Post AUROC | **{_auc(pl['ours_template_cluster'])}** | {_auc(pl['baseline_author_volume'])} |",
            "",
            f"_{syn.get('note', '')}_",
            "",
        ]
    s = r.get("stress") or {}
    if s and not s.get("error"):
        L += [
            "## Stress (synthetic, exact ground truth)",
            "",
            f"_{s.get('design', '')}_",
            "",
            "| Events | Scan s | Events/s | Frame MB | Swarm detected | Delay (bins) | False alarms before onset |",
            "|---:|---:|---:|---:|---|---:|---:|",
        ]
        for row in s.get("scale", []):
            L.append(
                f"| {row['events']:,} | {row['seconds']:.1f} | {row['events_per_s']:,.0f} | {row.get('frame_mb', 0):.0f} | "
                f"{row['detected']} | {_f(row.get('delay_bins'), 0)} | {row['false_alarms_before_onset']} |"
            )
        L += ["", "| Swarm share of traffic | Evasive | Detection rate | Median delay (bins) | Pre-onset FA / 1000 bins |", "|---:|---|---|---:|---:|"]
        for row in s.get("power", []) + s.get("evasion", []):
            ci = row["detection_ci"]
            L.append(
                f"| {row['swarm_share']:.3f} | {row['evasive']} | {_f(row['detection_rate'], 2)} [{_f(ci[0], 2)}, {_f(ci[1], 2)}] (n={row['seeds']}) | "
                f"{_f(row['median_delay_bins'], 1)} | {_f(row['false_alarms_before_onset_per_1000_bins'], 2)} |"
            )
        ab = s.get("ablation_per_bin_prefix_only") or {}
        if ab:
            L += ["", "Ablation — same swarms, per-bin + prefix-only signatures (the v0.1 engine):", ""]
            for row in ab.get("power", []) + ab.get("evasion", []):
                L.append(f"- share {row['swarm_share']:.3f} evasive={row['evasive']}: detection {_f(row['detection_rate'], 2)} (n={row['seeds']})")
            L.append(f"- null: {_f((ab.get('null') or {}).get('per_1000_bins'), 2)} / 1000 bins")
        nl, fz = s.get("null") or {}, s.get("fuzz") or {}
        L += [
            "",
            f"- No-swarm null: {nl.get('false_alarms')} alarms in {nl.get('bins')} bins = {_f(nl.get('per_1000_bins'), 2)} / 1000 (bound {nl.get('bound_per_1000_bins')})",
            f"- Fuzz: {fz.get('rounds', 0) - fz.get('failures', 0)}/{fz.get('rounds')} hostile-input rounds passed",
            "",
        ]
    (OUT / "BACKTEST_REPORT.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    import sys

    run(sys.argv[1:] or None)
