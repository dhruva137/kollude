import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  EmptyNote,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  VerdictChip,
  cx,
} from '../components/ui'
import { FAMILY_COLOR, INK, VERDICT_COLOR } from '../lib/colors'
import { ROLE_LABEL, roleRank } from '../lib/episode'
import { relSeconds } from '../lib/format'
import { agentSlug, useJson } from '../lib/loadData'
import type { AgentData, SwarmMap } from '../types'

const ACTION_COLOR: Record<string, string> = {
  navigate: '#6aa8ff',
  type: '#fab219',
  click: '#0ca30c',
  error: '#ff5a5a',
  get_write: '#ec835a',
  get_read: '#6aa8ff',
  revision_span: '#d55181',
  read: '#6aa8ff',
  write: '#ec835a',
}

export function AgentSayDoView() {
  const [params, setParams] = useSearchParams()
  const map = useJson<SwarmMap>('swarm_map.json')

  const agents = useMemo(() => {
    if (map.status !== 'ready') return []
    return [...map.data.nodes].sort(
      (a, b) => roleRank(a.role) - roleRank(b.role) || a.label.localeCompare(b.label),
    )
  }, [map])

  const agentId = params.get('id') ?? (agents[0] ? agentSlug(agents[0].id) : 'forge-Big')
  const agent = useJson<AgentData>(`agents/${agentId}.json`)

  if (map.status === 'error') return <ErrorBlock error={map.error} />
  if (map.status === 'loading') return <LoadingBlock label="Loading agent roster" />
  if (agent.status === 'error') return <ErrorBlock error={agent.error} />
  if (agent.status === 'loading') return <LoadingBlock label="Loading say/do" />

  return (
    <SayDoInner
      key={agentId}
      agent={agent.data}
      agents={agents}
      agentId={agentId}
      t0={Date.parse(map.data.t_min)}
      t1={Date.parse(map.data.t_max)}
      onPick={(id) => setParams({ id })}
    />
  )
}

function SayDoInner({
  agent,
  agents,
  agentId,
  t0,
  t1,
  onPick,
}: {
  agent: AgentData
  agents: SwarmMap['nodes']
  agentId: string
  t0: number
  t1: number
  onPick: (id: string) => void
}) {
  const [selClaim, setSelClaim] = useState<string | null>(agent.says[0]?.claim_id ?? null)
  const claim = agent.says.find((s) => s.claim_id === selClaim) ?? agent.says[0]
  const cited = new Set(claim?.cited_action_ids ?? [])

  const ts = [
    ...agent.says.map((s) => Date.parse(s.t)),
    ...agent.does.map((d) => Date.parse(d.t)),
    t0,
    t1,
  ]
  const lo = Math.min(...ts)
  const hi = Math.max(...ts)
  const span = hi - lo || 1

  const width = 680
  const left = 64
  const plotW = width - left - 20
  const xOf = (iso: string) => left + ((Date.parse(iso) - lo) / span) * plotW

  return (
    <div>
      <PageHeader
        title="Agents · Say / Do"
        subtitle="What each agent claimed versus what the action log shows they actually did — second-resolution lanes over the 80 s episode."
        right={<ProvenanceBadge kind="synthetic" />}
      />

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Agent rail */}
        <Panel pad={false} className="max-h-[calc(100vh-10rem)] overflow-auto scroll-thin">
          <div className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-2">
            <div className="mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
              Swarm roster
            </div>
          </div>
          <ul className="p-1.5">
            {agents.map((n) => {
              const slug = agentSlug(n.id)
              const active = slug === agentId
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onPick(slug)}
                    className={cx(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                      active ? 'bg-panel-3 text-fg' : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: FAMILY_COLOR[n.model_family] }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{n.label}</span>
                      <span className="mono block text-[10px] text-muted">
                        {ROLE_LABEL[n.role] ?? n.role}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Panel>

        <div className="min-w-0 space-y-3">
          <Panel>
            <PanelHeader
              eyebrow={`${ROLE_LABEL[agent.role] ?? agent.role} · ${agent.model_family}`}
              title={agent.label}
              right={
                <Link
                  to="/brain"
                  className="mono text-[11px] text-accent hover:underline"
                >
                  Open Brain →
                </Link>
              }
            />

            <div className="overflow-x-auto">
              <svg width={width} height={150} className="max-w-full">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                  const x = left + f * plotW
                  const iso = new Date(lo + span * f).toISOString()
                  return (
                    <g key={f}>
                      <line x1={x} y1={18} x2={x} y2={118} stroke={INK.line} />
                      <text
                        x={x}
                        y={138}
                        fill={INK.muted}
                        fontSize={9.5}
                        fontFamily="JetBrains Mono, monospace"
                        textAnchor="middle"
                      >
                        {relSeconds(iso, lo)}
                      </text>
                    </g>
                  )
                })}

                <text x={8} y={40} fill={INK.muted} fontSize={10} fontFamily="JetBrains Mono, monospace">
                  SAYS
                </text>
                <line x1={left} x2={width - 12} y1={36} y2={36} stroke={INK.line2} />
                {agent.says.map((s) => (
                  <g
                    key={s.claim_id}
                    transform={`translate(${xOf(s.t)},36)`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelClaim(s.claim_id)}
                  >
                    <rect
                      x={-5}
                      y={-9}
                      width={10}
                      height={18}
                      rx={2}
                      fill={VERDICT_COLOR[s.verdict]}
                      stroke={selClaim === s.claim_id ? '#fff' : 'transparent'}
                      strokeWidth={1.5}
                    >
                      <title>{s.text}</title>
                    </rect>
                  </g>
                ))}

                <text x={8} y={96} fill={INK.muted} fontSize={10} fontFamily="JetBrains Mono, monospace">
                  DOES
                </text>
                <line x1={left} x2={width - 12} y1={92} y2={92} stroke={INK.line2} />
                {agent.does.map((d) => {
                  const color = ACTION_COLOR[d.type] ?? INK.muted
                  const hot = cited.has(d.action_id)
                  return (
                    <g key={d.action_id} transform={`translate(${xOf(d.t)},92)`}>
                      <line
                        y1={-12}
                        y2={12}
                        stroke={color}
                        strokeWidth={hot ? 2.6 : 1.6}
                        opacity={hot ? 1 : 0.55}
                      >
                        <title>
                          {d.type}: {d.detail}
                        </title>
                      </line>
                    </g>
                  )
                })}

                {claim?.cited_action_ids.map((aid) => {
                  const act = agent.does.find((d) => d.action_id === aid)
                  if (!act) return null
                  return (
                    <path
                      key={aid}
                      d={`M ${xOf(claim.t)} 46 C ${xOf(claim.t)} 66, ${xOf(act.t)} 74, ${xOf(act.t)} 80`}
                      fill="none"
                      stroke="#6aa8ff88"
                      strokeWidth={1.2}
                    />
                  )
                })}
              </svg>
            </div>

            {agent.does.length === 0 && agent.says.length === 0 && (
              <EmptyNote>No claims or actions for this agent</EmptyNote>
            )}
          </Panel>

          <Panel pad={false}>
            <div className="border-b border-line px-4 py-3">
              <PanelHeader
                className="mb-0"
                eyebrow="Claims"
                title={`${agent.says.length} extracted · click a row`}
              />
            </div>
            <div className="max-h-[320px] overflow-auto scroll-thin">
              <table className="w-full text-left text-[12.5px]">
                <thead className="sticky top-0 bg-panel-2 mono text-[10px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">t</th>
                    <th className="px-3 py-2">Verdict</th>
                    <th className="px-3 py-2">Claim</th>
                    <th className="px-3 py-2">Cited actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.says.map((s) => (
                    <tr
                      key={s.claim_id}
                      onClick={() => setSelClaim(s.claim_id)}
                      className={cx(
                        'cursor-pointer border-t border-line/70 transition',
                        selClaim === s.claim_id ? 'bg-panel-3' : 'hover:bg-panel-2/80',
                      )}
                    >
                      <td className="mono whitespace-nowrap px-3 py-2 text-muted">
                        {relSeconds(s.t, lo)}
                      </td>
                      <td className="px-3 py-2">
                        <VerdictChip verdict={s.verdict} size="xs" />
                      </td>
                      <td className="max-w-[360px] truncate px-3 py-2 text-fg-2" title={s.text}>
                        {s.text}
                      </td>
                      <td className="mono px-3 py-2 text-muted">
                        {s.cited_action_ids.length || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {claim && (
            <Panel>
              <PanelHeader
                eyebrow="Selected claim"
                title={<VerdictChip verdict={claim.verdict} />}
                right={
                  <span className="mono text-[11px] text-muted">{relSeconds(claim.t, lo)}</span>
                }
              />
              <blockquote className="border-l-2 border-accent/50 pl-2.5 text-[13px] leading-relaxed text-fg-2">
                “{claim.text}”
              </blockquote>
              <div className="mono mt-2 text-[10.5px] text-faint">
                conformal [{claim.conformal_set.join(', ') || '∅'}] · evidence{' '}
                {claim.evidence_event_ids.join(', ') || '—'}
              </div>
            </Panel>
          )}

          {(agent.memory_diff.before || agent.memory_diff.after) && (
            <div className="grid gap-3 md:grid-cols-2">
              <Panel>
                <PanelHeader eyebrow="Memory" title="Before" />
                <pre className="mono whitespace-pre-wrap text-[11px] text-muted">
                  {agent.memory_diff.before || '—'}
                </pre>
              </Panel>
              <Panel>
                <PanelHeader eyebrow="Memory" title="After" />
                <pre className="mono whitespace-pre-wrap text-[11px] text-fg-2">
                  {agent.memory_diff.after || '—'}
                </pre>
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
