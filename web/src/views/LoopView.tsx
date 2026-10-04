import {
  ArrowRight,
  Bot,
  Brain,
  Database,
  Eye,
  FileSearch,
  FlaskConical,
  GitMerge,
  MessageSquareQuote,
  Network,
  Percent,
  Shield,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Murmuration } from '../components/Murmuration'
import {
  CompareBar,
  ErrorBlock,
  LoadingBlock,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  StatTile,
} from '../components/ui'
import { fmtNum, humanMetric } from '../lib/format'
import { useEpisode } from '../lib/episode'
import { useJson } from '../lib/loadData'
import type { LoopKpis, Provenance, WardDisruption, WingKpi } from '../types'

type WingMeta = {
  icon: LucideIcon
  role: string
  to: string
  prov: Provenance
  domain?: [number, number]
  higherIsBetter?: boolean
  caption: (w: WingKpi) => string
}

const WING_META: Record<string, WingMeta> = {
  trace: {
    icon: FileSearch,
    role: 'Investigate',
    to: '/strain',
    prov: 'synthetic',
    caption: (w) =>
      `recovers who-infected-whom; ${fmtNum((w.value ?? 0) / (w.baseline_value || 1), 0)}× the timestamp baseline`,
  },
  scout: {
    icon: Eye,
    role: 'Detect',
    to: '/evidence',
    prov: 'measured',
    caption: () => 'M∧C + e-value on collusion.wiki revisions (measured)',
  },
  ward: {
    icon: Shield,
    role: 'Defend',
    to: '/evidence',
    prov: 'synthetic',
    higherIsBetter: false,
    caption: (w) =>
      `append-only board: ${fmtNum((w.baseline_value ?? 0) / (w.value || 1), 1)}× fewer wrong answers`,
  },
  whitebox: {
    icon: Brain,
    role: 'Inside the model',
    to: '/brain',
    prov: 'synthetic',
    caption: () => 'probe on synthesized activations — real tensors next',
  },
  multiagent: {
    icon: Users,
    role: 'Structure',
    to: '/org',
    prov: 'synthetic',
    domain: [1, 12],
    higherIsBetter: false,
    caption: () => 'true orchestrator ranked #1 by centrality',
  },
}

export function LoopView() {
  const kpis = useJson<LoopKpis>('loop_kpis.json')
  const ep = useEpisode()
  const ward = useJson<WardDisruption>('ward_disruption.json')

  if (kpis.status === 'error') return <ErrorBlock error={kpis.error} />
  if (kpis.status === 'loading') return <LoadingBlock label="Loading the loop" />
  const g = kpis.data.global
  const bs = ward.status === 'ready' ? ward.data.board_storage : undefined
  // WARD: show the measured wrong-answer rate (append-only vs whole-page), not a delta-vs-rate.
  const wings = kpis.data.wings
    .filter((w) => WING_META[w.id])
    .map((w) =>
      w.id === 'ward' && bs
        ? {
            ...w,
            metric: 'wrong_answer_rate_append_only',
            value: bs.append_only_wrong_rate,
            ci_low: bs.append_only_ci[1],
            ci_high: bs.append_only_ci[2],
            baseline_name: 'whole-page',
            baseline_value: bs.whole_page_wrong_rate,
          }
        : w,
    )
  const crossEdges = ep.status === 'ready' ? ep.data.edges.length : null
  const adopted =
    ep.status === 'ready'
      ? `${ep.data.agents.filter((a) => a.adoptedAt != null).length}/${ep.data.agents.length}`
      : '—'

  return (
    <div className="space-y-5">
      {/* Hero */}
      <section className="panel relative h-[300px] overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-60" />
        <div className="absolute inset-0">
          <Murmuration />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-sky via-sky/85 to-transparent" />
        <div className="relative flex h-full max-w-[640px] flex-col justify-center px-7">
          <div className="mono mb-3 flex items-center gap-2 text-[10.5px] uppercase tracking-[0.18em] text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-glow" />
            Real investigation · AI Village + collusion.wiki
          </div>
          <h1 className="text-[30px] font-semibold leading-[1.12] tracking-tight text-fg">
            Investigate a real swarm window —
            <span className="text-[#ff7b7b]"> measured</span> claims, strains, and SCOUT alerts.
          </h1>
          <p className="mt-3 max-w-[540px] text-[13.5px] leading-relaxed text-fg-2">
            Dashboard data is exported from the Hugging Face AI Village transcript and a measured
            SCOUT replay on the public collusion.wiki revision stream. No illustrative mock timeline.
          </p>
          <div className="pointer-events-auto mt-5 flex flex-wrap gap-2">
            <Link
              to="/swarm"
              className="inline-flex items-center gap-1.5 rounded-lg bg-fg px-3.5 py-2 text-[13px] font-medium text-void transition hover:bg-white"
            >
              Open Swarm map <ArrowRight size={14} />
            </Link>
            <Link
              to="/evidence"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-2 bg-panel/70 px-3.5 py-2 text-[13px] text-fg backdrop-blur transition hover:border-fg-2"
            >
              Evidence · measured SCOUT
            </Link>
          </div>
        </div>
      </section>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          icon={Bot}
          accent="#6aa8ff"
          label="Agents"
          value={g.agents}
          sub={kpis.data.provenance === 'measured' ? 'Village window actors' : '1 coordinator · 1 relay'}
        />
        <StatTile
          icon={Database}
          accent="#6aa8ff"
          label="SEF events"
          value={g.events}
          sub={kpis.data.provenance === 'measured' ? 'real transcript window' : 'in an 80-second episode'}
        />
        <StatTile
          icon={MessageSquareQuote}
          accent="#6aa8ff"
          label="Claims extracted"
          value={g.claims}
          sub={`${g.strains} strains`}
        />
        <StatTile
          icon={Network}
          accent="#6aa8ff"
          label="Agent→agent links"
          value={crossEdges ?? '—'}
          sub="evidence-tiered"
        />
        <StatTile
          icon={Percent}
          accent="#0ca30c"
          label="Self-reports verified"
          value={`${g.self_report_verified_pct.toFixed(0)}%`}
          sub="against the action log"
        />
        <StatTile
          icon={GitMerge}
          accent="#ff5a5a"
          label={kpis.data.provenance === 'measured' ? 'Episode' : 'Planted false fact'}
          value={kpis.data.provenance === 'measured' ? (kpis.data.episode_id ?? 'village') : adopted}
          sub={kpis.data.provenance === 'measured' ? 'measured export' : 'agents adopted it'}
        />
      </div>

      {/* Closed loop */}
      <Panel>
        <PanelHeader
          eyebrow="The closed loop"
          title="Grow a labelled swarm → normalise it → score every wing against ground truth"
          right={<ProvenanceBadge kind="synthetic" />}
        />
        <LoopDiagram wings={wings} />
      </Panel>

      {/* Honest scope */}
      <Panel>
        <PanelHeader eyebrow="Honest scope" title="What is measured today, and what is not yet" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <ScopeCard kind="measured" title="Measured on real streams">
            Swarm map / strains / agents from an AI Village window. SCOUT could-have-warned from the public
            collusion.wiki revision dump (`provenance: measured`).
          </ScopeCard>
          <ScopeCard kind="synthetic" title="FORGE wind-tunnel scores">
            TRACE / WARD / MULTIAGENT headline KPIs still use labelled FORGE episodes (rule-based agents) so we
            can report baselines with known ground truth.
          </ScopeCard>
          <ScopeCard kind="pending" title="Still open">
            Hand-labeled Village say/do, MessageBoardAuditBench uplift, LLM FORGE agents, real activation probes.
          </ScopeCard>
        </div>
      </Panel>
    </div>
  )
}

function ScopeCard({ kind, title, children }: { kind: Provenance; title: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-line bg-panel-2/60 p-3.5 ${kind === 'mock' ? 'hatch' : ''}`}>
      <ProvenanceBadge kind={kind} />
      <div className="mt-2 text-[13px] font-medium text-fg">{title}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{children}</p>
    </div>
  )
}

/** HTML layout + measured SVG connectors with animated flow. */
function LoopDiagram({ wings }: { wings: WingKpi[] }) {
  const root = useRef<HTMLDivElement>(null)
  const forge = useRef<HTMLDivElement>(null)
  const spine = useRef<HTMLDivElement>(null)
  const wingRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const [paths, setPaths] = useState<{ main: string[]; feed: string; w: number; h: number }>({
    main: [],
    feed: '',
    w: 0,
    h: 0,
  })

  useLayoutEffect(() => {
    const compute = () => {
      const r = root.current?.getBoundingClientRect()
      const f = forge.current?.getBoundingClientRect()
      const s = spine.current?.getBoundingClientRect()
      if (!r || !f || !s) return
      const rel = (x: number, y: number) => [x - r.left, y - r.top]
      const [fx, fy] = rel(f.right, f.top + f.height / 2)
      const [sx0, sy] = rel(s.left, s.top + s.height / 2)
      const [sx1] = rel(s.right, 0)
      const main = [`M${fx},${fy} L${sx0},${sy}`]
      for (const el of wingRefs.current) {
        if (!el) continue
        const b = el.getBoundingClientRect()
        const [wx, wy] = rel(b.left, b.top + b.height / 2)
        const mx = (sx1 + wx) / 2
        main.push(`M${sx1},${sy} C${mx},${sy} ${mx},${wy} ${wx},${wy}`)
      }
      const [fbx, fby] = rel(f.left + f.width / 2, f.bottom)
      const last = wingRefs.current.at(-1)?.getBoundingClientRect()
      const feed = last
        ? (() => {
            const [lx, ly] = rel(last.left + 40, last.bottom)
            const yb = Math.max(ly, fby) + 26
            return `M${lx},${ly} C${lx},${yb} ${fbx},${yb} ${fbx},${fby}`
          })()
        : ''
      setPaths({ main, feed, w: r.width, h: r.height })
    }
    compute()
    const ro = new ResizeObserver(compute)
    if (root.current) ro.observe(root.current)
    return () => ro.disconnect()
  }, [wings.length])

  return (
    <div ref={root} className="relative pb-10">
      <svg className="pointer-events-none absolute inset-0" width={paths.w} height={paths.h} aria-hidden>
        <defs>
          <linearGradient id="flowGrad" x1="0" x2="1">
            <stop offset="0%" stopColor="#6aa8ff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#6aa8ff" stopOpacity="0.8" />
          </linearGradient>
        </defs>
        {paths.main.map((d, i) => (
          <g key={i}>
            <path d={d} fill="none" stroke="#2f3a4a" strokeWidth={1.5} />
            <path d={d} fill="none" stroke="url(#flowGrad)" strokeWidth={1.6} strokeDasharray="3 9" className="animate-flow" />
          </g>
        ))}
        {paths.feed && (
          <g>
            <path d={paths.feed} fill="none" stroke="#ff5a5a" strokeOpacity={0.45} strokeWidth={1.4} strokeDasharray="4 6" className="animate-flow" />
          </g>
        )}
      </svg>
      {paths.feed && (
        <div className="mono absolute bottom-0 left-[18%] text-[10.5px] text-[#ff8a8a]">
          ↺ every wing is scored against FORGE ground truth
        </div>
      )}

      <div className="relative grid items-center gap-6 lg:grid-cols-[200px_200px_1fr]">
        <div ref={forge} className="rounded-xl border border-[#ff5a5a]/40 bg-[#ff5a5a]/[0.06] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <FlaskConical size={15} className="text-[#ff7b7b]" /> FORGE
          </div>
          <div className="mt-1 text-[12px] leading-snug text-muted">
            Sealed sandbox grows a colluding swarm. Logs who-read-what before every claim.
          </div>
          <div className="mono mt-2 text-[10.5px] text-fg-2">ground truth: 20 transmission edges</div>
        </div>
        <div ref={spine} className="rounded-xl border border-accent/35 bg-accent/[0.06] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Database size={15} className="text-accent" /> SPINE
          </div>
          <div className="mt-1 text-[12px] leading-snug text-muted">
            Swarm Event Format + evidence engine. Confidence never upgrades on aggregation.
          </div>
          <div className="mono mt-2 text-[10.5px] text-fg-2">frozen contracts · 7/7 stress cases</div>
        </div>
        <div className="grid gap-2.5">
          {wings.map((w, i) => {
            const meta = WING_META[w.id]
            const Icon = meta.icon
            return (
              <Link
                key={w.id}
                to={meta.to}
                ref={(el) => {
                  wingRefs.current[i] = el
                }}
                className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 rounded-xl border border-line bg-panel-2/70 px-4 py-2.5 transition hover:border-line-2 hover:bg-panel-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className="text-accent" />
                    <span className="text-[13px] font-semibold">{w.label}</span>
                    <span className="text-[11.5px] text-muted">{meta.role}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-muted">{meta.caption(w)}</div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11px] text-muted">{humanMetric(w.metric)}</span>
                    <span className="mono tnum text-[13px] font-semibold text-fg">
                      {fmtNum(w.value, w.unit === 'rank@1' ? 0 : 2)}
                      {w.ci_low != null && w.ci_high != null && w.ci_low !== w.ci_high && (
                        <span className="ml-1 text-[10.5px] font-normal text-muted">
                          [{fmtNum(w.ci_low)}, {fmtNum(w.ci_high)}]
                        </span>
                      )}
                    </span>
                  </div>
                  <CompareBar
                    value={w.value}
                    lo={w.ci_low}
                    hi={w.ci_high}
                    baseline={w.baseline_value}
                    domain={meta.domain ?? [0, 1]}
                    higherIsBetter={meta.higherIsBetter ?? true}
                    height={20}
                    showLabels={false}
                  />
                  <div className="mono flex justify-between text-[10px] text-faint">
                    <span>● ours</span>
                    <span>
                      | {w.baseline_name ?? 'baseline'} {w.baseline_value != null ? fmtNum(w.baseline_value) : ''}
                    </span>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
