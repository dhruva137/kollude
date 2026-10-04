import type { EvidenceTier, ModelFamily, Verdict } from '../types'

/*
 * Data colors. Validated with the dataviz palette validator against the panel
 * surface #11161f (dark mode):
 *  - Model families (graph nodes, all-pairs): blue / orange / aqua pass every gate
 *    all-pairs (worst CVD ΔE 9.4, normal ΔE 20.9). "other" folds to neutral gray.
 *  - Workstreams (adjacent use, always direct-labeled): 6 slots pass adjacent
 *    (worst CVD ΔE 8.4).
 * Verdicts use the reserved status palette and always ship with an icon + label.
 */

export const FAMILY_COLOR: Record<ModelFamily, string> = {
  gpt: '#3987e5',
  claude: '#d95926',
  gemini: '#199e70',
  other: '#8b95a5',
}

export const FAMILY_LABEL: Record<ModelFamily, string> = {
  gpt: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
  other: 'Other',
}

export const WORKSTREAM_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9']

export const VERDICT_COLOR: Record<Verdict, string> = {
  verified: '#0ca30c',
  partially_verified: '#fab219',
  contradicted: '#d03b3b',
  no_evidence_found: '#7d8899',
  unverifiable_in_logs: '#4c5666',
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: 'Verified',
  partially_verified: 'Partial',
  contradicted: 'Contradicted',
  no_evidence_found: 'No evidence',
  unverifiable_in_logs: 'Unverifiable',
}

export const VERDICT_ORDER: Verdict[] = [
  'verified',
  'partially_verified',
  'contradicted',
  'no_evidence_found',
  'unverifiable_in_logs',
]

/** Evidence tier → stroke. Neutral ink; certainty is carried by weight + dash, not hue. */
export function tierStroke(tier: EvidenceTier): {
  dash: string
  dasharray: string
  width: number
  opacity: number
  color: string
} {
  const base = tierBase(tier)
  return { ...base, dasharray: base.dash, color: '#C9D1D9' }
}

function tierBase(tier: EvidenceTier): { dash: string; width: number; opacity: number } {
  switch (tier) {
    case 'explicit':
      return { dash: '', width: 2.4, opacity: 0.95 }
    case 'strong':
      return { dash: '', width: 1.6, opacity: 0.75 }
    case 'weak':
      return { dash: '5 4', width: 1.2, opacity: 0.55 }
    case 'unresolved':
      return { dash: '1.5 3.5', width: 1, opacity: 0.4 }
  }
}

export const TIER_LABEL: Record<EvidenceTier, string> = {
  explicit: 'Explicit',
  strong: 'Strong',
  weak: 'Weak',
  unresolved: 'Unresolved',
}

export function isWeakTier(tier: EvidenceTier): boolean {
  return tier === 'weak' || tier === 'unresolved'
}

/**
 * Single-hue sequential red ramp for misguidance scores (0 → surface, 1 → hot red).
 * Monotone in lightness so magnitude reads without hue changes.
 */
export function misguidanceColor(score: number): string {
  const s = Math.max(0, Math.min(1, score))
  const t = Math.pow(s, 1.35)
  // interpolate in RGB between near-surface and glow red
  const a = [24, 30, 40]
  const b = [255, 90, 90]
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

export const INK = {
  fg: '#e8edf4',
  fg2: '#b4bfcd',
  muted: '#7d8899',
  faint: '#4c5666',
  line: '#232b38',
  line2: '#2f3a4a',
  panel: '#11161f',
  accent: '#6aa8ff',
}
