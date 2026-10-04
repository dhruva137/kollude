import * as d3 from 'd3'
import { ArrowRight, Crosshair, GitBranch, Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ErrorBlock,
  LegendSwatch,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  cx,
  useTooltip,
} from '../components/ui'
import { useConservative } from '../context/ConservativeMode'
import { INK, TIER_LABEL, isWeakTier, tierStroke } from '../lib/colors'
import { ROLE_LABEL, useEpisode, type AgentState, type Episode } from '../lib/episode'
import { relSeconds } from '../lib/format'
import { agentSlug } from '../lib/loadData'
import type { EvidenceTier } from '../types'

const INFECTED = '#ff5a5a'
const SUSCEPTIBLE = '#6aa8ff'
const TIER_RANK: Record<EvidenceTier, number> = { explicit: 3, strong: 2, weak: 1, unresolved: 0 }

type Link2 = {
  key: string
  src: string
  dst: string
  t: number
  p: number
  tier: EvidenceTier
  n: number
}

/** Collapse claim-level edges to one link per agent pair (best tier, max p, first time). */
function aggregate(ep: Episode): Link2[] {
  const m = new Map<string, Link2>()
  for (const e of ep.edges) {
    const src = agentSlug(e.src)
    const dst = agentSlug(e.dst)
    const key = `${src}→${dst}`
    const t = Date.parse(e.t)
    const cur = m.get(key)
    if (!cur) m.set(key, { key, src, dst, t, p: e.p_transmission, tier: e.tier, n: 1 })
    else {
      cur.n++
      cur.t = Math.min(cur.t, t)
      cur.p = Math.max(cur.p, e.p_transmission)
      if (TIER_RANK[e.tier] > TIER_RANK[cur.tier]) cur.tier = e.tier
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t)
}

export function SwarmMapView() {
  const ep = useEpisode()
  if (ep.status === 'error') return <ErrorBlock error={ep.error} />
  if (ep.status === 'loading') return <LoadingBlock label="Growing the swarm map" />
  return <SwarmMapInner ep={ep.data} />
}

function SwarmMapInner({ ep }: { ep: Episode }) {
  const { conservative } = useConservative()
  const links = useMemo(() => aggregate(ep), [ep])
  const [t, setT] = useState(ep.t1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const [selected, setSelected] = useState<string | null>(null)
  const raf = useRef(0)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) * speed
      last = now
      setT((cur) => {
        const nx = cur + dt
        if (nx >= ep.t1) {
          setPlaying(false)
          return ep.t1
        }
        return nx
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, speed, ep.t1])

  const visible = links.filter((l) => l.t <= t && (!conservative || !isWeakTier(l.tier)))
  const hiddenByConservative = links.filter((l) => l.t <= t && isWeakTier(l.tier)).length
  const infectedNow = ep.agents.filter((a) => a.adoptedAt != null && a.adoptedAt <= t).length

  const start = () => {
    if (t >= ep.t1) setT(ep.t0)
    setPlaying(true)
  }

  return (
    <div>
      <PageHeader
        title="Swarm map"
        subtitle="Replay the outbreak. An agent turns red when it first asserts the planted false fact; a link appears when TRACE first observes a transmission between two agents."
        right={<ProvenanceBadge kind="synthetic" />}
      />

      {/* Transport */}
      <Panel className="mb-3 !py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => (playing ? setPlaying(false) : start())}
            className="flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-void transition hover:bg-white"
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? 'Pause' : t >= ep.t1 ? 'Replay outbreak' : 'Play'}
          </button>
          <button
            type="button"
            title="Reset to start"
            onClick={() => {
              setPlaying(false)
              setT(ep.t0)
            }}
            className="rounded-lg border border-line p-1.5 text-muted hover:text-fg"
          >
            <RotateCcw size={14} />
          </button>
          <div className="flex overflow-hidden rounded-lg border border-line">
            {[4, 8, 16].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={cx(
                  'mono px-2 py-1 text-[11px]',
                  speed === s ? 'bg-panel-3 text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <input
            type="range"
            className="scrubber min-w-[200px] flex-1"
            min={ep.t0}
            max={ep.t1}
            step={50}
            value={t}
            onChange={(e) => {
              setPlaying(false)
              setT(Number(e.target.value))
            }}
            aria-label="Episode time"
          />
          <div className="mono tnum w-[78px] text-right text-[12px] text-fg">
            {relSeconds(new Date(t).toISOString(), ep.t0)}
          </div>
          <div className="mono flex items-center gap-3 text-[11.5px] text-muted">
            <span>
              <span className="text-[#ff7b7b]">{infectedNow}</span>/{ep.agents.length} adopted
            </span>
            <span>
              <span className="text-fg">{visible.length}</span>/{links.length} links
            </span>
            {conservative && hiddenByConservative > 0 && (
              <span className="text-[#4cc94c]">−{hiddenByConservative} weak hidden</span>
            )}
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel pad={false} className="relative overflow-hidden">
          <Graph
            ep={ep}
            links={links}
            t={t}
            conservative={conservative}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-lg border border-line bg-void/75 px-3 py-2 backdrop-blur">
            <LegendSwatch color={INFECTED} label="adopted the false fact" />
            <LegendSwatch color={SUSCEPTIBLE} label="not yet" />
            <LegendSwatch color={INFECTED} shape="ring" label="patient zero" />
            <div className="my-0.5 h-px bg-line" />
            {(['explicit', 'strong', 'weak', 'unresolved'] as EvidenceTier[]).map((tier) => (
              <LegendSwatch
                key={tier}
                shape="line"
                color={INK.fg2}
                dash={tierStroke(tier).dash}
                label={`${TIER_LABEL[tier]}${isWeakTier(tier) ? ' · hidden in conservative' : ''}`}
              />
            ))}
          </div>
          <div className="mono pointer-events-none absolute bottom-3 left-3 text-[10.5px] text-faint">
            scroll to zoom · drag to pan · click an agent · {ep.selfLoops} within-agent repeats not drawn
          </div>
        </Panel>

        <Inspector
          ep={ep}
          links={links}
          t={t}
          selected={selected}
          conservative={conservative}
          onSelect={setSelected}
        />
      </div>
    </div>
  )
}

function Graph({
  ep,
  links,
  t,
  conservative,
  selected,
  onSelect,
}: {
  ep: Episode
  links: Link2[]
  t: number
  conservative: boolean
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const gRef = useRef<SVGGElement>(null)
  const tip = useTooltip()
  const W = 900
  const H = 620

  // Deterministic layout: run the simulation to rest once.
  const pos = useMemo(() => {
    type N = d3.SimulationNodeDatum & { id: string; r: number }
    const nodes: N[] = ep.agents.map((a) => ({ id: a.slug, r: nodeR(a) }))
    const ls = links.map((l) => ({ source: l.src, target: l.dst, p: l.p }))
    const sim = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink<N, (typeof ls)[number]>(ls)
          .id((d) => d.id)
          .distance(120)
          .strength((d) => 0.25 + 0.5 * d.p),
      )
      .force('charge', d3.forceManyBody().strength(-620))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide<N>().radius((d) => d.r + 26))
      .stop()
    for (let i = 0; i < 400; i++) sim.tick()
    return new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))
  }, [ep, links])

  // Zoom + pan, fit to content initially.
  useEffect(() => {
    const svg = d3.select(svgRef.current!)
    const g = d3.select(gRef.current!)
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 4])
      .on('zoom', (ev) => g.attr('transform', ev.transform.toString()))
    svg.call(zoom)
    const xs = [...pos.values()].map((p) => p.x)
    const ys = [...pos.values()].map((p) => p.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const k = Math.min(1.6, 0.82 * Math.min(W / (x1 - x0 + 120), H / (y1 - y0 + 120)))
    svg.call(
      zoom.transform,
      d3.zoomIdentity.translate(W / 2 + 60, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2),
    )
    return () => {
      svg.on('.zoom', null)
    }
  }, [pos])

  const neighbours = useMemo(() => {
    if (!selected) return null
    const s = new Set<string>([selected])
    for (const l of links) {
      if (l.src === selected) s.add(l.dst)
      if (l.dst === selected) s.add(l.src)
    }
    return s
  }, [selected, links])

  return (
    <div className="relative h-[620px] w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onClick={() => onSelect(null)}
      >
        <defs>
          <radialGradient id="infGlow">
            <stop offset="0%" stopColor={INFECTED} stopOpacity="0.55" />
            <stop offset="100%" stopColor={INFECTED} stopOpacity="0" />
          </radialGradient>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" fill={INK.fg2} />
          </marker>
          <marker id="arrowHot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" fill={INFECTED} />
          </marker>
        </defs>
        <g ref={gRef}>
          {/* links */}
          {links.map((l) => {
            const a = pos.get(l.src)
            const b = pos.get(l.dst)
            if (!a || !b) return null
            const shown = l.t <= t && (!conservative || !isWeakTier(l.tier))
            const fresh = shown && t - l.t < 2500
            const st = tierStroke(l.tier)
            const dim = neighbours && !(neighbours.has(l.src) && neighbours.has(l.dst))
            const tr = nodeR(ep.agentById.get(l.dst))
            const d = arc(a, b, tr + 4)
            return (
              <g
                key={l.key}
                style={{ opacity: shown ? (dim ? 0.12 : 1) : 0, transition: 'opacity 380ms ease' }}
                onMouseMove={(e) =>
                  tip.show(
                    e,
                    <div>
                      <div className="font-medium">
                        {lab(ep, l.src)} → {lab(ep, l.dst)}
                      </div>
                      <div className="mono mt-0.5 text-[11px] text-muted">
                        {TIER_LABEL[l.tier]} · p={l.p.toFixed(2)} · {l.n} claim{l.n > 1 ? 's' : ''}
                      </div>
                      <div className="mono text-[11px] text-muted">
                        first seen {relSeconds(new Date(l.t).toISOString(), ep.t0)}
                      </div>
                    </div>,
                  )
                }
                onMouseLeave={tip.hide}
              >
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
                <path
                  d={d}
                  fill="none"
                  stroke={fresh ? INFECTED : INK.fg2}
                  strokeOpacity={fresh ? 0.95 : st.opacity * (0.45 + 0.55 * l.p)}
                  strokeWidth={st.width}
                  strokeDasharray={st.dash || undefined}
                  markerEnd={`url(#${fresh ? 'arrowHot' : 'arrow'})`}
                />
                {fresh && (
                  <path d={d} fill="none" stroke={INFECTED} strokeWidth={2.4} strokeDasharray="2 10" className="animate-flow" />
                )}
              </g>
            )
          })}

          {/* nodes */}
          {ep.agents.map((a) => {
            const p = pos.get(a.slug)
            if (!p) return null
            const inf = a.adoptedAt != null && a.adoptedAt <= t
            const r = nodeR(a)
            const isSel = selected === a.slug
            const dim = neighbours && !neighbours.has(a.slug)
            return (
              <g
                key={a.slug}
                transform={`translate(${p.x},${p.y})`}
                className="cursor-pointer"
                style={{ opacity: dim ? 0.3 : 1, transition: 'opacity 250ms' }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(isSel ? null : a.slug)
                }}
                onMouseMove={(e) =>
                  tip.show(
                    e,
                    <div>
                      <div className="font-medium">
                        {a.label} <span className="text-muted">· {ROLE_LABEL[a.role] ?? a.role}</span>
                      </div>
                      <div className="mono mt-0.5 text-[11px] text-muted">
                        {a.adoptedAt != null
                          ? `adopted ${relSeconds(new Date(a.adoptedAt).toISOString(), ep.t0)}`
                          : 'never adopted'}
                        {' · '}
                        {a.nClaimsInStrain} claims in strain
                      </div>
                      {a.isPatientZero && <div className="mt-1 text-[11px] text-[#ff8a8a]">Patient zero — origin of the strain</div>}
                    </div>,
                  )
                }
                onMouseLeave={tip.hide}
              >
                {inf && <circle r={r * 2.6} fill="url(#infGlow)" />}
                {a.isPatientZero && (
                  <circle r={r + 7} fill="none" stroke={INFECTED} strokeWidth={1.5} className="origin-center animate-pulse-ring" />
                )}
                {(a.role === 'coordinator' || a.role === 'orchestrator') && (
                  <circle r={r + 4} fill="none" stroke={inf ? INFECTED : SUSCEPTIBLE} strokeOpacity={0.6} strokeWidth={1} />
                )}
                <circle
                  r={r}
                  fill={inf ? INFECTED : '#14243b'}
                  stroke={inf ? '#ffb3b3' : SUSCEPTIBLE}
                  strokeWidth={inf ? 1.5 : 1.8}
                  style={{ transition: 'fill 300ms, stroke 300ms' }}
                />
                {isSel && <circle r={r + 9} fill="none" stroke={INK.fg} strokeWidth={1.5} strokeDasharray="3 3" />}
                <text y={r + 15} textAnchor="middle" className="fill-fg text-[11.5px] font-medium" style={{ paintOrder: 'stroke', stroke: '#0b0e14', strokeWidth: 4 }}>
                  {a.label}
                </text>
                <text y={r + 28} textAnchor="middle" className="mono fill-muted text-[9.5px]" style={{ paintOrder: 'stroke', stroke: '#0b0e14', strokeWidth: 3 }}>
                  {a.adoptedAt != null ? relSeconds(new Date(a.adoptedAt).toISOString(), ep.t0) : '—'}
                  {a.role !== 'worker' ? ` · ${ROLE_LABEL[a.role] ?? a.role}` : ''}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      {tip.node}
    </div>
  )
}

function Inspector({
  ep,
  links,
  t,
  selected,
  conservative,
  onSelect,
}: {
  ep: Episode
  links: Link2[]
  t: number
  selected: string | null
  conservative: boolean
  onSelect: (id: string | null) => void
}) {
  const navigate = useNavigate()
  const a = selected ? ep.agentById.get(selected) : null
  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelHeader eyebrow="Outbreak curve" title="Agents carrying the false fact" />
        <OutbreakCurve ep={ep} t={t} />
      </Panel>

      {a ? (
        <Panel>
          <PanelHeader
            eyebrow={ROLE_LABEL[a.role] ?? a.role}
            title={
              <span className="flex items-center gap-2">
                {a.label}
                {a.isPatientZero && (
                  <span className="mono rounded border border-[#ff5a5a]/50 px-1.5 text-[10px] text-[#ff8a8a]">
                    patient zero
                  </span>
                )}
              </span>
            }
            right={
              <button type="button" onClick={() => onSelect(null)} className="text-[11px] text-muted hover:text-fg">
                clear
              </button>
            }
          />
          <dl className="mono grid grid-cols-2 gap-y-1 text-[11.5px]">
            <dt className="text-muted">adopted</dt>
            <dd className="text-right text-fg">
              {a.adoptedAt != null ? relSeconds(new Date(a.adoptedAt).toISOString(), ep.t0) : 'never'}
            </dd>
            <dt className="text-muted">claims in strain</dt>
            <dd className="text-right text-fg">{a.nClaimsInStrain}</dd>
            <dt className="text-muted">activity</dt>
            <dd className="text-right text-fg">{a.activity}</dd>
          </dl>
          <LinkList title="Heard from" ep={ep} items={links.filter((l) => l.dst === a.slug)} side="src" t={t} conservative={conservative} onSelect={onSelect} />
          <LinkList title="Passed to" ep={ep} items={links.filter((l) => l.src === a.slug)} side="dst" t={t} conservative={conservative} onSelect={onSelect} />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => navigate(`/agents?id=${a.slug}`)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-line-2 bg-panel-2 px-2 py-1.5 text-[12px] hover:border-fg-2"
            >
              Say/Do <ArrowRight size={13} />
            </button>
            <Link
              to="/strain"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-line-2 bg-panel-2 px-2 py-1.5 text-[12px] hover:border-fg-2"
            >
              <GitBranch size={13} /> Strain tree
            </Link>
          </div>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader eyebrow="Inspector" title="Click an agent" />
          <p className="text-[12.5px] leading-relaxed text-muted">
            See who it heard the claim from, who it passed it to, and how sure TRACE is about each
            link. Toggle <span className="text-fg-2">Conservative</span> in the top bar to keep only
            explicit and strong evidence.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {ep.agents
              .filter((x) => x.role !== 'worker' || x.isPatientZero)
              .map((x) => (
                <button
                  key={x.slug}
                  type="button"
                  onClick={() => onSelect(x.slug)}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-left text-[12px] hover:border-line-2"
                >
                  <Crosshair size={12} className="text-muted" />
                  {x.label}
                  <span className="text-[10.5px] text-muted">{ROLE_LABEL[x.role] ?? x.role}</span>
                </button>
              ))}
          </div>
        </Panel>
      )}
    </div>
  )
}

function LinkList({
  title,
  ep,
  items,
  side,
  t,
  conservative,
  onSelect,
}: {
  title: string
  ep: Episode
  items: Link2[]
  side: 'src' | 'dst'
  t: number
  conservative: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div className="mt-3">
      <div className="mono mb-1 text-[10.5px] uppercase tracking-[0.12em] text-muted">
        {title} · {items.length}
      </div>
      {items.length === 0 && <div className="text-[12px] text-faint">none observed</div>}
      <ul className="space-y-1">
        {items.map((l) => {
          const other = side === 'src' ? l.src : l.dst
          const off = l.t > t || (conservative && isWeakTier(l.tier))
          return (
            <li key={l.key}>
              <button
                type="button"
                onClick={() => onSelect(other)}
                className={cx(
                  'grid w-full grid-cols-[80px_1fr_66px] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-panel-2',
                  off && 'opacity-40',
                )}
              >
                <span className="truncate text-fg">{lab(ep, other)}</span>
                <span className="relative h-1.5 rounded-full bg-line-2">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${l.p * 100}%` }} />
                </span>
                <span className="mono text-right text-[10.5px] text-muted">
                  {TIER_LABEL[l.tier].slice(0, 6)} {l.p.toFixed(2)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OutbreakCurve({ ep, t }: { ep: Episode; t: number }) {
  const W = 300
  const H = 110
  const pad = { l: 26, r: 8, t: 8, b: 20 }
  const times = ep.agents
    .map((a) => a.adoptedAt)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b)
  const x = d3.scaleLinear([ep.t0, ep.t1], [pad.l, W - pad.r])
  const y = d3.scaleLinear([0, ep.agents.length], [H - pad.b, pad.t])
  const pts: Array<[number, number]> = [[ep.t0, 0]]
  times.forEach((tm, i) => {
    pts.push([tm, i])
    pts.push([tm, i + 1])
  })
  pts.push([ep.t1, times.length])
  const line = d3.line<[number, number]>((d) => x(d[0]), (d) => y(d[1]))
  const area = d3.area<[number, number]>((d) => x(d[0]), y(0), (d) => y(d[1]))
  const now = times.filter((tm) => tm <= t).length
  const ticks = [ep.t0, ep.t0 + (ep.t1 - ep.t0) / 2, ep.t1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative agents that adopted the false fact over time">
      {[0, ep.agents.length / 2, ep.agents.length].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={INK.line} />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" className="mono fill-faint text-[9px]">
            {v}
          </text>
        </g>
      ))}
      <path d={area(pts) ?? ''} fill={INFECTED} fillOpacity={0.12} />
      <path d={line(pts) ?? ''} fill="none" stroke={INFECTED} strokeWidth={2} strokeLinejoin="round" />
      <line x1={x(t)} x2={x(t)} y1={pad.t} y2={H - pad.b} stroke={INK.fg} strokeWidth={1} strokeDasharray="2 3" />
      <circle cx={x(t)} cy={y(now)} r={3.5} fill={INFECTED} stroke={INK.panel} strokeWidth={2} />
      {ticks.map((tk) => (
        <text key={tk} x={x(tk)} y={H - 6} textAnchor="middle" className="mono fill-faint text-[9px]">
          {relSeconds(new Date(tk).toISOString(), ep.t0)}
        </text>
      ))}
    </svg>
  )
}

function nodeR(a: AgentState | undefined): number {
  if (!a) return 10
  return 9 + Math.min(8, Math.sqrt(a.activity) * 2.2) + (a.role === 'coordinator' ? 3 : 0)
}

function lab(ep: Episode, slug: string): string {
  return ep.agentById.get(slug)?.label ?? slug
}

/** Gentle arc from a to b, stopping `endPad` short of the target node. */
function arc(a: { x: number; y: number }, b: { x: number; y: number }, endPad: number): string {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ex = b.x - (dx / len) * endPad
  const ey = b.y - (dy / len) * endPad
  const mx = (a.x + ex) / 2 - (dy / len) * len * 0.12
  const my = (a.y + ey) / 2 + (dx / len) * len * 0.12
  return `M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`
}
