import * as d3 from 'd3'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Landmark, Tick } from '../lib/api'

type Props = {
  ticks: Tick[]
  alpha: number
  landmarks?: Landmark[]
  height?: number
  selected?: string | null
  onSelect?: (t: Tick) => void
  /** Optional overlay series (e.g. labelled spam / wave share) on the C axis. */
  showLabel?: boolean
}

const LM_COLOR: Record<string, string> = { ground_truth: '#ff5a5a', intervention: '#4cc94c', human: '#fab219', context: '#7d8899' }

/** Two stacked panels sharing a time axis: C_t (coordinated share) and log10 S_t (e-detector). */
export function LiveChart({ ticks, alpha, landmarks = [], height = 300, selected, onSelect, showLabel = true }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  const [hover, setHover] = useState<Tick | null>(null)
  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver((e) => setW(Math.max(320, e[0].contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const m = { l: 44, r: 12, t: 10, b: 22 }
  const gap = 18
  const h1 = (height - m.t - m.b - gap) * 0.55
  const h2 = height - m.t - m.b - gap - h1
  const thr = Math.log10(1 / alpha)

  const g = useMemo(() => {
    const ts = ticks.map((d) => new Date(d.t))
    const x = d3
      .scaleTime()
      .domain(ts.length ? (d3.extent(ts) as [Date, Date]) : [new Date(), new Date()])
      .range([m.l, w - m.r])
    const cMax = Math.max(0.05, d3.max(ticks, (d) => Math.max(d.C ?? 0, showLabel ? d.label_rate ?? 0 : 0)) ?? 0.05)
    const yC = d3.scaleLinear().domain([0, cMax]).nice().range([m.t + h1, m.t])
    const sMax = Math.max(thr + 0.5, d3.max(ticks, (d) => d.log10_S ?? 0) ?? 0)
    const yS = d3
      .scaleLinear()
      .domain([Math.min(-0.5, d3.min(ticks, (d) => d.log10_S ?? 0) ?? 0), sMax])
      .nice()
      .range([m.t + h1 + gap + h2, m.t + h1 + gap])
    const areaC = d3
      .area<Tick>()
      .x((d) => x(new Date(d.t)))
      .y0(yC(0))
      .y1((d) => yC(d.C ?? 0))
      .curve(d3.curveStepAfter)(ticks)
    const lineL = d3
      .line<Tick>()
      .defined((d) => d.label_rate != null)
      .x((d) => x(new Date(d.t)))
      .y((d) => yC(d.label_rate ?? 0))
      .curve(d3.curveMonotoneX)(ticks)
    const lineS = d3
      .line<Tick>()
      .x((d) => x(new Date(d.t)))
      .y((d) => yS(d.log10_S ?? 0))
      .curve(d3.curveMonotoneX)(ticks)
    return { x, yC, yS, areaC, lineL, lineS }
  }, [ticks, w, h1, h2, thr, showLabel, m.l, m.r, m.t])

  const bisect = useMemo(() => d3.bisector((d: Tick) => new Date(d.t)).center, [])
  const pick = (clientX: number) => {
    if (!wrap.current || !ticks.length) return null
    const r = wrap.current.getBoundingClientRect()
    const i = bisect(ticks, g.x.invert(clientX - r.left))
    return ticks[Math.max(0, Math.min(ticks.length - 1, i))]
  }
  const hasLabel = showLabel && ticks.some((d) => d.label_rate != null)
  const last = ticks[ticks.length - 1]
  const xTicks = g.x.ticks(Math.max(3, Math.floor(w / 120)))
  const fmt = g.x.tickFormat()

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        width={w}
        height={height}
        className="block"
        onMouseMove={(e) => setHover(pick(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const t = pick(e.clientX)
          if (t && onSelect) onSelect(t)
        }}
      >
        <defs>
          <linearGradient id="cfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6aa8ff" stopOpacity={0.55} />
            <stop offset="100%" stopColor="#6aa8ff" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        {xTicks.map((t) => (
          <g key={+t}>
            <line x1={g.x(t)} x2={g.x(t)} y1={m.t} y2={height - m.b} stroke="#1c2330" />
            <text x={g.x(t)} y={height - 6} textAnchor="middle" className="mono" fontSize={10} fill="#4c5666">
              {fmt(t)}
            </text>
          </g>
        ))}
        {g.yC.ticks(3).map((v) => (
          <text key={`c${v}`} x={m.l - 6} y={g.yC(v) + 3} textAnchor="end" fontSize={10} className="mono" fill="#4c5666">
            {v.toFixed(2)}
          </text>
        ))}
        <text x={m.l + 4} y={m.t + 10} fontSize={10.5} fill="#7d8899" className="mono">
          C · coordinated share
        </text>
        {g.areaC && <path d={g.areaC} fill="url(#cfill)" stroke="#6aa8ff" strokeWidth={1.2} />}
        {hasLabel && g.lineL && <path d={g.lineL} fill="none" stroke="#fab219" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.85} />}

        <text x={m.l + 4} y={m.t + h1 + gap + 10} fontSize={10.5} fill="#7d8899" className="mono">
          log₁₀ S · e-detector (alarm ≥ {thr.toFixed(1)})
        </text>
        {g.yS.ticks(3).map((v) => (
          <text key={`s${v}`} x={m.l - 6} y={g.yS(v) + 3} textAnchor="end" fontSize={10} className="mono" fill="#4c5666">
            {v}
          </text>
        ))}
        <line x1={m.l} x2={w - m.r} y1={g.yS(thr)} y2={g.yS(thr)} stroke="#d03b3b" strokeDasharray="4 4" opacity={0.7} />
        {g.lineS && <path d={g.lineS} fill="none" stroke="#e8edf4" strokeWidth={1.3} />}

        {landmarks.map((lm) => {
          const xx = g.x(new Date(lm.t))
          if (!ticks.length || xx < m.l || xx > w - m.r) return null
          const c = LM_COLOR[lm.kind] ?? '#7d8899'
          return (
            <g key={lm.t + lm.label}>
              <line x1={xx} x2={xx} y1={m.t} y2={height - m.b} stroke={c} strokeDasharray="2 3" opacity={0.8} />
              <text x={xx + 4} y={m.t + 22} fontSize={10} fill={c} className="mono">
                {lm.label}
              </text>
            </g>
          )
        })}

        {ticks
          .filter((d) => d.alarm)
          .map((d) => (
            <g key={`a${d.t}`}>
              <line x1={g.x(new Date(d.t))} x2={g.x(new Date(d.t))} y1={m.t} y2={height - m.b} stroke="#ff5a5a" opacity={0.35} />
              <circle cx={g.x(new Date(d.t))} cy={g.yS(d.log10_S ?? thr)} r={4.5} fill="#ff5a5a" className="pulse-dot" />
            </g>
          ))}

        {selected && (
          <line x1={g.x(new Date(selected))} x2={g.x(new Date(selected))} y1={m.t} y2={height - m.b} stroke="#6aa8ff" strokeWidth={2} />
        )}
        {hover && <line x1={g.x(new Date(hover.t))} x2={g.x(new Date(hover.t))} y1={m.t} y2={height - m.b} stroke="#b4bfcd" opacity={0.5} />}
        {last && <circle cx={g.x(new Date(last.t))} cy={g.yC(last.C ?? 0)} r={3.5} fill="#6aa8ff" className="pulse-dot" />}
      </svg>
      {hover && (
        <div
          className="mono pointer-events-none absolute top-2 z-10 rounded-md border border-line-2 bg-[#0d121a]/95 px-2.5 py-1.5 text-[11px] leading-relaxed text-fg-2 shadow-xl"
          style={{ left: Math.min(g.x(new Date(hover.t)) + 10, w - 210) }}
        >
          <div className="text-fg">{hover.t.replace('T', ' ').replace('Z', '')}</div>
          <div>
            {hover.n.toLocaleString()} events · {hover.actors.toLocaleString()} actors
          </div>
          <div>
            C {(hover.C ?? 0).toFixed(3)} · M {(hover.M ?? 0).toFixed(1)} · log S {(hover.log10_S ?? 0).toFixed(2)}
          </div>
          {hover.label_rate != null && <div className="text-warn">label share {hover.label_rate.toFixed(3)}</div>}
          {hover.alarm && <div className="text-red-glow">ALARM — click to explain</div>}
        </div>
      )}
    </div>
  )
}
