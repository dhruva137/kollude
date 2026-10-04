"""Failure attribution for multi-agent trajectories (who failed, at which step) — no LLM.

Per-step evidence features (each in [0, 1]):

* ``err``     error / failure markers in the step, or in the tool output that answers it
* ``assume``  unverified-assumption markers ("let's assume", "hypothetical", "placeholder", …)
* ``origin``  step first introduces a token of the (wrong) final answer — TRACE patient-zero
* ``early``   positional prior; decisive errors cluster early in failed runs
* ``plan``    planner/orchestrator step that dispatches work (plans propagate errors)

``score = w · features``; the argmax step gives (agent, step). Weights are fit on one split and
evaluated on the other (no test-set tuning).
"""

from __future__ import annotations

import itertools
import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

import numpy as np

_ERR = re.compile(
    r"\b(error|exception|traceback|failed|failure|unable to|cannot|can't|could not|couldn't|not found|"
    r"no results|403|404|timed? ?out|denied|blocked|captcha|unfortunately|apolog|sorry)\b",
    re.IGNORECASE,
)
_ASSUME = re.compile(
    r"\b(assum\w*|hypothetical\w*|placeholder|for demonstration|example data|mock|simulat\w*|"
    r"approximately|estimated?|let'?s say|without access|i will proceed|based on (?:general|typical)|"
    r"typically|likely|probably|seems)\b",
    re.IGNORECASE,
)
_PLAN = re.compile(r"\b(plan|ledger|next speaker|instruction|please (?:search|find|open|navigate))\b", re.IGNORECASE)
_NUM = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?(?![\w])")
_TOOL_AGENTS = {"computer_terminal", "human", "user", "system"}

FEATURES = ("err", "assume", "origin", "early", "plan", "role")


def agent_of(msg: dict[str, Any]) -> str:
    raw = str(msg.get("name") or msg.get("role") or "unknown")
    raw = re.sub(r"\s*\(.*?\)\s*", "", raw).strip()
    return raw or "unknown"


def norm_agent(a: str) -> str:
    return re.sub(r"[^a-z0-9]", "", a.lower())


def role_prior(rows: list[dict[str, Any]], alpha: float = 1.0) -> dict[str, float]:
    """P(agent is culprit | agent appears in the run), Laplace-smoothed, from training rows only."""
    seen: Counter[str] = Counter()
    blamed: Counter[str] = Counter()
    for r in rows:
        for a in {norm_agent(agent_of(m)) for m in r["history"]}:
            seen[a] += 1
        blamed[norm_agent(r["agent"])] += 1
    return {a: (blamed[a] + alpha) / (seen[a] + 2 * alpha) for a in seen}


def step_features(history: list[dict[str, Any]], question: str = "", prior: dict[str, float] | None = None) -> tuple[list[str], np.ndarray]:
    agents = [agent_of(m) for m in history]
    texts = [str(m.get("content") or "") for m in history]
    n = len(history)
    X = np.zeros((n, len(FEATURES)), dtype=float)
    q_nums = set(_NUM.findall(question or ""))
    tail = " ".join(texts[-3:]) if texts else ""
    final_nums = [x for x in _NUM.findall(tail) if x not in q_nums]
    origin_step: int | None = None
    if final_nums:
        targets = set(final_nums[-3:])
        for i, t in enumerate(texts):
            if norm_agent(agents[i]) in _TOOL_AGENTS:
                continue
            if targets & set(_NUM.findall(t)):
                origin_step = i
                break
    for i, t in enumerate(texts):
        a = norm_agent(agents[i])
        head = t[:4000]
        err = 1.0 if _ERR.search(head) else 0.0
        # Tool output error is the producer's fault: credit the previous non-tool step.
        if i + 1 < n and norm_agent(agents[i + 1]) in _TOOL_AGENTS and _ERR.search(texts[i + 1][:4000]):
            err = max(err, 1.0)
        X[i, 0] = err
        X[i, 1] = min(1.0, len(_ASSUME.findall(head)) / 3.0)
        X[i, 2] = 1.0 if origin_step == i else 0.0
        X[i, 3] = 1.0 / (1.0 + i / 4.0)
        X[i, 4] = 1.0 if _PLAN.search(head[:600]) else 0.0
        X[i, 5] = (prior or {}).get(a, 0.5)
        if a in _TOOL_AGENTS:
            X[i, :] = -1e3  # tools and the human are never the responsible agent
    return agents, X


@dataclass
class Prediction:
    agent: str
    step: int
    scores: list[float]


def predict(history: list[dict[str, Any]], weights: np.ndarray, question: str = "") -> Prediction:
    agents, X = step_features(history, question)
    if len(agents) == 0:
        return Prediction("unknown", 0, [])
    s = X @ weights
    i = int(np.argmax(s))
    return Prediction(agents[i], i, s.tolist())


def _rows(df) -> list[dict[str, Any]]:
    out = []
    for r in df.to_dict(orient="records"):
        hist = [dict(m) for m in r["history"]]
        try:
            step = int(r["mistake_step"])
        except (TypeError, ValueError):
            step = -1
        out.append({"history": hist, "question": r.get("question") or "", "agent": str(r["mistake_agent"]), "step": step})
    return out


def featurize(rows: list[dict[str, Any]], prior: dict[str, float] | None = None) -> list[tuple[list[str], np.ndarray, str, int]]:
    out = []
    for r in rows:
        agents, X = step_features(r["history"], r["question"], prior)
        out.append((agents, X, norm_agent(r["agent"]), r["step"]))
    return out


def evaluate(rows: list[dict[str, Any]], w: np.ndarray, feats=None) -> dict[str, Any]:
    feats = feats or featurize(rows)
    a_hits = s_hits = 0
    for agents, X, gold_a, gold_s in feats:
        if not agents:
            continue
        i = int(np.argmax(X @ w))
        a_hits += norm_agent(agents[i]) == gold_a
        s_hits += i == gold_s
    n = max(len(feats), 1)
    return {"agent_acc": a_hits / n, "step_acc": s_hits / n, "n": len(feats), "agent_hits": a_hits, "step_hits": s_hits}


def fit(rows: list[dict[str, Any]], prior: dict[str, float] | None = None) -> tuple[np.ndarray, dict[str, Any]]:
    """Grid search on the training split only; objective = agent acc + 0.5 · step acc."""
    feats = featurize(rows, prior)
    grid = [0.0, 0.5, 1.0, 2.0]
    best_w, best = np.array(DEFAULT_WEIGHTS), {"agent_acc": -1.0, "step_acc": -1.0}
    best_obj = -1.0
    for combo in itertools.product(grid, repeat=len(FEATURES)):
        if not any(combo):
            continue
        w = np.array(combo, dtype=float)
        m = evaluate(rows, w, feats)
        obj = m["agent_acc"] + 0.5 * m["step_acc"]
        if obj > best_obj:
            best_obj, best_w, best = obj, w, m
    return best_w, best


def cross_validate(rows: list[dict[str, Any]], k: int = 5, seed: int = 0) -> dict[str, Any]:
    """k-fold CV: role prior + weights fit on the training folds only, scored on the held-out fold."""
    idx = np.random.default_rng(seed).permutation(len(rows))
    folds = np.array_split(idx, k)
    a_hits = s_hits = n = 0
    base_hits: Counter[str] = Counter()
    for f in folds:
        held = set(f.tolist())
        test = [rows[i] for i in f]
        train = [rows[i] for i in idx if i not in held]
        prior = role_prior(train)
        w, _ = fit(train, prior)
        m = evaluate(test, w, featurize(test, prior))
        a_hits += m["agent_hits"]
        s_hits += m["step_hits"]
        n += m["n"]
        for name, b in baselines(test, train).items():
            base_hits[name] += b["agent_acc"] * b["n"]
    return {
        "k": k,
        "n": n,
        "agent_acc": a_hits / max(n, 1),
        "agent_ci": wilson(a_hits, n),
        "step_acc": s_hits / max(n, 1),
        "step_ci": wilson(s_hits, n),
        "baselines_agent_acc": {name: v / max(n, 1) for name, v in base_hits.items()},
    }


def baselines(rows: list[dict[str, Any]], train_rows: list[dict[str, Any]] | None = None, seed: int = 0) -> dict[str, dict[str, float]]:
    rng = np.random.default_rng(seed)
    prior = Counter(norm_agent(r["agent"]) for r in (train_rows or []))
    out: dict[str, list[tuple[bool, bool]]] = {k: [] for k in ("random", "most_messages", "first_agent", "last_agent", "train_prior")}
    for r in rows:
        agents = [agent_of(m) for m in r["history"]]
        cand = [(i, a) for i, a in enumerate(agents) if norm_agent(a) not in _TOOL_AGENTS]
        if not cand:
            cand = list(enumerate(agents))
        gold_a, gold_s = norm_agent(r["agent"]), r["step"]
        uniq = sorted({norm_agent(a) for _, a in cand})
        # Expected accuracy of uniform random choice (exact, not a sampled draw).
        out["random"].append((gold_a in uniq and 1.0 / len(uniq), 1.0 / max(len(r["history"]), 1)))  # type: ignore[arg-type]
        cnt = Counter(norm_agent(a) for _, a in cand)
        top = cnt.most_common(1)[0][0]
        out["most_messages"].append((top == gold_a, next(i for i, a in cand if norm_agent(a) == top) == gold_s))
        out["first_agent"].append((norm_agent(cand[0][1]) == gold_a, cand[0][0] == gold_s))
        out["last_agent"].append((norm_agent(cand[-1][1]) == gold_a, cand[-1][0] == gold_s))
        if prior:
            pick = max(uniq, key=lambda a: (prior.get(a, 0), -uniq.index(a)))
            first_i = next(i for i, a in cand if norm_agent(a) == pick)
            out["train_prior"].append((pick == gold_a, first_i == gold_s))
        else:
            out["train_prior"].append((False, False))
    _ = rng
    res = {}
    for k, v in out.items():
        n = max(len(v), 1)
        res[k] = {"agent_acc": float(sum(float(a) for a, _ in v) / n), "step_acc": float(sum(float(s) for _, s in v) / n), "n": len(v)}
    return res


def wilson(k: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (float(max(0.0, c - h)), float(min(1.0, c + h)))


def attribute(trajectory: list[dict[str, Any]], question: str = "", weights: list[float] | None = None) -> dict[str, Any]:
    """Public API: rank steps of one trajectory by failure responsibility."""
    w = np.array(weights or DEFAULT_WEIGHTS, dtype=float)
    agents, X = step_features(trajectory, question)
    if not agents:
        return {"agent": None, "step": None, "ranking": []}
    s = X @ w
    order = np.argsort(-s)[:10]
    ranking = [
        {
            "step": int(i),
            "agent": agents[i],
            "score": float(s[i]),
            "features": {f: float(X[i, j]) for j, f in enumerate(FEATURES)},
        }
        for i in order
        if s[i] > -100
    ]
    agent_tot: Counter[str] = Counter()
    for r in ranking:
        agent_tot[r["agent"]] += max(r["score"], 0.0)
    return {
        "agent": ranking[0]["agent"] if ranking else None,
        "step": ranking[0]["step"] if ranking else None,
        "ranking": ranking,
        "agent_totals": dict(agent_tot.most_common()),
    }


# Fit on Algorithm-Generated by ``kollude.backtest.whowhen`` and frozen here.
DEFAULT_WEIGHTS = [1.0, 1.0, 1.0, 1.0, 0.5, 0.0]
