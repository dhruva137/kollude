import { Pause, Play, Radio, RotateCcw, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyNote, Panel, PanelHeader, StatTile, cx } from '../components/ui'
import { api, useApiHealth, type RunResult, type SpreadRow, type Tick } from '../lib/api'

type TapeEvent = {
  t: string
  actor: string
  channel: string | null
  tid: string | null
  sandbox: string
  text: string
  coordinated: boolean
}

type SandboxMeta = {
  id: string
  label: string
  kind: string
  n_events: number
  n_actors: number
}

type ReplayTape = {
  events: TapeEvent[]
  sandboxes: SandboxMeta[]
  t0: string | null
  t1: string | null
  n_total: number
  n_actors: number
  stride: number
  source: string
}

/** Laptop-safe sources. Real corpora only through windows / max_rows. */
const SOURCES: Array<{
  id: string
  label: string
  note: string
  body?: Record<string, unknown>
}> = [
  { id: 'synthetic', label: 'synthetic', note: 'known onset · no download' },
  { id: 'forge', label: 'forge', note: 'bundled episode' },
  { id: 'moltbook', label: 'moltbook week', note: '2026-02-03…09 only', body: { start: '2026-02-03', end: '2026-02-09' } },
  { id: 'wiki', label: 'wiki', note: 'collusion.wiki · if fetched' },
  { id: 'village', label: 'village', note: '2 weeks · if fetched', body: { start: '2025-10-02', end: '2025-10-15' } },
]

const SPEEDS = [
  { id: 1, label: '1×' },
  { id: 4, label: '4×' },
  { id: 16, label: '16×' },
  { id: 64, label: '64×' },
]

type Bird = {
  x: number
  y: number
  vx: number
  vy: number
  hot: boolean
  tid: string | null
  pulse: number
  label: string
}

function shortActor(a: string) {
  if (a.length <= 14) return a
  return a.slice(0, 6) + '…' + a.slice(-4)
}

function hashHue(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return 200 + (h % 80)
}

/** Agents move from the event tape. Shared templates pull them together and draw edges. */
function AgentArena({
  events,
  focus,
  title,
  subtitle,
  large,
}: {
  events: TapeEvent[]
  focus: string
  title: string
  subtitle: string
  large?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const birds = useRef<Map<string, Bird>>(new Map())
  const edges = useRef<Array<{ a: string; b: string; tid: string; age: number }>>([])
  const latest = useRef(events)
  const lastLen = useRef(0)
  latest.current = events

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let frame = 0
    birds.current.clear()
    edges.current = []
    lastLen.current = 0

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const draw = () => {
      frame++
      const r = canvas.getBoundingClientRect()
      const w = r.width
      const h = r.height
      ctx.clearRect(0, 0, w, h)

      // soft field
      const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 8, w * 0.5, h * 0.42, Math.max(w, h) * 0.55)
      g.addColorStop(0, 'rgba(57,135,229,0.06)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      const slice = latest.current
      // ingest new events since last frame batch
      if (slice.length > lastLen.current) {
        const fresh = slice.slice(lastLen.current)
        lastLen.current = slice.length
        for (const ev of fresh) {
          if (focus !== 'world' && ev.sandbox !== focus) continue
          let b = birds.current.get(ev.actor)
          if (!b) {
            b = {
              x: 20 + Math.random() * (w - 40),
              y: 20 + Math.random() * (h - 40),
              vx: (Math.random() - 0.5) * 0.8,
              vy: (Math.random() - 0.5) * 0.6,
              hot: false,
              tid: null,
              pulse: 0,
              label: shortActor(ev.actor),
            }
            birds.current.set(ev.actor, b)
          }
          b.hot = ev.coordinated
          b.tid = ev.tid
          b.pulse = 18
          if (ev.coordinated && ev.tid) {
            // link to up to 3 others already on this template
            let linked = 0
            for (const [other, ob] of birds.current) {
              if (other === ev.actor || ob.tid !== ev.tid) continue
              edges.current.push({ a: ev.actor, b: other, tid: ev.tid, age: 40 })
              // yank toward peer
              b.vx += (ob.x - b.x) * 0.04
              b.vy += (ob.y - b.y) * 0.04
              ob.vx += (b.x - ob.x) * 0.02
              ob.vy += (b.y - ob.y) * 0.02
              linked++
              if (linked >= 3) break
            }
            // pull coordinated actors toward a shared rendezvous in this room
            const cx = w * (0.35 + (hashHue(ev.tid) % 30) / 100)
            const cy = h * (0.3 + (hashHue(ev.tid + 'y') % 40) / 100)
            b.vx += (cx - b.x) * 0.01
            b.vy += (cy - b.y) * 0.01
          }
        }
      }

      // age edges
      edges.current = edges.current
        .map((e) => ({ ...e, age: e.age - 1 }))
        .filter((e) => e.age > 0)
        .slice(-80)

      for (const e of edges.current) {
        const A = birds.current.get(e.a)
        const B = birds.current.get(e.b)
        if (!A || !B) continue
        ctx.beginPath()
        ctx.strokeStyle = `rgba(255,90,90,${0.15 + e.age / 80})`
        ctx.lineWidth = 1.2
        ctx.moveTo(A.x, A.y)
        ctx.lineTo(B.x, B.y)
        ctx.stroke()
        // packet traveling along the edge
        const u = (frame % 24) / 24
        const px = A.x + (B.x - A.x) * u
        const py = A.y + (B.y - A.y) * u
        ctx.fillStyle = 'rgba(250,178,25,0.9)'
        ctx.beginPath()
        ctx.arc(px, py, 2.2, 0, Math.PI * 2)
        ctx.fill()
      }

      for (const [, b] of birds.current) {
        // mild flocking among hot agents
        if (b.hot && b.tid) {
          let sx = 0
          let sy = 0
          let n = 0
          for (const [, o] of birds.current) {
            if (o.tid !== b.tid || o === b) continue
            sx += o.x
            sy += o.y
            n++
          }
          if (n) {
            b.vx += (sx / n - b.x) * 0.004
            b.vy += (sy / n - b.y) * 0.004
          }
        }
        b.x += b.vx + Math.sin(frame / 35 + b.x * 0.02) * 0.1
        b.y += b.vy
        b.vx *= 0.96
        b.vy *= 0.96
        if (b.x < 10) {
          b.x = 10
          b.vx *= -0.4
        }
        if (b.x > w - 10) {
          b.x = w - 10
          b.vx *= -0.4
        }
        if (b.y < 10) {
          b.y = 10
          b.vy *= -0.4
        }
        if (b.y > h - 14) {
          b.y = h - 14
          b.vy *= -0.4
        }
        if (b.pulse > 0) b.pulse--

        if (b.pulse > 0) {
          ctx.beginPath()
          ctx.strokeStyle = b.hot ? `rgba(255,90,90,${b.pulse / 22})` : `rgba(106,168,255,${b.pulse / 28})`
          ctx.arc(b.x, b.y, 6 + (18 - b.pulse) * 0.5, 0, Math.PI * 2)
          ctx.stroke()
        }

        ctx.beginPath()
        ctx.fillStyle = b.hot ? '#ff5a5a' : '#6aa8ff'
        ctx.globalAlpha = b.hot ? 0.95 : 0.55
        ctx.arc(b.x, b.y, b.hot ? 4.5 : 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1

        if (large && b.hot) {
          ctx.fillStyle = 'rgba(184,191,205,0.75)'
          ctx.font = '10px JetBrains Mono, monospace'
          ctx.fillText(b.label, b.x + 6, b.y - 6)
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [focus, large])

  // reset ingest cursor when tape rewinds
  useEffect(() => {
    if (events.length < lastLen.current) {
      lastLen.current = 0
      birds.current.clear()
      edges.current = []
    }
  }, [events.length])

  const actors = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) m.set(e.actor, (m.get(e.actor) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, large ? 12 : 5)
  }, [events, large])

  return (
    <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel', large && 'col-span-full')}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-fg">{title}</div>
          <div className="truncate text-[10.5px] text-faint">{subtitle}</div>
        </div>
        <div className="mono shrink-0 text-[10px] text-muted">{actors.length} agents · {events.length} msgs</div>
      </div>
      <div className={cx('relative', large ? 'h-[300px]' : 'h-[150px]')}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap gap-1">
          {actors.map(([a, n]) => (
            <span key={a} className="rounded bg-void/85 px-1.5 py-0.5 font-mono text-[10px] text-fg-2">
              {shortActor(a)} · {n}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SandboxView() {
  const health = useApiHealth(3000)
  const [source, setSource] = useState('synthetic')
  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState<string | null>(null)
  const [tape, setTape] = useState<ReplayTape | null>(null)
  const [spread, setSpread] = useState<SpreadRow[]>([])
  const [ticks, setTicks] = useState<Tick[]>([])
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(16)
  const [cursor, setCursor] = useState(0)
  const [focus, setFocus] = useState('world')
  const boot = useRef(false)

  const start = async (ds: string) => {
    const preset = SOURCES.find((s) => s.id === ds) ?? SOURCES[0]
    setSource(ds)
    setError(null)
    setStatus('scanning')
    setTape(null)
    setSpread([])
    setTicks([])
    setCursor(0)
    setFocus('world')
    try {
      const brief = await api<{ id: string }>('/api/runs', {
        method: 'POST',
        json: { dataset: ds, wait: true, ...(preset.body ?? {}) },
      })
      setRunId(brief.id)
      const [rep, sp, full] = await Promise.all([
        api<ReplayTape>(`/api/runs/${brief.id}/replay?max_events=1200&sandboxes=5`),
        api<SpreadRow[]>(`/api/runs/${brief.id}/spread?top=8`),
        api<{ result: RunResult | null }>(`/api/runs/${brief.id}`),
      ])
      setTape(rep)
      setSpread(sp)
      setTicks(full.result?.timeline ?? [])
      setStatus('ready')
      setPlaying(true)
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!health.online || boot.current) return
    boot.current = true
    void start('synthetic')
  }, [health.online])

  useEffect(() => {
    if (!playing || !tape?.events.length) return
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (c >= tape.events.length - 1) return c
        return Math.min(tape.events.length - 1, c + Math.max(1, Math.floor(speed / 8)))
      })
    }, 40)
    return () => clearInterval(id)
  }, [playing, tape, speed])

  const visible = useMemo(() => (tape ? tape.events.slice(0, cursor + 1) : []), [tape, cursor])
  const recent = useMemo(() => visible.slice(-48).reverse(), [visible])
  const byBox = useMemo(() => {
    const m = new Map<string, TapeEvent[]>()
    for (const e of visible) {
      const k = e.sandbox || 'world'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(e)
    }
    return m
  }, [visible])

  const progress = tape?.events.length ? cursor / (tape.events.length - 1 || 1) : 0
  const nowT = tape?.events[cursor]?.t
  const coordShare = visible.length ? visible.filter((e) => e.coordinated).length / visible.length : 0
  const liveActors = useMemo(() => new Set(visible.map((e) => e.actor)).size, [visible])
  const fastest = spread[0]
  const hasAlarm = ticks.some((t) => t.alarm)

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-faint">sandbox · world feed</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-fg">Agents coordinating in real time</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            A finished scan is played like a recording. Red agents share a folded template. Yellow packets are copies moving between them. Rooms are channels or rendezvous templates from the dataset.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.note}
              onClick={() => void start(s.id)}
              className={cx(
                'rounded-lg border px-3 py-1.5 text-[12px]',
                source === s.id ? 'border-accent bg-panel-2 text-fg' : 'border-line text-muted hover:border-line-2 hover:text-fg',
              )}
            >
              {s.label}
            </button>
          ))}
          <Link to="/live" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:text-fg">
            <Radio size={13} /> detector
          </Link>
        </div>
      </header>

      {!health.online && (
        <Panel>
          <EmptyNote>
            Start <span className="mono text-fg">kollude serve</span> — sandbox autoplays synthetic when the API is up.
          </EmptyNote>
        </Panel>
      )}

      {error && (
        <Panel>
          <div className="text-[13px] text-crit">{error}</div>
          <div className="mt-1 text-[11px] text-faint">If the dataset is missing, fetch it from Detector or stay on synthetic / forge.</div>
        </Panel>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="source" value={tape?.source ?? source} sub={status === 'scanning' ? 'scanning…' : tape ? `${tape.n_total.toLocaleString()} events · stride ${tape.stride}` : '—'} />
        <StatTile label="clock" value={nowT ? new Date(nowT).toISOString().slice(0, 16).replace('T', ' ') : '—'} sub="log time" />
        <StatTile label="live agents" value={String(liveActors)} sub="on screen from the tape" />
        <StatTile label="coord share" value={coordShare ? `${(coordShare * 100).toFixed(0)}%` : '—'} sub="multi-actor templates" />
        <StatTile label="fastest copy" value={fastest ? `${fastest.hours_to_min_actors.toFixed(1)}h` : '—'} sub={fastest ? `${shortActor(fastest.seeder)} → ${fastest.n_actors} actors` : 'after scan'} />
      </div>

      <Panel className="!p-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!tape} onClick={() => setPlaying((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-panel-3 px-3 py-1.5 text-[12px] text-fg disabled:opacity-40">
            {playing ? <Pause size={13} /> : <Play size={13} />}
            {playing ? 'pause' : 'play'}
          </button>
          <button
            type="button"
            disabled={!tape}
            onClick={() => {
              setCursor(0)
              setPlaying(true)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:text-fg disabled:opacity-40"
          >
            <RotateCcw size={13} /> restart
          </button>
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <button key={s.id} type="button" onClick={() => setSpeed(s.id)} className={cx('rounded-md px-2 py-1 font-mono text-[11px]', speed === s.id ? 'bg-accent/20 text-accent' : 'text-faint hover:text-fg')}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="min-w-[160px] flex-1">
            <input
              type="range"
              min={0}
              max={Math.max(0, (tape?.events.length ?? 1) - 1)}
              value={cursor}
              onChange={(e) => {
                setCursor(Number(e.target.value))
                setPlaying(false)
              }}
              className="w-full accent-[#6aa8ff]"
            />
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
          {hasAlarm && (
            <div className="inline-flex items-center gap-1 text-[11px] text-serious">
              <Zap size={12} /> scan has an alarm
            </div>
          )}
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="grid gap-3 lg:col-span-2">
          <AgentArena large focus="world" title="world · open web / full feed" subtitle="every message in the tape · red = coordinating · yellow = copy in flight" events={visible} />
          <div className="grid gap-3 sm:grid-cols-2">
            {(tape?.sandboxes.filter((s) => s.id !== 'world') ?? []).map((box) => (
              <button key={box.id} type="button" onClick={() => setFocus(box.id)} className="text-left">
                <AgentArena focus={box.id} title={box.label} subtitle={`${box.kind} room · ${box.n_actors} actors`} events={byBox.get(box.id) ?? []} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel pad={false} className="flex min-h-0 flex-1 flex-col">
            <div className="px-3 pt-3">
              <PanelHeader eyebrow="dataset text · never executed" title="live transcript" />
            </div>
            <div className="scroll-thin max-h-[340px] flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              {recent.length === 0 && <EmptyNote>{status === 'scanning' ? 'Scanning…' : 'Waiting for tape…'}</EmptyNote>}
              {recent.map((e, i) => (
                <div key={`${e.t}-${e.actor}-${i}`} className={cx('rounded-lg border px-2.5 py-2', e.coordinated ? 'border-crit/40 bg-crit/5' : 'border-line bg-panel-2')}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-faint">
                    <span className="mono text-accent">{shortActor(e.actor)}</span>
                    <span className="mono">{e.t.slice(11, 19)}</span>
                  </div>
                  <div className="mono whitespace-pre-wrap break-words text-[11.5px] leading-snug text-fg-2">{e.text}</div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel pad={false}>
            <div className="px-3 pt-3">
              <PanelHeader eyebrow="who copied first · how fast" title="coordination speed" />
            </div>
            <div className="space-y-2 px-3 pb-3">
              {spread.length === 0 && <EmptyNote>After the scan finishes.</EmptyNote>}
              {spread.map((row) => (
                <div key={row.tid} className="rounded-lg border border-line bg-panel-2 px-2.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="mono text-[14px] font-semibold text-fg">{row.hours_to_min_actors.toFixed(1)}h</div>
                    <div className="text-[10px] text-faint">{row.n_actors} actors</div>
                  </div>
                  <div className="mt-1 text-[11px] text-fg-2">
                    <span className="text-accent">{shortActor(row.seeder)}</span>
                    <span className="text-faint"> → </span>
                    {row.carriers.slice(1, 5).map(shortActor).join(' · ')}
                  </div>
                  <div className="mono mt-1 truncate text-[10.5px] text-muted">{row.template}</div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      {runId && (
        <div className="text-[11px] text-faint">
          run <span className="mono text-muted">{runId}</span>
          {focus !== 'world' && (
            <>
              {' '}
              · room <span className="mono">{focus.slice(0, 28)}</span>
              <button type="button" className="ml-2 text-accent" onClick={() => setFocus('world')}>
                world
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
