export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'other'
export type EvidenceTier = 'explicit' | 'strong' | 'weak' | 'unresolved'
export type Verdict =
  | 'verified'
  | 'partially_verified'
  | 'contradicted'
  | 'no_evidence_found'
  | 'unverifiable_in_logs'

/** Where a number came from. Shown on every panel. */
export type Provenance = 'measured' | 'synthetic' | 'mock' | 'pending'

export interface WingKpi {
  id: string
  label: string
  metric: string
  value: number
  unit: string
  ci_low: number | null
  ci_high: number | null
  baseline_name: string | null
  baseline_value: number | null
}

export interface LoopKpis {
  updated_at: string
  episode_id?: string
  provenance?: Provenance
  global: {
    events: number
    agents: number
    claims: number
    strains: number
    self_report_verified_pct: number
    false_belief_in_memory: number
  }
  wings: WingKpi[]
}

export interface SwarmNode {
  id: string
  label: string
  model_family: ModelFamily
  activity: number
  role: string
  t_first: string
}

export interface SwarmEdge {
  src: string
  dst: string
  p_transmission: number
  tier: EvidenceTier
  t: string
  claim_id: string
}

export interface SwarmMap {
  episode_id: string
  t_min: string
  t_max: string
  nodes: SwarmNode[]
  edges: SwarmEdge[]
}

export interface StrainMember {
  claim_id: string
  agent_id: string
  t: string
  text: string
  memory: boolean
  correction: boolean
  verdict: Verdict
  parent_claim_id?: string
  tier?: EvidenceTier
  p_transmission?: number
}

export interface StrainData {
  strain_id: string
  label: string
  first_t: string
  origin: {
    agent_id: string
    claim_id: string
    verdict: Verdict
    text: string
  }
  members: StrainMember[]
  mutations: Array<{ from: string; to: string; diff: string }>
  alternatives: Array<{ for_edge: string; hypothesis: string; detail: string }>
}

export interface StrainIndex {
  strains: Array<{
    strain_id: string
    label: string
    file: string
    n_members: number
    n_agents: number
    first_t: string
  }>
}

export interface AgentClaim {
  claim_id: string
  t: string
  text: string
  verdict: Verdict
  conformal_set: Verdict[]
  evidence_event_ids: string[]
  cited_action_ids: string[]
}

export interface AgentAction {
  action_id: string
  t: string
  type: string
  detail: string
}

export interface AgentData {
  agent_id: string
  label: string
  model_family: ModelFamily
  role: string
  says: AgentClaim[]
  does: AgentAction[]
  memory_diff: { before: string; after: string }
}

export interface OrgChart {
  episode_id: string
  true_orchestrator: string
  recovered_orchestrator: string
  orchestrator_rank?: number
  workstream_nmi?: number
  gini: number
  gini_ci_low: number
  gini_ci_high: number
  workstreams: Array<{ id: string; name: string; color: string; actors: string[] }>
  nodes: Array<{ id: string; label: string; role: string; model_family: ModelFamily; load: number }>
  edges: Array<{ src: string; dst: string; kind: string }>
}

export interface BenchResult {
  component: string
  dataset: string
  metric: string
  value: number
  ci_low: number
  ci_high: number
  baseline_name: string
  baseline_value: number
  n_runs: number
  seed: number
  commit: string
}

export interface Benchmarks {
  results: BenchResult[]
  could_have_warned: Array<{ date: string; label: string; kind: string }>
  scout_status?: 'measured' | 'pending_real_replay'
}

export interface WhiteboxData {
  episode_id: string
  agent_id: string
  probe: string
  layers: number
  tokens: string[]
  token_text: string[]
  scores: number[][]
  thresholds?: { red: number; amber: number }
  highlight_token_range: [number, number]
  note: string
}

export interface ScoutAlert {
  alert_id: string
  t: string
  e_value: number
  m_score: number
  c_score: number
  gate: string
  strain_id: string
  actors: string[]
  summary: string
}

export interface ScoutAlerts {
  alerts: ScoutAlert[]
  could_have_warned: Array<{ date: string; label: string; kind: string; t?: string }>
  provenance?: Provenance
  note?: string
  metrics?: Record<string, number | boolean | string>
}

export interface WardDisruption {
  episode_id: string
  interventions: Array<{
    id: string
    t: string
    action: string
    targets: string[]
    R_before: number
    R_after: number
    delta: number
  }>
  summary: {
    total_delta_R: number
    ci_low: number
    ci_high: number
    baseline_name: string
    baseline_value: number
  }
  board_storage?: {
    whole_page_wrong_rate: number
    append_only_wrong_rate: number
    delta: number
    whole_page_ci: [number, number, number]
    append_only_ci: [number, number, number]
    delta_ci: [number, number, number]
    n_trials: number
    n_agents: number
    seed: number
    archive_target: { whole_page: number; append_only: number }
  }
  monitor?: {
    recall: number
    fpr: number
    threshold: number
    n_malicious: number
    n_benign: number
    baseline_name: string
    baseline_recall: number
  }
}
