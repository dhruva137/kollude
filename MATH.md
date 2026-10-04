# Math

Formulas and definitions as implemented in this repository. Symbols match `kollude/coord.py`, `kollude/stream.py`, `kollude/spread.py`, `kollude/engine.py`, and `kollude/attribution.py`. Defaults below are those of `ScanParams` unless noted.

---

## 1. Event frame

Each row is an event with actor $a$, timestamp $t$, and text $x$. Time is floored into bins of width `freq` (default $1\mathrm{h}$):

$$
b(t) = \lfloor t \rfloor_{\mathrm{freq}}.
$$

Optional labels $y \in \{0,1\}$ are used only in offline scoring; they never enter the streaming alarm.

---

## 2. Templates

### 2.1 Folding

A message is truncated to the first `max_chars` characters (default $400$), then folded with vectorized RE2 replacements (`coord._fold`):

| Step | Rule |
|---|---|
| Case | lowercase |
| URLs | `https?://…` and `[url]` → token `u` |
| Digits | runs of Unicode numbers → `0` |
| Other | non letter/digit runs → a single space |

Short or empty folds are discarded (`min_tokens`, default $4$).

### 2.2 Prefix and suffix keys

From the folded string, take the first `n_tokens` tokens (default $12$) as the **prefix** template $\tau^{\mathrm{pre}}$. Optionally take the last `n_tokens` as the **suffix** template $\tau^{\mathrm{suf}}$ (`suffix=True` by default), kept only when it differs from the prefix.

Stable 64-bit ids (`ptid`, `stid`) hash the template strings. An **exact-text** id `xid` hashes trimmed lowercase text without folding — used only as a baseline, not for $C$/$M$.

### 2.3 Cluster key per event

Across the whole run, each event’s working key `tid` is the prefix or suffix id with more distinct actors (prefix on ties). That key defines clusters for dossiers and actor scores.

For **windowed** coordination (the $C$/$M$ timeline), each event independently takes the better of prefix vs suffix by windowed actor count (see §3).

---

## 3. Coordination signals $C$ and $M$

Two axes are computed per bin. They are **never summed**.

### 3.1 Windowed actor count

For signature key $k$ (prefix or suffix id) and bin $b$, let $W = \texttt{window}$ (default $6$ in `ScanParams`; $1$ in bare `CoordParams`). Count distinct actors using $k$ in the causal window of bins $(b - (W-1)\Delta,\, b]$, where $\Delta$ is the bin width, after discarding keys with fewer than $m_0 = \texttt{min\_actors}$ (default $5$) distinct actors in that window.

Write $t_a(e)$ for the best such count on event $e$ (max of prefix and suffix). Mark the event **coordinated** if

$$
\mathrm{coord}(e) \iff t_a(e) \ge m_0.
$$

### 3.2 Per-bin definitions

For bin $b$ with $N_b$ events:

$$
C_b = \frac{\#\{\,e : b(e)=b,\ \mathrm{coord}(e)\,\}}{N_b},
\qquad
M_b = \mathrm{mean}\{\,t_a : \text{coordinated templates in } b\,\}
$$

with $C_b = M_b = 0$ when there are no coordinated events. Empty bins in a continuous span are filled with zeros so the detector sees quiet hours.

**Interpretation.** High $C$ with $M \approx 1$ is one prolific repeater. High $C$ and high $M$ is many distinct actors on shared templates.

---

## 4. Streaming alarm (e-CUSUM)

Implemented in `stream.EDetector`. Reference for the e-detector / ARL framing: **Shin, Ramdas & Rinaldo (2022), “E-detectors”**.

### 4.1 Conformal $p$-value

Score each closed bin by $z_b = C_b$. Maintain the multiset of past scores $\mathcal{Z}_{b-1}$ (including warmup bins). During warmup ($|\mathcal{Z}| < w$, default $w=24$):

$$
p_b = 1,\qquad e_b = 1.
$$

Afterwards, with $n = |\mathcal{Z}_{b-1}|$, let $G$ be the number of past scores strictly greater than $z_b$, $T$ the number of ties, and $U \sim \mathrm{Unif}(0,1)$:

$$
p_b = \frac{G + U\,(T + 1)}{n + 1}.
$$

Under exchangeability of scores this is a valid (randomized) $p$-value. The current bin is then inserted into $\mathcal{Z}$.

### 4.2 Mixture e-value

With fixed grid $\varepsilon \in \{0.05, 0.1, 0.2, 0.35, 0.5\}$:

$$
e(p) = \frac{1}{|\mathcal{E}|}\sum_{\varepsilon \in \mathcal{E}} \varepsilon\, p^{\varepsilon - 1},
\qquad p \in [10^{-12}, 1].
$$

Under the null, $\mathbb{E}[e(p)] \le 1$.

### 4.3 e-CUSUM and gate

$$
S_b = e_b \cdot \max(S_{b-1},\, 1),
\qquad S_0 = 1.
$$

Threshold $\alpha^{-1}$ (default $\alpha = 0.01$ ⇒ threshold $100$). Alarm only with the **M gate**:

$$
\mathrm{alarm}_b \iff \bigl(S_b \ge \tfrac{1}{\alpha}\bigr) \;\wedge\; \bigl(M_b \ge m_{\min}\bigr),
$$

default $m_{\min} = 3$. After an alarm, $S$ restarts at $1$ (change-point semantics).

Under a no-change null, the construction targets average run length $\mathrm{ARL} \ge 1/\alpha$ bins to a false alarm (before the empirical M-gate, which can only reduce alarms). `permutation_arl` estimates false-alarm rate on time-shuffled bins.

---

## 5. Offline scores (labelled ranking)

Used for AUROC-style backtests (`coord.event_scores`, `coord.actor_scores`).

**Per event** (whole-run template sharing; not causal):

$$
s_{\mathrm{ours}}(e) = \log\bigl(1 + \#\{\text{actors sharing }\mathrm{tid}(e)\}\bigr),
$$

$$
s_{\mathrm{dup}}(e) = \log\bigl(1 + \#\{\text{actors sharing }\mathrm{xid}(e)\}\bigr),
$$

$$
s_{\mathrm{vol}}(e) = \log\bigl(1 + \#\{\text{events by actor }a(e)\}\bigr).
$$

**Per actor:**

$$
\mathrm{score}(a) = f_a \cdot \log\bigl(1 + K_a\bigr),
$$

where $f_a$ is the fraction of $a$’s events whose template has $\ge m_0$ distinct actors, and $K_a$ is the largest such cluster size (else $0$). Baselines kept alongside: event volume and exact-duplicate fraction.

---

## 6. Spread

For each template id with at least $m_0$ distinct actors (`spread.trace_spread`):

| Quantity | Definition |
|---|---|
| Seeder | Actor with the earliest first-use time of the template |
| Hours to $m_0$ | Time from seeder’s first post until the $m_0$-th distinct actor first uses it |
| Carriers | Actors ordered by first-use time |

This measures spread of a **shared folded line**, not a hidden channel.

---

## 7. Failure attribution (Who&When-style)

`attribution.py` — no LLM. Per step $i$ of a trajectory, features in $[0,1]$ (tools/human masked to a large negative so they cannot win):

| Feature | Meaning |
|---|---|
| `err` | Error/failure markers in the step, or in the following tool output |
| `assume` | Unverified-assumption markers (capped count / 3) |
| `origin` | First non-tool step that introduces a numeric token of the (wrong) final answer |
| `early` | $1 / (1 + i/4)$ positional prior |
| `plan` | Planner/orchestrator lexical markers |
| `role` | Laplace-smoothed $P(\text{culprit}\mid\text{agent})$ from the **training** split only |

Score $\mathbf{w}^\top \mathbf{x}_i$; predict $\arg\max_i$. Default frozen weights (fit on Algorithm-Generated Who&When, then frozen):

$$
\mathbf{w} = (1,\,1,\,1,\,1,\,0.5,\,0).
$$

Fit objective on a train split: agent accuracy $+\,0.5\cdot$ step accuracy over a small grid. Intervals for accuracy use a Wilson score interval.

---

## 8. Default scan parameters

| Parameter | Default (`ScanParams`) | Role |
|---|---|---|
| `freq` | `1h` | Bin width |
| `min_actors` | $5$ | $m_0$ for coordination / spread |
| `window` | $6$ | Causal bins for $t_a$ |
| `n_tokens` / `min_tokens` | $12$ / $4$ | Template length |
| `suffix` | `True` | Prefix + suffix collision |
| `alpha` | $0.01$ | e-CUSUM level |
| `warmup` | $24$ | Bins before conformal $p$ |
| `m_min` | $3.0$ | Alarm gate on $M$ |

Alarm rule in one line: **$S \ge 1/\alpha$ and $M \ge m_{\min}$** — never $C$ alone, never $M$ alone.
