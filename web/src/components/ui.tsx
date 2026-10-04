import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  FlaskConical,
  Hourglass,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { VERDICT_COLOR, VERDICT_LABEL } from '../lib/colors'
import type { Provenance, Verdict } from '../types'

export function cx(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ')
}

export function Panel({
  children,
  className,
  pad = true,
}: {
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return <section className={cx('panel', pad && 'p-4', className)}>{children}</section>
}

export function PanelHeader({
  eyebrow,
  title,
  right,
  className,
}: {
  eyebrow?: ReactNode
  title?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('mb-3 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
            {eyebrow}
          </div>
        )}
        {title && <div className="mt-0.5 text-[15px] font-semibold text-fg">{title}</div>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

const PROV: Record<Provenance, { label: string; icon: LucideIcon; cls: string; tip: string }> = {
  measured: {
    label: 'Measured',
    icon: CheckCircle2,
    cls: 'border-good/40 text-[#4cc94c] bg-good/10',
    tip: 'Computed by the pipeline against known ground truth.',
  },
  synthetic: {
    label: 'Synthetic',
    icon: FlaskConical,
    cls: 'border-accent/35 text-accent bg-accent/10',
    tip: 'Computed on synthetic FORGE data (rule-based agents / synthesized activations).',
  },
  mock: {
    label: 'Illustrative mock',
    icon: AlertTriangle,
    cls: 'border-warn/45 text-warn bg-warn/10',
    tip: 'Hand-placed for the demo, not computed. Do not cite.',
  },
  pending: {
    label: 'Pending',
    icon: Hourglass,
    cls: 'border-line-2 text-muted bg-panel-2',
    tip: 'Not run yet (needs HF dataset / A100 / real stream).',
  },
}

export function ProvenanceBadge({ kind, className }: { kind: Provenance; className?: string }) {
  const p = PROV[kind]
  const Icon = p.icon
  return (
    <span
      title={p.tip}
      className={cx(
        'mono inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        p.cls,
        className,
      )}
    >
      <Icon size={11} strokeWidth={2.2} />
      {p.label}
    </span>
  )
}

const VERDICT_ICON: Record<Verdict, LucideIcon> = {
  verified: CheckCircle2,
  partially_verified: CircleDashed,
  contradicted: XCircle,
  no_evidence_found: MinusCircle,
  unverifiable_in_logs: CircleHelp,
}

export function VerdictChip({ verdict, size = 'sm' }: { verdict: Verdict; size?: 'sm' | 'xs' }) {
  const Icon = VERDICT_ICON[verdict]
  const color = VERDICT_COLOR[verdict]
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-md border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-1 py-px text-[10px]',
      )}
      style={{ borderColor: `${color}55`, background: `${color}14`, color: '#dfe6ef' }}
    >
      <Icon size={size === 'sm' ? 12 : 11} color={color} strokeWidth={2.2} />
      {VERDICT_LABEL[verdict]}
    </span>
  )
}

export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: LucideIcon
  accent?: string
}) {
  return (
    <div className="panel relative overflow-hidden px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
        {Icon && <Icon size={13} strokeWidth={2} color={accent} />}
        {label}
      </div>
      <div className="mt-1 text-[26px] font-semibold leading-none tracking-tight text-fg">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[11.5px] text-muted">{sub}</div>}
    </div>
  )
}

/**
 * Bullet comparison: ours (dot + CI whisker) vs baseline (hollow tick) on a shared domain.
 * Identity is never color-alone: both markers carry text labels.
 */
export function CompareBar({
  value,
  lo,
  hi,
  baseline,
  domain = [0, 1],
  higherIsBetter = true,
  height = 28,
  showLabels = true,
}: {
  value: number
  lo?: number | null
  hi?: number | null
  baseline?: number | null
  domain?: [number, number]
  higherIsBetter?: boolean
  height?: number
  showLabels?: boolean
}) {
  const [d0, d1] = domain
  const x = (v: number) => `${((Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0 || 1)) * 100}%`
  const better =
    baseline == null ? null : higherIsBetter ? value > baseline : value < baseline
  const color = better == null ? '#6aa8ff' : better ? '#6aa8ff' : '#ec835a'
  return (
    <div className="relative w-full" style={{ height }}>
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-2" />
      {lo != null && hi != null && (
        <div
          className="absolute top-1/2 h-[6px] -translate-y-1/2 rounded-full"
          style={{
            left: x(lo),
            width: `calc(${x(hi)} - ${x(lo)})`,
            background: `${color}40`,
            minWidth: 2,
          }}
        />
      )}
      {baseline != null && (
        <div
          className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-fg-2"
          style={{ left: x(baseline) }}
          title={`baseline ${baseline.toFixed(3)}`}
        />
      )}
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel"
        style={{ left: x(value), background: color }}
        title={`ours ${value.toFixed(3)}`}
      />
      {showLabels && (
        <div className="mono pointer-events-none absolute -bottom-0.5 inset-x-0 flex justify-between text-[9.5px] text-faint">
          <span>{d0}</span>
          <span>{d1}</span>
        </div>
      )}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mono rounded border border-line-2 bg-panel-2 px-1.5 py-px text-[10.5px] text-muted">
      {children}
    </kbd>
  )
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        {label}…
      </div>
    </div>
  )
}

export function ErrorBlock({ error }: { error: string }) {
  return (
    <div className="panel flex min-h-[200px] flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="text-serious" size={20} />
      <div className="text-sm text-fg">Couldn’t load this view’s data</div>
      <div className="mono max-w-lg text-[11px] text-muted">{error}</div>
      <div className="text-[12px] text-muted">
        Regenerate exports with <span className="mono text-fg-2">bash scripts/build_all.sh</span>
      </div>
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-2 px-3 py-4 text-center text-[12.5px] text-muted">
      {children}
    </div>
  )
}

/** Floating tooltip that follows the pointer; rendered in a portal above everything. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null)
  const show = (e: { clientX: number; clientY: number }, content: ReactNode) =>
    setTip({ x: e.clientX, y: e.clientY, content })
  const hide = () => setTip(null)
  const node = tip ? <TooltipBox {...tip} /> : null
  return { show, hide, node }
}

function TooltipBox({ x, y, content }: { x: number; y: number; content: ReactNode }) {
  const [vw, setVw] = useState(window.innerWidth)
  useEffect(() => {
    const r = () => setVw(window.innerWidth)
    window.addEventListener('resize', r)
    return () => window.removeEventListener('resize', r)
  }, [])
  const flip = x > vw - 300
  return createPortal(
    <div
      className="pointer-events-none fixed z-[100] max-w-[280px] rounded-lg border border-line-2 bg-[#0d121a]/95 px-3 py-2 text-[12px] leading-snug text-fg shadow-2xl backdrop-blur"
      style={{ left: flip ? x - 14 : x + 14, top: y + 14, transform: flip ? 'translateX(-100%)' : 'none' }}
    >
      {content}
    </div>,
    document.body,
  )
}

export function LegendSwatch({
  color,
  label,
  shape = 'dot',
  dash,
}: {
  color?: string
  label: ReactNode
  shape?: 'dot' | 'line' | 'ring'
  dash?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-fg-2">
      {shape === 'dot' && (
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      )}
      {shape === 'ring' && (
        <span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: color }} />
      )}
      {shape === 'line' && (
        <svg width="22" height="8" aria-hidden>
          <line
            x1="1"
            x2="21"
            y1="4"
            y2="4"
            stroke={color ?? '#c9d1d9'}
            strokeWidth={2}
            strokeDasharray={dash}
            strokeLinecap="round"
          />
        </svg>
      )}
      {label}
    </span>
  )
}

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-3xl text-[13px] text-muted">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}
