export function fmtPct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  if (Number.isInteger(n) && Math.abs(n) >= 10) return n.toLocaleString()
  return n.toFixed(digits)
}

export function fmtCi(value: number, lo: number | null, hi: number | null, digits = 2): string {
  if (lo == null || hi == null) return fmtNum(value, digits)
  return `${fmtNum(value, digits)} [${fmtNum(lo, digits)}, ${fmtNum(hi, digits)}]`
}

export function shortTime(iso: string): string {
  return iso.slice(11, 19)
}

export function shortDate(iso: string): string {
  return iso.slice(0, 10)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "16 Jun" */
export function dayMonth(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** Seconds since t0, formatted for a short episode: "+12.4s", "+1m 05s". */
export function relSeconds(iso: string, t0Ms: number): string {
  const s = (Date.parse(iso) - t0Ms) / 1000
  if (s < 60) return `+${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return `+${m}m ${String(r).padStart(2, '0')}s`
}

/** HH:MM:SS UTC — second resolution (FORGE episodes span ~80 s). */
export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19)
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function humanMetric(metric: string): string {
  const map: Record<string, string> = {
    edge_auprc: 'Edge AUPRC',
    edge_auroc: 'Edge AUROC',
    roc_auc: 'ROC-AUC',
    anytime_valid_alpha: 'Anytime-valid α',
    monitor_recall: 'Monitor recall',
    monitor_fpr: 'Monitor FPR',
    disruption_delta: 'Wrong-answer Δ',
    wrong_answer_rate_whole_page: 'Wrong-answer rate · whole-page',
    wrong_answer_rate_append_only: 'Wrong-answer rate · append-only',
    probe_auc_peer_adoption: 'Probe AUC · peer_adoption',
    steering_cheating_delta: 'Steering Δ cheating',
    orchestrator_rank: 'Orchestrator rank',
    workstream_nmi: 'Workstream NMI',
    load_gini: 'Load Gini',
    stress_pass_rate: 'Stress pass rate',
    sef_fixture_ok: 'SEF fixtures valid',
    bundle_load_ok: 'FORGE bundle loads',
    hf_token_present: 'HF token present',
  }
  return map[metric] ?? titleCase(metric)
}
