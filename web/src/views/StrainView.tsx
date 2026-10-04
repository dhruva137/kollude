import { useMemo, useState } from 'react'
import {
  EmptyNote,
  ErrorBlock,
  LegendSwatch,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  VerdictChip,
  cx,
} from '../components/ui'
import { useConservative } from '../context/ConservativeMode'
import { FAMILY_COLOR, INK, VERDICT_COLOR, isWeakTier, tierStroke } from '../lib/colors'
import { fmtNum, relSeconds, titleCase } from '../lib/format'
import { agentLabel, agentSlug, useJson } from '../lib/loadData'
import type { EvidenceTier, StrainData, StrainIndex, StrainMember, SwarmMap } from '../types'

type AltParsed = {
  for_edge: string
  hypothesis: string
  p: number
  src_claim?: string
  src_event?: string
  raw: string
}

type AgentAdopt = {
  agent_id: string
  slug: string
  label: string
  first: StrainMember
  nClaims: number
  family: string
}

type TxEdge = {
  key: string
  parent: StrainMember
  child: StrainMember
  tier: EvidenceTier
  p: number
}

function parseAlt(a: StrainData['alternatives'][number]): AltParsed {
  let p = 0
  let src_claim: string | undefined
  let src_event: string | undefined
  try {
    const j = JSON.parse(a.detail) as { p?: number; src_claim?: string; src_event?: string }
    p = typeof j.p === 'number' ? j.p : 0
    src_claim = j.src_claim
    src_event = j.src_event
  } catch {
    /* detail may be plain text */
  }
  return { for_edge: a.for_edge, hypothesis: a.hypothesis, p, src_claim, src_event, raw: a.detail }
}

export function StrainView() {
  const { conservative } = useConservative()
  const idx = useJson<StrainIndex>('strains/index.json')
  const swarm = useJson<SwarmMap>('swarm_map.json')

  const sorted = useMemo(() => {
    if (idx.status !== 'ready') return []
    return [...idx.data.strains].sort((a, b) => b.n_members - a.n_members)
  }, [idx])

  const [picked, setPicked] = useState<string | null>(null)
  const activeFile = picked ?? sorted[0]?.file ?? null
  const strain = useJson<StrainData>(activeFile ? `strains/${activeFile}` : null)

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [showMem, setShowMem] = useState(true)
  const [showCorr, setShowCorr] = useState(true)

  if (idx.status === 'error') return <ErrorBlock error={idx.error} />
  if (swarm.status === 'error') return <ErrorBlock error={swarm.error} />
  if (strain.status === 'error') return <ErrorBlock error={strain.error} />
  if (idx.status === 'loading' || swarm.status === 'loading' || strain.status === 'loading' || !activeFile)
    return <LoadingBlock label="Loading strain tree" />

  const st = strain.data
  const map = swarm.data

  return (
    <StrainInner
      st={st}
      map={map}
      sorted={sorted}
      activeFile={activeFile}
      onPick={(file) => {
        setPicked(file)
        setSelectedAgent(null)
      }}
      conservative={conservative}
      selectedAgent={selectedAgent}
      setSelectedAgent={setSelectedAgent}
      showMem={showMem}
      setShowMem={setShowMem}
      showCorr={showCorr}
      setShowCorr={setShowCorr}
    />
  )
}

function StrainInner({
  st,
  map,
  sorted,
  activeFile,
  onPick,
  conservative,
  selectedAgent,
  setSelectedAgent,
  showMem,
  setShowMem,
  showCorr,
  setShowCorr,
}: {
  st: StrainData
  map: SwarmMap
  sorted: StrainIndex['strains']
  activeFile: string
  onPick: (file: string) => void
  conservative: boolean
  selectedAgent: string | null
  setSelectedAgent: (id: string | null) => void
  showMem: boolean
  setShowMem: (v: boolean) => void
  showCorr: boolean
  setShowCorr: (v: boolean) => void
}) {
  const familyOf = useMemo(() => {
    const m = new Map<string, string>()
    map.nodes.forEach((n) => m.set(agentSlug(n.id), n.model_family))
    return m
  }, [map])

  const labelOf = useMemo(() => {
    const m = new Map<string, string>()
    map.nodes.forEach((n) => m.set(agentSlug(n.id), n.label))
    return m
  }, [map])

  const t0 = useMemo(() => {
    const times = st.members.map((m) => Date.parse(m.t))
    return Math.min(Date.parse(map.t_min), ...times)
  }, [st, map])

  const t1 = useMemo(() => {
    const times = st.members.map((m) => Date.parse(m.t))
    return Math.max(Date.parse(map.t_max), ...times)
  }, [st, map])

  const adoptions = useMemo<AgentAdopt[]>(() => {
    const by = new Map<string, StrainMember[]>()
    for (const m of st.members) {
      const slug = agentSlug(m.agent_id)
      const list = by.get(slug) ?? []
      list.push(m)
      by.set(slug, list)
    }
    return [...by.entries()]
      .map(([slug, members]) => {
        const sortedM = [...members].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
        const first = sortedM[0]!
        return {
          agent_id: first.agent_id,
          slug,
          label: labelOf.get(slug) ?? agentLabel(first.agent_id),
          first,
          nClaims: members.length,
          family: familyOf.get(slug) ?? 'other',
        }
      })
      .sort((a, b) => Date.parse(a.first.t) - Date.parse(b.first.t))
  }, [st, labelOf, familyOf])

  const byClaim = useMemo(() => new Map(st.members.map((m) => [m.claim_id, m])), [st])

  const edges = useMemo<TxEdge[]>(() => {
    const out: TxEdge[] = []
    // Prefer first-adoption edges: for each agent after origin, find earliest inbound
    // transmission from a different agent.
    for (const ad of adoptions) {
      if (agentSlug(ad.first.agent_id) === agentSlug(st.origin.agent_id)) continue
      const inbound = st.members
        .filter((m) => agentSlug(m.agent_id) === ad.slug && m.parent_claim_id)
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
      for (const child of inbound) {
        const parent = byClaim.get(child.parent_claim_id!)
        if (!parent) continue
        if (agentSlug(parent.agent_id) === ad.slug) continue
        const tier = (child.tier ?? 'strong') as EvidenceTier
        if (conservative && isWeakTier(tier)) continue
        out.push({
          key: `${parent.claim_id}->${child.claim_id}`,
          parent,
          child,
          tier,
          p: child.p_transmission ?? 0,
        })
        break
      }
    }
    return out
  }, [adoptions, st, byClaim, conservative])

  const alts = useMemo(() => st.alternatives.map(parseAlt).sort((a, b) => b.p - a.p), [st])

  const selected = selectedAgent
    ? adoptions.find((a) => a.slug === selectedAgent) ?? null
    : adoptions.find((a) => a.slug === agentSlug(st.origin.agent_id)) ?? adoptions[0] ?? null

  const laneH = 40
  const left = 108
  const top = 36
  const width = 880
  const height = top + adoptions.length * laneH + 56
  const plotW = width - left - 36
  const span = t1 - t0 || 1
  const xOf = (iso: string) => left + ((Date.parse(iso) - t0) / span) * plotW
  const yOf = (slug: string) => {
    const i = adoptions.findIndex((a) => a.slug === slug)
    return top + (i < 0 ? 0 : i) * laneH + laneH / 2
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div>
      <PageHeader
        title="Strain tree"
        subtitle="Per-agent first adoption of the planted fact. Collapse hundreds of claim repeats into who got infected when — and which alternative parents TRACE considered."
        right={
          <>
            <ProvenanceBadge kind="synthetic" />
            <select
              className="mono rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] text-fg"
              value={activeFile}
              onChange={(e) => onPick(e.target.value)}
              aria-label="Strain"
            >
              {sorted.map((s) => (
                <option key={s.strain_id} value={s.file}>
                  {s.label.slice(0, 48)}
                  {s.label.length > 48 ? '…' : ''} · {s.n_members} claims · {s.n_agents} agents
                </option>
              ))}
            </select>
          </>
        }
      />

      <Panel className="mb-3 !py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictChip verdict={st.origin.verdict} />
          <span className="mono text-[11.5px] text-muted">
            origin {agentLabel(st.origin.agent_id)} · {adoptions.length} agents · {st.members.length} claims
          </span>
          <label className="ml-auto flex items-center gap-1.5 mono text-[11px] text-muted">
            <input type="checkbox" checked={showMem} onChange={(e) => setShowMem(e.target.checked)} />
            memories
          </label>
          <label className="flex items-center gap-1.5 mono text-[11px] text-muted">
            <input type="checkbox" checked={showCorr} onChange={(e) => setShowCorr(e.target.checked)} />
            corrections
          </label>
          {conservative && (
            <span className="mono text-[11px] text-[#4cc94c]">weak / unresolved links hidden</span>
          )}
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel pad={false} className="overflow-auto">
          <svg width={width} height={height} className="block min-w-full">
            {ticks.map((f) => {
              const x = left + f * plotW
              const iso = new Date(t0 + span * f).toISOString()
              return (
                <g key={f}>
                  <line x1={x} y1={top - 10} x2={x} y2={height - 40} stroke={INK.line} />
                  <text
                    x={x}
                    y={height - 22}
                    fill={INK.muted}
                    fontSize={10}
                    fontFamily="JetBrains Mono, monospace"
                    textAnchor="middle"
                  >
                    {relSeconds(iso, t0)}
                  </text>
                </g>
              )
            })}

            {adoptions.map((a, i) => (
              <g key={a.slug}>
                <line
                  x1={left}
                  x2={width - 24}
                  y1={top + i * laneH + laneH / 2}
                  y2={top + i * laneH + laneH / 2}
                  stroke={INK.line}
                />
                <text
                  x={8}
                  y={top + i * laneH + laneH / 2 + 4}
                  fill={FAMILY_COLOR[(a.family as keyof typeof FAMILY_COLOR) ?? 'other']}
                  fontSize={11.5}
                  fontFamily="Inter, sans-serif"
                >
                  {a.label}
                </text>
                <text
                  x={8}
                  y={top + i * laneH + laneH / 2 + 16}
                  fill={INK.faint}
                  fontSize={9}
                  fontFamily="JetBrains Mono, monospace"
                >
                  ×{a.nClaims}
                </text>
              </g>
            ))}

            {edges.map((e) => {
              const x1 = xOf(e.parent.t)
              const y1 = yOf(agentSlug(e.parent.agent_id))
              const x2 = xOf(e.child.t)
              const y2 = yOf(agentSlug(e.child.agent_id))
              const mid = (x1 + x2) / 2
              const stStyle = tierStroke(e.tier)
              const hot = e.child.correction
              return (
                <path
                  key={e.key}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={hot ? '#ff5a5a' : stStyle.color}
                  strokeWidth={stStyle.width}
                  strokeOpacity={stStyle.opacity}
                  strokeDasharray={stStyle.dasharray || undefined}
                />
              )
            })}

            {adoptions.map((a) => {
              const m = a.first
              if (m.correction && !showCorr) return null
              const x = xOf(m.t)
              const y = yOf(a.slug)
              const isOrigin = a.slug === agentSlug(st.origin.agent_id)
              const color = VERDICT_COLOR[m.verdict]
              const sel = selected?.slug === a.slug
              return (
                <g
                  key={a.slug}
                  transform={`translate(${x},${y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedAgent(a.slug)}
                >
                  {isOrigin && (
                    <circle r={12} fill="none" stroke="#ff5a5a" strokeWidth={1.5} opacity={0.85} />
                  )}
                  {m.correction ? (
                    <g>
                      <line x1={-5} y1={-5} x2={5} y2={5} stroke="#ff5a5a" strokeWidth={2.2} />
                      <line x1={5} y1={-5} x2={-5} y2={5} stroke="#ff5a5a" strokeWidth={2.2} />
                    </g>
                  ) : m.memory && showMem ? (
                    <polygon
                      points="0,-8 8,0 0,8 -8,0"
                      fill={color}
                      stroke={sel ? '#fff' : INK.panel}
                      strokeWidth={sel ? 1.8 : 1}
                    />
                  ) : (
                    <circle
                      r={isOrigin ? 7 : 5.5}
                      fill={color}
                      stroke={sel ? '#fff' : INK.panel}
                      strokeWidth={sel ? 1.8 : 1}
                    />
                  )}
                </g>
              )
            })}
          </svg>
          <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2">
            <LegendSwatch color="#ff5a5a" shape="ring" label="patient zero / origin" />
            <LegendSwatch color={VERDICT_COLOR.contradicted} label="first adoption" />
            <LegendSwatch shape="line" color={INK.fg2} label="transmission" />
            <LegendSwatch shape="line" color={INK.fg2} dash="5 4" label="weak (hidden in conservative)" />
          </div>
        </Panel>

        <aside className="flex flex-col gap-3">
          <Panel>
            <PanelHeader eyebrow="Evidence drawer" title={selected?.label ?? 'Select an agent'} />
            {selected ? (
              <div className="space-y-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictChip verdict={selected.first.verdict} />
                  <span className="mono text-[11px] text-muted">
                    {relSeconds(selected.first.t, t0)} · {selected.nClaims} claims
                  </span>
                </div>
                <blockquote className="border-l-2 border-accent/50 pl-2.5 text-[12.5px] leading-relaxed text-fg-2">
                  “{selected.first.text}”
                </blockquote>
                <div className="mono text-[10.5px] text-faint">{selected.first.claim_id}</div>
              </div>
            ) : (
              <EmptyNote>Select an adoption marker</EmptyNote>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="Alternatives"
              title={`${alts.length} rival hypotheses`}
              right={<span className="mono text-[10px] text-muted">p-bar</span>}
            />
            {alts.length === 0 ? (
              <EmptyNote>None listed for this strain</EmptyNote>
            ) : (
              <div className="max-h-[360px] space-y-2 overflow-auto scroll-thin">
                {alts.slice(0, 24).map((a, i) => (
                  <div
                    key={`${a.for_edge}-${a.hypothesis}-${i}`}
                    className="rounded-lg border border-line bg-panel-2/70 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-fg">{titleCase(a.hypothesis)}</span>
                      <span className="mono text-[11px] text-accent">{fmtNum(a.p)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-void">
                      <div
                        className="h-full rounded-full bg-accent/80"
                        style={{ width: `${Math.min(100, a.p * 100)}%` }}
                      />
                    </div>
                    <div className="mono mt-1.5 truncate text-[10px] text-muted" title={a.for_edge}>
                      edge {a.for_edge}
                    </div>
                    {(a.src_claim || a.src_event) && (
                      <div className="mono mt-0.5 truncate text-[10px] text-faint">
                        {[a.src_claim, a.src_event].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {st.mutations.length > 0 && (
            <Panel>
              <PanelHeader eyebrow="Mutations" title={`${st.mutations.length} text diffs`} />
              <ul className="space-y-1.5">
                {st.mutations.slice(0, 8).map((m, i) => (
                  <li key={i} className={cx('mono text-[11px] text-muted')}>
                    {m.diff}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  )
}
