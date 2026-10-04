# Research

What this repository measured, against which baselines, where it misses, and what it does **not** claim. Numbers below are those already reported in [README.md](README.md). Formulas live in [MATH.md](MATH.md).

---

## 1. Question under test

Given multi-agent speech logs (posts, edits, or tool trajectories), can a **transparent** detector:

1. Rank coordinated events / actors above named baselines (template cluster vs exact duplicate vs volume)?
2. Raise an **anytime-valid** alarm only when content-sharing ($C$) and identity multiplicity ($M$) both support a swarm, with a stated false-alarm framing?
3. Name a **seeder** and hours-to-spread for a shared folded line?
4. On Who&When-style failure logs, attribute which agent / step failed better than simple heuristics?

The detector is lexical and statistical: folded near-duplicate templates, conformal $p$-values, mixture e-values, e-CUSUM (Shin, Ramdas & Rinaldo, 2022). It is not a learned embedding model and not a mechanistic-interpretability probe.

---

## 2. What was measured

Every headline has a **named baseline** and an **interval**. Alerts require **$M \wedge C$** (e-CUSUM on $C$, gate on $M$).

| Corpus | Result | Baselines / notes |
|---|---|---|
| **Moltbook** campaign (1,678,764 posts); campaign marker unseen by the detector | Post AUROC **0.799** [0.798, 0.801]; agent AUROC **0.913** [0.912, 0.915]; first alarm **2026-02-05 12:00**, **12h** before wave share crossed 20% | Post: exact-dup **0.593**, volume **0.420**. Agent: dup-frac **0.737**, volume **0.595** |
| **collusion.wiki** (German board revisions) | First alarm **2026-06-16 13:00**, **107h** before the 21 June IP landmark | Lead time vs a fixed public landmark, not AUROC on hidden labels |
| **Who&When** hand-crafted | Agent accuracy **0.569** [0.441, 0.688] | Loses to **last-agent 0.603** — reported miss |
| **Synthetic** (known onset) | Caught **2 bins** after onset; post AUROC **1.000** vs volume **0.064** | One organic catchphrase can alarm **before** injected onset |

Intervals for AUROC are bootstrap percentiles as implemented in `kollude/backtest.py`. Who&When intervals are Wilson score intervals on accuracy.

Online alarm baselines in the backtest harness (volume $z$-score, exact-dup-share $z$-score) are used for comparison in generated reports; the README table highlights the ranking and lead-time results above.

---

## 3. Baselines (named)

| Task | Ours | Baselines |
|---|---|---|
| Post ranking | $\log(1 + \#\{\text{actors on template}\})$ | Exact-duplicate actor count; author volume; random score |
| Agent ranking | Coordination score (§5 of MATH.md) | Exact-dup fraction; number of posts |
| Streaming alarm | e-CUSUM on $C$ with $M \ge m_{\min}$ | Rolling $z$-score of event volume; rolling $z$-score of exact-dup share |
| Attribution | Weighted lexical / positional features | Random agent; most-messages; first agent; last agent; train-set role prior |

Non-promotion rule: never fuse automation + coordination + impact into one scalar “threat score.”

---

## 4. Honest misses and limitations

- **Who&When hand-crafted:** agent accuracy **0.569** loses to the **last-agent** baseline (**0.603**). The feature stack is a useful dossier tool; it is not a win on that split. Report the miss; do not bury it.
- **Synthetic early alarm:** an organic catchphrase shared by enough actors can trip the detector **before** the labelled injection onset. Ground truth for “campaign start” and “first coordinated reuse” are not always the same.
- **Template blindness:** folding catches near-duplicates of surface form. Paraphrase swarms, translation pivots, and intentionally diversified wording are outside the collision model.
- **Identity assumption:** $M$ needs distinct actor fields. Anonymous or heavily reused handles weaken the multiplicity axis.
- **Exchangeability:** conformal $p$-values assume exchangeable bin scores under the null. Strong diurnal seasonality or platform shocks can inflate $C$ without a “swarm” in the social sense; the $M$ gate is a partial guard, not a full causal model.
- **Lead time ≠ proof of collusion:** wiki lead time is relative to a public IP landmark; it does not by itself establish intent or offline conspiracy.

---

## 5. What we do **not** claim

- **No Transluce / SwarmTraces scoring.** Those corpora are not part of the measured table in this README.
- **No steganography, hidden channels, or covert-channel detection.** Spread traces a shared folded line in the clear.
- **No mechanistic interpretability** of model internals; no activation probes; no white-box neuron claims in this public package’s measured results.
- **No Sentence-BERT / embedding similarity** as the coordination engine. Templates are folded token strings, not cosine neighbors in embedding space.
- **No claim that AUROC on one campaign generalizes** to all agent social networks or all languages without re-measurement.
- **No claim that beating volume/exact-dup baselines implies legal or policy guilt.** Outputs are forensic leads with methods and baselines attached.

---

## 6. Safety and evaluation hygiene

- Dataset text is **untrusted**: not executed, not rendered as HTML, not followed as a URL.
- Measured numbers always ship with a baseline and an interval (or an explicit miss).
- FORGE / synthetic labelled episodes are for wind-tunnel checks with known onset; they are not a substitute for the Moltbook / wiki / Who&When rows above.
- Public-feed watching parses JSON as data only (size-capped, no follow, no render).

---

## 7. Pointers

| Doc / code | Role |
|---|---|
| [MATH.md](MATH.md) | Definitions and formulas |
| [README.md](README.md) § What was measured | Headline table |
| `kollude/coord.py` | Templates, $C$, $M$, offline scores |
| `kollude/stream.py` | Mixture $e$, e-CUSUM, gate |
| `kollude/spread.py` | Seeder · hours · carriers |
| `kollude/attribution.py` | Who&When-style step scores |
| `kollude/backtest.py` | Bootstrap AUROC, lead time, CV |
