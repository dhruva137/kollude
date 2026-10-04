import { GitBranch, Network, Percent } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  EmptyNote,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  StatTile,
  cx,
} from '../components/ui'
import { FAMILY_COLOR, INK, WORKSTREAM_COLORS } from '../lib/colors'
import { ROLE_LABEL, roleRank } from '../lib/episode'
import { fmtCi, fmtNum } from '../lib/format'
import { agentSlug, useJson } from '../lib/loadData'
import type { OrgChart } from '../types'

type LaidOut = {
  id: string
  label: string
  role: string
  inferredRole: string
  model_family: OrgChart['nodes'][number]['model_family']
  load: number
  x: number
  y: number
  wsColor: string
  wsName: string
  isTrueOrch: boolean
  isRecovered: boolean
}

function inferRoles(data: OrgChart): Map<string, string> {
  const out = new Map<string, string>()
  const children = new Map<string, string[]>()
  const parents = new Map<string, string>()
  for (const e of data.edges) {
    const list = children.get(e.src) ?? []
    list.push(e.dst)
    children.set(e.src, list)
    parents.set(e.dst, e.src)
  }
  const roots = data.nodes.filter((n) => !parents.has(n.id))
  const orch = data.recovered_orchestrator || data.true_orchestrator
  for (const n of data.nodes) {
    if (n.id === orch || n.role === 'coordinator' || n.role === 'orchestrator') {
      out.set(n.id, 'coordinator')
    } else if ((children.get(n.id)?.length ?? 0) > 0) {
      out.set(n.id, 'relay')
    } else {
      out.set(n.id, 'worker')
    }
  }
  // Ensure roots that aren't orch still get a role
  for (const r of roots) {
    if (!out.has(r.id)) out.set(r.id, 'coordinator')
  }
  return out
}

function layoutTree(data: OrgChart, inferred: Map<string, string>): LaidOut[] {
  const children = new Map<string, string[]>()
  const parents = new Map<string, string>()
  for (const e of data.edges) {
    const list = children.get(e.src) ?? []
    list.push(e.dst)
    children.set(e.src, list)
    parents.set(e.dst, e.src)
  }

  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const wsOf = new Map<string, { color: string; name: string }>()
  data.workstreams.forEach((ws, i) => {
    const color = ws.color || WORKSTREAM_COLORS[i % WORKSTREAM_COLORS.length]!
    for (const a of ws.actors) {
      if (!wsOf.has(a)) wsOf.set(a, { color, name: ws.name })
    }
  })

  const rootId = data.true_orchestrator
  const levels: string[][] = []
  const seen = new Set<string>()
  const q: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  while (q.length) {
    const { id, depth } = q.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    if (!levels[depth]) levels[depth] = []
    levels[depth]!.push(id)
    for (const c of children.get(id) ?? []) q.push({ id: c, depth: depth + 1 })
  }
  // orphans not reachable from root
  for (const n of data.nodes) {
    if (!seen.has(n.id)) {
      const depth = roleRank(inferred.get(n.id) ?? n.role)
      if (!levels[depth]) levels[depth] = []
      levels[depth]!.push(n.id)
      seen.add(n.id)
    }
  }

  const W = 860
  const top = 56
  const rowGap = 110
  const out: LaidOut[] = []
  levels.forEach((row, depth) => {
    const n = row.length
    row.forEach((id, i) => {
      const node = byId.get(id)!
      const ws = wsOf.get(id)
      out.push({
        id,
        label: node.label,
        role: node.role,
        inferredRole: inferred.get(id) ?? node.role,
        model_family: node.model_family,
        load: node.load,
        x: ((i + 1) / (n + 1)) * W,
        y: top + depth * rowGap,
        wsColor: ws?.color ?? FAMILY_COLOR[node.model_family],
        wsName: ws?.name ?? '—',
        isTrueOrch: id === data.true_orchestrator,
        isRecovered: id === data.recovered_orchestrator,
      })
    })
  })
  return out
}

export function OrgChartView() {
  const org = useJson<OrgChart>('org_chart.json')
  const [selected, setSelected] = useState<string | null>(null)

  if (org.status === 'error') return <ErrorBlock error={org.error} />
  if (org.status === 'loading') return <LoadingBlock label="Loading org chart" />

  return <OrgInner data={org.data} selected={selected} setSelected={setSelected} />
}

function OrgInner({
  data,
  selected,
  setSelected,
}: {
  data: OrgChart
  selected: string | null
  setSelected: (id: string | null) => void
}) {
  const inferred = useMemo(() => inferRoles(data), [data])
  const nodes = useMemo(() => layoutTree(data, inferred), [data, inferred])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const W = 900
  const H = Math.max(360, (Math.max(...nodes.map((n) => n.y)) || 200) + 80)
  const sel = selected ? byId.get(selected) : byId.get(data.true_orchestrator)

  const match = data.recovered_orchestrator === data.true_orchestrator

  return (
    <div>
      <PageHeader
        title="Org chart"
        subtitle="Recovered hierarchy from message centrality — coordinator → relays → workers, colored by workstream. Inferred role may differ from the exported label."
        right={<ProvenanceBadge kind="synthetic" />}
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          icon={Network}
          accent="#6aa8ff"
          label="Orchestrator rank"
          value={data.orchestrator_rank ?? '—'}
          sub={match ? 'recovered = true' : 'mismatch'}
        />
        <StatTile
          icon={GitBranch}
          accent="#6aa8ff"
          label="Workstream NMI"
          value={fmtNum(data.workstream_nmi ?? 0)}
          sub="vs chance baseline 0"
        />
        <StatTile
          icon={Percent}
          accent="#fab219"
          label="Load Gini"
          value={fmtNum(data.gini)}
          sub={fmtCi(data.gini, data.gini_ci_low, data.gini_ci_high)}
        />
        <StatTile
          label="Workstreams"
          value={data.workstreams.length}
          sub={`${data.nodes.length} agents`}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel pad={false} className="overflow-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[480px] w-full min-w-[640px]">
            <defs>
              <marker
                id="orgArrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,1 L9,5 L0,9 z" fill={INK.fg2} />
              </marker>
            </defs>

            {/* level bands */}
            {['Coordinator', 'Relay', 'Workers'].map((label, i) => (
              <text
                key={label}
                x={16}
                y={48 + i * 110}
                fill={INK.faint}
                fontSize={10}
                fontFamily="JetBrains Mono, monospace"
              >
                {label}
              </text>
            ))}

            {data.edges.map((e) => {
              const a = byId.get(e.src)
              const b = byId.get(e.dst)
              if (!a || !b) return null
              const midY = (a.y + b.y) / 2
              return (
                <path
                  key={`${e.src}-${e.dst}`}
                  d={`M ${a.x} ${a.y + 18} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y - 18}`}
                  fill="none"
                  stroke={INK.line2}
                  strokeWidth={1.4}
                  markerEnd="url(#orgArrow)"
                />
              )
            })}

            {nodes.map((n) => {
              const active = sel?.id === n.id
              const r = n.isTrueOrch ? 16 : 11 + n.load * 14
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(n.id)}
                >
                  {n.isTrueOrch && (
                    <circle r={r + 6} fill="none" stroke="#ff5a5a" strokeWidth={1.5} opacity={0.8} />
                  )}
                  <circle
                    r={r}
                    fill={n.wsColor}
                    stroke={active ? '#fff' : INK.panel}
                    strokeWidth={active ? 2 : 1.2}
                  />
                  <text
                    y={r + 14}
                    textAnchor="middle"
                    fill={INK.fg}
                    fontSize={11}
                    fontFamily="Inter, sans-serif"
                  >
                    {n.label}
                  </text>
                  <text
                    y={r + 26}
                    textAnchor="middle"
                    fill={INK.muted}
                    fontSize={9}
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {n.wsName}
                  </text>
                </g>
              )
            })}
          </svg>
        </Panel>

        <aside className="flex flex-col gap-3">
          <Panel>
            <PanelHeader eyebrow="Selected agent" title={sel?.label ?? '—'} />
            {sel ? (
              <div className="space-y-2 text-[13px]">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-md border border-line bg-panel-2 px-2 py-0.5 mono text-[11px]">
                    exported: {ROLE_LABEL[sel.role] ?? sel.role}
                  </span>
                  <span
                    className={cx(
                      'rounded-md border px-2 py-0.5 mono text-[11px]',
                      sel.inferredRole !== sel.role
                        ? 'border-warn/40 bg-warn/10 text-warn'
                        : 'border-line bg-panel-2 text-muted',
                    )}
                  >
                    inferred: {ROLE_LABEL[sel.inferredRole] ?? sel.inferredRole}
                  </span>
                </div>
                <div className="mono text-[11.5px] text-muted">
                  load {fmtNum(sel.load)} · {sel.wsName}
                </div>
                <div className="mono text-[11px] text-faint">{sel.id}</div>
                {sel.isTrueOrch && (
                  <div className="text-[12px] text-[#ff7b7b]">True orchestrator (ground truth)</div>
                )}
                {sel.isRecovered && !sel.isTrueOrch && (
                  <div className="text-[12px] text-warn">Recovered as orchestrator (miss)</div>
                )}
              </div>
            ) : (
              <EmptyNote>Select a node</EmptyNote>
            )}
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Workstreams" title="Color key" />
            <ul className="space-y-2">
              {data.workstreams.map((ws, i) => (
                <li key={ws.id} className="flex items-start gap-2 text-[12.5px]">
                  <span
                    className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{
                      background: ws.color || WORKSTREAM_COLORS[i % WORKSTREAM_COLORS.length],
                    }}
                  />
                  <div>
                    <div className="text-fg">{ws.name}</div>
                    <div className="mono text-[10.5px] text-muted">
                      {ws.actors.map((a) => agentSlug(a).replace(/^forge-/, '')).join(', ')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
