"""Coordination engine: template signatures → clusters → per-actor / per-bin signals.

Two axes, never summed (non-promotion):

* **C (content transfer)** — share of events whose *template* (digits, URLs, punctuation
  folded; first ``n_tokens`` words) is used by ≥ ``min_actors`` distinct actors in the
  same time bin.
* **M (identity multiplicity)** — mean distinct actors per coordinated template in the bin.
  One prolific bot repeating itself gives high C-like repetition but M≈1; a swarm of
  sock-puppets gives both.

All heavy work is vectorized pandas; 1M events ≈ seconds, not minutes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc

from kollude.frame import sample_text

MAX_BINS = 200_000


@dataclass(frozen=True)
class CoordParams:
    freq: str = "1h"
    min_actors: int = 5
    n_tokens: int = 12
    min_tokens: int = 4
    max_chars: int = 400
    window: int = 1
    suffix: bool = True


def _arrow(text: pd.Series) -> pa.Array:
    return pa.array(text.fillna("").astype(str).to_numpy(dtype=object), type=pa.large_string())


def _fold(a: pa.Array) -> pa.Array:
    """Lowercase; URLs → ``u``; digit runs → ``0``; non letter/digit runs → one space (RE2, vectorized)."""
    a = pc.utf8_lower(a)
    a = pc.replace_substring_regex(a, r"\[url\]|https?://\S+", " u ")
    a = pc.replace_substring_regex(a, r"\p{N}+", "0")
    a = pc.replace_substring_regex(a, r"[^\p{L}\p{N}]+", " ")
    return pc.utf8_trim_whitespace(a)


def templates(text: pd.Series, *, n_tokens: int = 12, min_tokens: int = 4, max_chars: int = 400, from_end: bool = False) -> pd.Series:
    """Fold text to a near-duplicate template. Short / empty templates → NA (never clustered).

    ``from_end`` uses the last ``n_tokens`` tokens (of the first ``max_chars`` chars) instead of
    the first, so a swarm that randomises its opening words still collides on its tail.
    """
    raw = pc.utf8_slice_codeunits(_arrow(text), 0, max_chars)
    width = 16 * n_tokens
    if from_end:
        # Reverse, take the first n tokens, reverse back: the last n tokens in original order.
        rev = pc.utf8_reverse(raw)
        partial = pc.greater(pc.utf8_length(raw), width)
        cut = pc.utf8_slice_codeunits(rev, 0, width)
        cut = pc.if_else(partial, pc.replace_substring_regex(cut, r"\S*\s*$", ""), cut)
        folded = pc.utf8_reverse(_fold(pc.utf8_reverse(cut)))
    else:
        folded = _fold(pc.utf8_slice_codeunits(raw, 0, width))
    parts = pc.split_pattern(folded, " ", max_splits=n_tokens)
    head = pc.list_slice(parts, 0, n_tokens)
    joined = pc.binary_join(head, pa.scalar(" ", pa.large_string()))
    if from_end:
        joined = pc.utf8_reverse(joined)
    n = pc.list_value_length(head).to_numpy(zero_copy_only=False)
    empty = pc.equal(folded, "").to_numpy(zero_copy_only=False)
    ok = (n >= min_tokens) & ~empty
    out = pd.Series(joined.to_numpy(zero_copy_only=False), index=text.index, dtype=object)
    return out.where(ok)


def template_ids(tmpl: pd.Series) -> pd.Series:
    """Stable 64-bit ids (decimal strings) for templates; NA stays NA."""
    h = pd.util.hash_pandas_object(tmpl.fillna(""), index=False).to_numpy(dtype="uint64")
    return pd.Series(h.astype(str), index=tmpl.index, dtype=object).where(tmpl.notna())


def exact_ids(text: pd.Series) -> pd.Series:
    norm = pd.Series(pc.utf8_trim_whitespace(pc.utf8_lower(_arrow(text))).to_numpy(zero_copy_only=False), index=text.index, dtype=object)
    h = pd.util.hash_pandas_object(norm, index=False).to_numpy(dtype="uint64")
    return pd.Series(h.astype(str), index=text.index, dtype=object).where(norm.str.len() > 0)


def _global_actors(ann: pd.DataFrame, key: str) -> pd.Series:
    named = ann[ann["actor"].notna() & ann[key].notna()]
    return ann[key].map(named.groupby(key)["actor"].nunique()).fillna(0)


def annotate(df: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Add signature columns (copy).

    ``ptid`` / ``stid``: prefix / suffix template ids. ``tid`` / ``tmpl``: the event's cluster key —
    whichever of the two is shared by more distinct actors across the run (prefix on ties).
    ``xid``: exact-text id (baseline). ``bin``: time bin.
    """
    return choose_keys(signatures(df, p))


def signatures(df: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Row-local part of :func:`annotate` (safe to compute incrementally and concatenate)."""
    p = p or CoordParams()
    out = df.copy()
    kw = {"n_tokens": p.n_tokens, "min_tokens": p.min_tokens, "max_chars": p.max_chars}
    ptmpl = templates(out["text"], **kw)
    out["ptmpl"] = ptmpl
    out["ptid"] = template_ids(ptmpl)
    if p.suffix:
        stmpl = templates(out["text"], from_end=True, **kw)
        keep = stmpl.notna() & (stmpl != ptmpl)
        out["stmpl"] = stmpl.where(keep)
        out["stid"] = ("s" + template_ids(stmpl).fillna("")).where(keep)
    else:
        out["stmpl"] = pd.Series(None, index=out.index, dtype=object)
        out["stid"] = pd.Series(None, index=out.index, dtype=object)
    out["xid"] = exact_ids(out["text"])
    out["bin"] = out["t"].dt.floor(p.freq)
    return out


def choose_keys(sig: pd.DataFrame) -> pd.DataFrame:
    """Global part of :func:`annotate`: pick prefix vs suffix cluster key per event (in place)."""
    if sig["stid"].notna().any():
        use_s = _global_actors(sig, "stid") > _global_actors(sig, "ptid")
        sig["tid"] = sig["ptid"].where(~use_s, sig["stid"])
        sig["tmpl"] = sig["ptmpl"].where(~use_s, "… " + sig["stmpl"].fillna(""))
    else:
        sig["tid"], sig["tmpl"] = sig["ptid"], sig["ptmpl"]
    return sig


def _window_actors(ann: pd.DataFrame, key: str, p: CoordParams) -> pd.Series:
    """Per event: distinct actors using its ``key`` signature in bins (b - window, b] (causal)."""
    sub = ann.loc[ann["actor"].notna() & ann[key].notna(), [key, "actor", "bin"]]
    if sub.empty:
        return pd.Series(0, index=ann.index, dtype=float)
    g = sub.groupby(key)["actor"].nunique()
    sub = sub[sub[key].isin(g.index[g >= p.min_actors])].drop_duplicates()
    if sub.empty:
        return pd.Series(0, index=ann.index, dtype=float)
    step = pd.Timedelta(p.freq)
    spread = pd.concat([sub.assign(bin=sub["bin"] + k * step) for k in range(max(p.window, 1))], ignore_index=True)
    ta = spread.groupby([key, "bin"])["actor"].nunique()
    idx = pd.MultiIndex.from_frame(ann[[key, "bin"]])
    return pd.Series(ta.reindex(idx).to_numpy(), index=ann.index).fillna(0)


def coord_events(ann: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Per-event windowed coordination: ``ta`` (best of prefix / suffix) and ``coord`` flag."""
    p = p or CoordParams()
    tp = _window_actors(ann, "ptid", p)
    ts = _window_actors(ann, "stid", p) if p.suffix and ann["stid"].notna().any() else pd.Series(0.0, index=ann.index)
    use_s = ts > tp
    ta = tp.where(~use_s, ts)
    key = ann["ptid"].where(~use_s, ann["stid"])
    return pd.DataFrame({"ta": ta, "key": key, "coord": ta >= p.min_actors}, index=ann.index)


def bin_signals(ann: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Per-bin signal table: n_events, n_actors, C, M, coordinated counts, label share."""
    p = p or CoordParams()
    if ann.empty:
        return pd.DataFrame(columns=["bin", "n_events", "n_actors", "C", "M", "n_coord", "n_coord_templates", "label_rate"])
    ce = coord_events(ann, p)
    hit = ce[ce["coord"]].assign(bin=ann.loc[ce["coord"], "bin"])
    coord = hit.groupby(["bin", "key"])["ta"].first().rename("ta").reset_index()

    base = ann.groupby("bin").agg(n_events=("event_id", "size"), n_actors=("actor", "nunique"))
    base["n_coord"] = ce["coord"].groupby(ann["bin"]).sum()
    tstats = coord.groupby("bin").agg(n_coord_templates=("key", "size"), M=("ta", "mean"), max_ta=("ta", "max"))
    base = base.join(tstats, how="left")
    base["n_coord_templates"] = base["n_coord_templates"].fillna(0).astype(int)
    base["M"] = base["M"].fillna(0.0)
    base["max_ta"] = base["max_ta"].fillna(0).astype(int)
    base["C"] = base["n_coord"] / base["n_events"].clip(lower=1)
    if ann["label"].notna().any():
        base["label_rate"] = ann.groupby("bin")["label"].mean()
    else:
        base["label_rate"] = np.nan
    # Fill empty bins so the timeline is continuous (the detector sees quiet hours too). A stray
    # timestamp (1970 / 9999) would otherwise expand to millions of empty bins: past MAX_BINS
    # only observed bins are kept.
    span = (base.index.max() - base.index.min()) / pd.Timedelta(p.freq)
    if span <= MAX_BINS:
        base = base.reindex(pd.date_range(base.index.min(), base.index.max(), freq=p.freq, tz="UTC"))
    base.index.name = "bin"
    for c in ("n_events", "n_actors", "n_coord", "n_coord_templates", "max_ta"):
        base[c] = base[c].fillna(0).astype(int)
    base["C"] = base["C"].fillna(0.0)
    base["M"] = base["M"].fillna(0.0)
    return base.reset_index()


def clusters(ann: pd.DataFrame, p: CoordParams | None = None, *, top: int = 50) -> pd.DataFrame:
    """Coordinated template clusters across the whole run (≥ min_actors distinct actors)."""
    p = p or CoordParams()
    named = ann[ann["actor"].notna() & ann["tid"].notna()]
    if named.empty:
        return pd.DataFrame(columns=["tid", "template", "n_events", "n_actors", "first_t", "last_t", "span_h", "label_rate", "sample"])
    g = named.groupby("tid").agg(
        template=("tmpl", "first"),
        n_events=("event_id", "size"),
        n_actors=("actor", "nunique"),
        first_t=("t", "min"),
        last_t=("t", "max"),
        label_rate=("label", "mean"),
        sample=("text", "first"),
    )
    g = g[g["n_actors"] >= p.min_actors]
    g["span_h"] = (g["last_t"] - g["first_t"]).dt.total_seconds() / 3600.0
    # Burstiness: many identities in a short span ranks above slow organic reuse.
    g["burst"] = g["n_actors"] / (1.0 + g["span_h"])
    g = g.sort_values(["n_actors", "burst"], ascending=False).head(top)
    g["sample"] = g["sample"].map(lambda s: sample_text(s, 240))
    return g.reset_index()


def actor_scores(ann: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Per-actor coordination score (offline / retrospective).

    ``score`` = fraction of the actor's events whose template is shared by ≥ min_actors
    distinct actors (whole run), × log of the largest such cluster. Baselines kept alongside:
    ``n_events`` (volume) and ``dup_frac`` (exact-duplicate text share).
    """
    p = p or CoordParams()
    named = ann[ann["actor"].notna()].copy()
    if named.empty:
        return pd.DataFrame(columns=["actor", "n_events", "coord_frac", "max_cluster", "score", "dup_frac", "label_rate"])
    ta = named[named["tid"].notna()].groupby("tid")["actor"].nunique()
    named["cluster_actors"] = named["tid"].map(ta).fillna(0)
    named["coord"] = named["cluster_actors"] >= p.min_actors
    xa = named[named["xid"].notna()].groupby("xid")["actor"].nunique()
    named["dup"] = named["xid"].map(xa).fillna(0) >= 2
    a = named.groupby("actor").agg(
        n_events=("event_id", "size"),
        coord_frac=("coord", "mean"),
        max_cluster=("cluster_actors", "max"),
        dup_frac=("dup", "mean"),
        label_rate=("label", "mean"),
    )
    a["score"] = a["coord_frac"] * np.log1p(a["max_cluster"].where(a["max_cluster"] >= p.min_actors, 0))
    return a.sort_values("score", ascending=False).reset_index()


def event_scores(ann: pd.DataFrame, p: CoordParams | None = None) -> pd.DataFrame:
    """Per-event scores for labelled backtests: ours vs exact-dup vs author-volume baselines."""
    p = p or CoordParams()
    named = ann[ann["actor"].notna()]
    ta = named[named["tid"].notna()].groupby("tid")["actor"].nunique()
    xa = named[named["xid"].notna()].groupby("xid")["actor"].nunique()
    vol = named.groupby("actor").size()
    out = pd.DataFrame(index=ann.index)
    out["ours"] = np.log1p(ann["tid"].map(ta).fillna(0))
    out["exact_dup"] = np.log1p(ann["xid"].map(xa).fillna(0))
    out["author_volume"] = np.log1p(ann["actor"].map(vol).fillna(0))
    out["label"] = ann["label"]
    return out
