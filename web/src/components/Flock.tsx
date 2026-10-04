import { useEffect, useRef } from 'react'
import type { ActorRow, Cluster } from '../lib/api'

type Bird = {
  x: number
  y: number
  vx: number
  vy: number
  actor: string
  hot: boolean
  hue: string
}

const HOT = ['#ff5a5a', '#ec835a', '#fab219']
const LONE = '#6aa8ff'

function seed(clusters: Cluster[], actors: ActorRow[], w: number, h: number): Bird[] {
  const birds: Bird[] = []
  const flocks = clusters.slice(0, 5)
  if (flocks.length === 0 && actors.length === 0) {
    for (let i = 0; i < 42; i++) {
      birds.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: 0.35 + Math.random() * 0.6,
        vy: (Math.random() - 0.5) * 0.25,
        actor: '',
        hot: false,
        hue: LONE,
      })
    }
    return birds
  }
  flocks.forEach((c, fi) => {
    const cx = ((fi + 0.5) / flocks.length) * w
    const cy = h * (0.32 + (fi % 2) * 0.28)
    const n = Math.min(16, Math.max(4, c.n_actors))
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2
      birds.push({
        x: cx + Math.cos(ang) * (28 + (i % 5) * 8),
        y: cy + Math.sin(ang) * (16 + (i % 3) * 6),
        vx: 0.45 + (fi % 3) * 0.12,
        vy: Math.sin(ang) * 0.15,
        actor: '',
        hot: true,
        hue: HOT[fi % HOT.length],
      })
    }
  })
  actors
    .filter((a) => (a.coord_frac ?? 0) < 0.2)
    .slice(0, 18)
    .forEach((a, i) => {
      birds.push({
        x: (i / 18) * w,
        y: h * 0.82,
        vx: 0.25 + (i % 4) * 0.08,
        vy: 0,
        actor: a.actor,
        hot: false,
        hue: LONE,
      })
    })
  if (actors[0] && birds[0]) birds[0].actor = actors[0].actor
  return birds
}

export function Flock({
  clusters,
  actors,
  onActor,
}: {
  clusters: Cluster[]
  actors: ActorRow[]
  onActor: (actor: string) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const birds = useRef<Bird[]>([])
  const hit = useRef<Bird[]>([])
  const key = clusters.map((c) => c.tid).join('|') + ':' + actors.length

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    let raf = 0
    const resize = () => {
      const r = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.floor(r.width * dpr))
      canvas.height = Math.max(1, Math.floor(r.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      birds.current = seed(clusters, actors, r.width, r.height)
      hit.current = birds.current
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const draw = () => {
      const r = canvas.getBoundingClientRect()
      const w = r.width
      const h = r.height
      ctx.clearRect(0, 0, w, h)
      for (const b of birds.current) {
        b.x += b.vx
        b.y += b.vy + Math.sin(frame / 28 + b.x * 0.02) * 0.18
        if (b.x > w + 12) b.x = -12
        if (b.y < 8) b.y = 8
        if (b.y > h - 8) b.y = h - 8
        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.rotate(Math.atan2(b.vy, b.vx) * 0.4)
        ctx.fillStyle = b.hue
        ctx.globalAlpha = b.hot ? 0.95 : 0.55
        ctx.beginPath()
        ctx.moveTo(7, 0)
        ctx.lineTo(-5, 3.2)
        ctx.lineTo(-2, 0)
        ctx.lineTo(-5, -3.2)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
      frame += 1
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // Reseed only when the flock membership changes, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <div className="relative">
      <canvas
        ref={ref}
        className="h-[210px] w-full cursor-pointer rounded-lg"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          let best: Bird | null = null
          let dmin = 18
          for (const b of hit.current) {
            if (!b.actor) continue
            const d = Math.hypot(b.x - x, b.y - y)
            if (d < dmin) {
              dmin = d
              best = b
            }
          }
          if (best?.actor) onActor(best.actor)
        }}
      />
      <div className="pointer-events-none absolute left-3 top-2 flex gap-3 text-[10.5px]">
        <span className="mono text-[#ff5a5a]">coordinated flock</span>
        <span className="mono text-[#6aa8ff]">lone agents</span>
      </div>
      {clusters.length === 0 && (
        <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted">Run a scan and the flock tightens around each shared template.</div>
      )}
    </div>
  )
}
