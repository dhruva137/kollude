import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

/** Full-bleed entry. Brand first; one CTA into the console. */
export function LandingView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let frame = 0

    type Dot = { x: number; y: number; vx: number; vy: number; hot: boolean; tid: number }
    let dots: Dot[] = []

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.floor(window.innerWidth * dpr)
      canvas.height = Math.floor(window.innerHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const w = window.innerWidth
      const h = window.innerHeight
      dots = Array.from({ length: 72 }, (_, i) => {
        const hot = i % 5 < 2
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.55,
          vy: (Math.random() - 0.5) * 0.35,
          hot,
          tid: hot ? (i % 3) + 1 : 0,
        }
      })
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      frame++
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)

      // atmosphere — deep void with a cool radial, not purple
      const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 40, w * 0.5, h * 0.4, Math.max(w, h) * 0.7)
      g.addColorStop(0, 'rgba(57,135,229,0.07)')
      g.addColorStop(0.55, 'rgba(11,14,20,0.2)')
      g.addColorStop(1, 'rgba(7,9,13,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      // edges between agents that share a tid
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i]
        if (!a.hot) continue
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j]
          if (b.tid !== a.tid) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const d2 = dx * dx + dy * dy
          if (d2 > 16000) continue
          ctx.beginPath()
          ctx.strokeStyle = `rgba(255,90,90,${0.08 + (1 - d2 / 16000) * 0.18})`
          ctx.lineWidth = 1
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          const u = ((frame + i * 3) % 50) / 50
          ctx.fillStyle = 'rgba(250,178,25,0.75)'
          ctx.beginPath()
          ctx.arc(a.x + dx * u, a.y + dy * u, 1.6, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      for (const d of dots) {
        if (d.hot && d.tid) {
          let sx = 0
          let sy = 0
          let n = 0
          for (const o of dots) {
            if (o.tid !== d.tid || o === d) continue
            sx += o.x
            sy += o.y
            n++
          }
          if (n) {
            d.vx += (sx / n - d.x) * 0.0018
            d.vy += (sy / n - d.y) * 0.0018
          }
        }
        d.x += d.vx + Math.sin(frame / 40 + d.x * 0.01) * 0.08
        d.y += d.vy
        d.vx *= 0.995
        d.vy *= 0.995
        if (d.x < 0) d.x = w
        if (d.x > w) d.x = 0
        if (d.y < 0) d.y = h
        if (d.y > h) d.y = 0

        ctx.beginPath()
        ctx.fillStyle = d.hot ? '#ff5a5a' : '#6aa8ff'
        ctx.globalAlpha = d.hot ? 0.9 : 0.4
        ctx.arc(d.x, d.y, d.hot ? 3.2 : 2.1, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') window.location.hash = '#/sandbox'
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="relative h-full min-h-[100dvh] overflow-hidden bg-void text-fg">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(7,9,13,0.55)_70%,rgba(7,9,13,0.92)_100%)]" />

      <div className="relative z-10 flex h-full min-h-[100dvh] flex-col items-center justify-center px-6">
        <div className="animate-fade-up text-center">
          <div className="mono mb-5 text-[11px] uppercase tracking-[0.28em] text-muted">swarm forensics</div>
          <h1 className="text-[clamp(3.25rem,12vw,7.5rem)] font-semibold leading-[0.92] tracking-[-0.04em] text-fg">
            kollude
          </h1>
          <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-fg-2 md:text-[16px]">
            See when agents start copying the same line — and who moved first.
          </p>
          <div className="pointer-events-auto mt-10 flex flex-col items-center gap-3">
            <Link
              to="/sandbox"
              className="group inline-flex items-center gap-3 rounded-full border border-line-2 bg-panel/80 px-8 py-3.5 text-[14px] font-medium tracking-wide text-fg backdrop-blur transition hover:border-accent hover:bg-panel-2"
            >
              <span>Enter</span>
              <span className="mono text-[12px] text-muted transition group-hover:text-accent">↵</span>
            </Link>
            <div className="mono text-[10.5px] text-faint">press enter</div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-5 left-0 right-0 z-10 flex justify-center">
        <div className="mono text-[10px] tracking-[0.14em] text-faint">M ∧ C · e-CUSUM · local only</div>
      </div>
    </div>
  )
}
