import { CheckCircle2, CircleX, ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  CompareBar,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  cx,
} from '../components/ui'
import { INK } from '../lib/colors'
import { dayMonth, fmtNum, humanMetric } from '../lib/format'
import { useJson } from '../lib/loadData'
import type { BenchResult, Benchmarks, ScoutAlerts, WardDisruption } from '../types'

const HEALTH_METRICS = new Set(['sef_fixture_ok', 'bundle_load_ok', 'hf_token_present', 'stress_pass_rate'])

type SortKey = 'component' | 'metric' | 'value' | 'delta' | 'dataset'

function wingOf(component: string): string {
  const c = component.toLowerCase()
  if (c.includes('trace')) return 'TRACE'
  if (c.includes('scout')) return 'SCOUT'
  if (c.includes('ward')) return 'WARD'
  if (c.includes('whitebox')) return 'WHITEBOX'
  if (c.includes('multiagent')) return 'MULTIAGENT'
  if (c.includes('validator')) return 'VALIDATOR'
  if (c.includes('forge')) return 'FORGE'
  if (c.includes('spine')) return 'SPINE'
  return component.toUpperCase()
}

export function BenchmarksView() {
  const bench = useJson<Benchmarks>('benchmarks.json')
  const scout = useJson<ScoutAlerts>('scout_alerts.json')
  const ward = useJson<WardDisruption>('ward_disruption.json')

  if (bench.status === 'error') return <ErrorBlock error={bench.error} />
  if (scout.status === 'error') return <ErrorBlock error={scout.error} />
  if (ward.status === 'error') return <ErrorBlock error={ward.error} />
  if (bench.status === 'loading' || scout.status === 'loading' || ward.status === 'loading')
    return <LoadingBlock label="Loading evidence" />

  return <EvidenceInner bench={bench.data} scout={scout.data} ward={ward.data} />
}

function EvidenceInner({
  bench,
  scout,
  ward,
}: {
  bench: Benchmarks
  scout: ScoutAlerts
  ward: WardDisruption
}) {
  const [sortKey, setSortKey] = useState<SortKey>('component')
  const [sortAsc, setSortAsc] = useState(true)

  const health = useMemo(
    () => bench.results.filter((r) => HEALTH_METRICS.has(r.metric)),
    [bench.results],
  )
  const scored = useMemo(
    () => bench.results.filter((r) => !HEALTH_METRICS.has(r.metric)),
    [bench.results],
  )

  const byWing = useMemo(() => {
    const m = new Map<string, BenchResult[]>()
    for (const r of scored) {
      const w = wingOf(r.component)
      const list = m.get(w) ?? []
      list.push(r)
      m.set(w, list)
    }
    return [...m.entries()]
  }, [scored])

  const sorted = useMemo(() => {
    const rows = [...scored]
    const dir = sortAsc ? 1 : -1
    rows.sort((a, b) => {
      const deltaA = a.value - a.baseline_value
      const deltaB = b.value - b.baseline_value
      switch (sortKey) {
        case 'value':
          return (a.value - b.value) * dir
        case 'delta':
          return (deltaA - deltaB) * dir
        case 'metric':
          return a.metric.localeCompare(b.metric) * dir
        case 'dataset':
          return a.dataset.localeCompare(b.dataset) * dir
        default:
          return a.component.localeCompare(b.component) * dir || a.metric.localeCompare(b.metric) * dir
      }
    })
    return rows
  }, [scored, sortKey, sortAsc])

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc((v) => !v)
    else {
      setSortKey(k)
      setSortAsc(true)
    }
  }

  const timeline = scout.could_have_warned.length
    ? scout.could_have_warned
    : bench.could_have_warned
  const prov = scout.provenance ?? 'mock'
  const bs = ward.board_storage

  return (
    <div className="space-y-4">
      <PageHeader
        title="Evidence"
        subtitle="Every scored number vs a named baseline and interval. Infra checks sit in Health — they are gates, not claims about swarm detection."
        right={<ProvenanceBadge kind="synthetic" />}
      />

      {/* Forest by wing */}
      <Panel>
        <PanelHeader
          eyebrow="Forest · by wing"
          title="Ours (filled) vs baseline (tick) with CI whiskers"
          right={<ProvenanceBadge kind="synthetic" />}
        />
        <div className="space-y-5">
          {byWing.map(([wing, rows]) => (
            <div key={wing}>
              <div className="mono mb-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
                {wing}
              </div>
              <div className="space-y-2.5">
                {rows.map((r) => {
                  const higherIsBetter = !r.metric.includes('fpr') && !r.metric.includes('wrong')
                  const domainHi = Math.max(r.ci_high, r.baseline_value, r.value, 1) * 1.05
                  const domain: [number, number] =
                    r.metric.includes('rank') ? [1, Math.max(12, r.baseline_value)] : [0, domainHi]
                  return (
                    <div
                      key={`${r.component}-${r.metric}-${r.baseline_name}-${r.value}`}
                      className="grid grid-cols-[minmax(140px,220px)_1fr_100px] items-center gap-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] text-fg">{humanMetric(r.metric)}</div>
                        <div className="mono truncate text-[10px] text-faint">
                          vs {r.baseline_name}
                        </div>
                      </div>
                      <CompareBar
                        value={r.value}
                        lo={r.ci_low}
                        hi={r.ci_high}
                        baseline={r.baseline_value}
                        domain={domain}
                        higherIsBetter={higherIsBetter}
                        showLabels={false}
                      />
                      <div className="mono text-right text-[11px] text-muted">
                        {fmtNum(r.value)} · n={r.n_runs}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Health */}
        <Panel>
          <PanelHeader eyebrow="Health" title="Infra / fixture gates" />
          <ul className="space-y-2">
            {health.map((r) => {
              const ok = r.value >= 1
              const Icon = ok ? CheckCircle2 : CircleX
              return (
                <li
                  key={`${r.component}-${r.metric}`}
                  className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2/60 px-3 py-2"
                >
                  <Icon
                    size={16}
                    className={ok ? 'mt-0.5 text-[#4cc94c]' : 'mt-0.5 text-warn'}
                    strokeWidth={2.2}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-fg">{humanMetric(r.metric)}</div>
                    <div className="mono text-[10.5px] text-muted">
                      {r.component} · {r.dataset}
                      {!ok && r.baseline_name !== 'none' && ` · needs ${r.baseline_name}`}
                    </div>
                  </div>
                  <span className="mono text-[11px] text-muted">{ok ? 'ok' : 'fail'}</span>
                </li>
              )
            })}
          </ul>
        </Panel>

        {/* WARD bars */}
        <Panel>
          <PanelHeader
            eyebrow="WARD · board storage"
            title="Wrong-answer rate"
            right={<ProvenanceBadge kind="synthetic" />}
          />
          {bs ? (
            <div className="space-y-4">
              <WardRateBar
                label="Whole-page (baseline)"
                value={bs.whole_page_wrong_rate}
                lo={bs.whole_page_ci[1]}
                hi={bs.whole_page_ci[2]}
                accent="#ec835a"
              />
              <WardRateBar
                label="Append-only"
                value={bs.append_only_wrong_rate}
                lo={bs.append_only_ci[1]}
                hi={bs.append_only_ci[2]}
                accent="#6aa8ff"
              />
              <div className="mono text-[11px] text-muted">
                Δ {fmtNum(bs.delta)} [{fmtNum(bs.delta_ci[1])}, {fmtNum(bs.delta_ci[2])}] ·{' '}
                {bs.n_trials} trials · seed {bs.seed}
              </div>
            </div>
          ) : (
            <div className="text-[13px] text-muted">No board_storage block in ward export</div>
          )}
        </Panel>
      </div>

      {/* Could-have-warned */}
      <Panel className={prov === 'mock' ? 'hatch' : undefined}>
        <PanelHeader
          eyebrow="Could-have-warned"
          title="Wiki coordination timeline"
          right={<ProvenanceBadge kind={prov === 'measured' ? 'measured' : 'mock'} />}
        />
        {prov === 'mock' && (
          <p className="mb-3 text-[12.5px] text-muted">
            {scout.note ??
              'Hand-placed illustrative mock. Do not cite lead time until SCOUT replays the real collusion.wiki stream.'}
          </p>
        )}
        <WarnedTimeline events={timeline} />
      </Panel>

      {/* Sortable table */}
      <Panel pad={false}>
        <div className="border-b border-line px-4 py-3">
          <PanelHeader className="mb-0" eyebrow="Full table" title="Scored results" />
        </div>
        <div className="overflow-auto scroll-thin">
          <table className="w-full min-w-[920px] text-left text-[12.5px]">
            <thead className="bg-panel-2 mono text-[10px] uppercase tracking-wide text-muted">
              <tr>
                {(
                  [
                    ['component', 'Component'],
                    ['dataset', 'Dataset'],
                    ['metric', 'Metric'],
                    ['value', 'Ours'],
                    ['delta', 'Δ'],
                  ] as const
                ).map(([k, label]) => (
                  <th key={k} className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleSort(k)}
                      className="inline-flex items-center gap-1 hover:text-fg"
                    >
                      {label}
                      {sortKey === k &&
                        (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </button>
                  </th>
                ))}
                <th className="px-3 py-2">CI</th>
                <th className="px-3 py-2">Baseline</th>
                <th className="px-3 py-2">n / seed</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const delta = r.value - r.baseline_value
                const beats = delta > 0
                return (
                  <tr
                    key={`${r.component}-${r.metric}-${r.baseline_name}-${r.value}`}
                    className="border-t border-line/70"
                  >
                    <td className="px-3 py-2 font-medium">{r.component}</td>
                    <td className="mono px-3 py-2 text-muted">{r.dataset}</td>
                    <td className="mono px-3 py-2">{humanMetric(r.metric)}</td>
                    <td className="mono px-3 py-2 text-accent">{fmtNum(r.value)}</td>
                    <td
                      className="mono px-3 py-2"
                      style={{ color: beats ? '#4cc94c' : '#ff7b7b' }}
                    >
                      {beats ? '+' : ''}
                      {fmtNum(delta)}
                    </td>
                    <td className="mono px-3 py-2 text-muted">
                      [{fmtNum(r.ci_low)}, {fmtNum(r.ci_high)}]
                    </td>
                    <td className="mono px-3 py-2">
                      {fmtNum(r.baseline_value)}{' '}
                      <span className="text-muted">({r.baseline_name})</span>
                    </td>
                    <td className="mono px-3 py-2 text-muted">
                      {r.n_runs} / {r.seed}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* SCOUT alerts list */}
      <Panel>
        <PanelHeader
          eyebrow="SCOUT alerts"
          title={`${scout.alerts.length} recorded`}
          right={<ProvenanceBadge kind={prov === 'measured' ? 'measured' : 'mock'} />}
        />
        <ul className="space-y-2">
          {scout.alerts.map((a) => (
            <li
              key={a.alert_id}
              className={cx(
                'rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-[12.5px]',
                prov === 'mock' && 'hatch',
              )}
            >
              <div className="flex flex-wrap justify-between gap-2 mono text-[10.5px]">
                <span className={a.gate === 'M_and_C' ? 'text-warn' : 'text-muted'}>
                  {a.gate} · e={a.e_value}
                </span>
                <span className="text-muted">{a.t.slice(0, 16)}</span>
              </div>
              <div className="mt-1 text-fg-2">{a.summary}</div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}

function WardRateBar({
  label,
  value,
  lo,
  hi,
  accent,
}: {
  label: string
  value: number
  lo: number
  hi: number
  accent: string
}) {
  const pct = (v: number) => `${Math.min(100, Math.max(0, v * 100))}%`
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12.5px]">
        <span className="text-fg-2">{label}</span>
        <span className="mono text-fg">
          {fmtNum(value)} <span className="text-muted">[{fmtNum(lo)}, {fmtNum(hi)}]</span>
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-void">
        <div
          className="absolute inset-y-0 rounded-full opacity-35"
          style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, background: accent }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: pct(value), background: accent }}
        />
      </div>
    </div>
  )
}

function WarnedTimeline({
  events,
}: {
  events: Array<{ date: string; label: string; kind: string; t?: string }>
}) {
  if (events.length === 0) return null
  const t0 = +new Date(events[0]!.date)
  const t1 = +new Date(events[events.length - 1]!.date)
  const W = 900
  const pad = 48
  const xOf = (d: string) => pad + ((+new Date(d) - t0) / (t1 - t0 || 1)) * (W - pad * 2)

  const color = (kind: string) => {
    if (kind === 'scout_alert') return '#fab219'
    if (kind === 'ground_truth') return '#ff5a5a'
    if (kind === 'human') return INK.muted
    return '#6aa8ff'
  }

  return (
    <svg viewBox={`0 0 ${W} 100`} className="h-24 w-full">
      <line x1={pad} y1={48} x2={W - pad} y2={48} stroke={INK.line2} strokeWidth={2} />
      {events.map((ev, i) => {
        const x = xOf(ev.date)
        const above = i % 2 === 0
        return (
          <g key={`${ev.date}-${ev.label}`}>
            <circle cx={x} cy={48} r={6} fill={color(ev.kind)} />
            <text
              x={x}
              y={above ? 22 : 78}
              textAnchor="middle"
              fill={INK.fg2}
              fontSize={10.5}
              fontFamily="Inter, sans-serif"
            >
              {ev.label.length > 36 ? `${ev.label.slice(0, 34)}…` : ev.label}
            </text>
            <text
              x={x}
              y={above ? 34 : 90}
              textAnchor="middle"
              fill={INK.faint}
              fontSize={9}
              fontFamily="JetBrains Mono, monospace"
            >
              {dayMonth(ev.date)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
