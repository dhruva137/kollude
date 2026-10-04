import { useEffect, useRef, useState } from 'react'

type Boid = { x: number; y: number; vx: number; vy: number; infectedAt: number }

/**
 * Boids murmuration with an outbreak: one patient zero (red) infects neighbours by
 * proximity, the flock turns red, then the cycle resets. Purely illustrative —
 * the measured outbreak lives in the Swarm map.
 */
export function Murmuration({ className = '', n = 150 }: { className?: string; n?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [count, setCount] = useState({ inf: 1, total: n })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    let w = 0
    let h = 0
    let frame = 0
    let cycleStart = 0
    const boids: Boid[] = []

    const resize = () => {
      const parent = canvas.parentElement
      w = parent?.clientWidth ?? 800
      h = parent?.clientHeight ?? 320
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const reset = () => {
      boids.length = 0
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        boids.push({
          x: w * (0.45 + Math.random() * 0.5),
          y: h * (0.15 + Math.random() * 0.7),
          vx: Math.cos(a) * 1.2,
          vy: Math.sin(a) * 1.2,
          infectedAt: -1,
        })
      }
      boids[0].infectedAt = 0
      cycleStart = frame
    }

    const step = () => {
      frame++
      const t = frame - cycleStart
      ctx.fillStyle = 'rgba(11,14,20,0.24)'
      ctx.fillRect(0, 0, w, h)

      let inf = 0
      for (let i = 0; i < boids.length; i++) {
        const b = boids[i]
        let ax = 0,
          ay = 0,
          cx = 0,
          cy = 0,
          sx = 0,
          sy = 0,
          k = 0
        for (let j = 0; j < boids.length; j++) {
          if (i === j) continue
          const o = boids[j]
          const dx = o.x - b.x
          const dy = o.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < 2500) {
            k++
            cx += o.x
            cy += o.y
            sx += o.vx
            sy += o.vy
            if (d2 < 324 && d2 > 0) {
              const d = Math.sqrt(d2)
              ax -= dx / d
              ay -= dy / d
            }
            // transmission: infected neighbour within 26px
            if (b.infectedAt < 0 && o.infectedAt >= 0 && t - o.infectedAt > 20 && d2 < 676 && Math.random() < 0.012) {
              b.infectedAt = t
            }
          }
        }
        if (k) {
          ax += (cx / k - b.x) * 0.0035 + (sx / k - b.vx) * 0.045
          ay += (cy / k - b.y) * 0.0035 + (sy / k - b.vy) * 0.045
        }
        // soft attraction to a drifting focus on the right two-thirds
        const fx = w * (0.68 + 0.12 * Math.sin(frame * 0.003))
        const fy = h * (0.5 + 0.22 * Math.cos(frame * 0.0041))
        ax += (fx - b.x) * 0.00045
        ay += (fy - b.y) * 0.00045
        b.vx = (b.vx + ax) * 0.975
        b.vy = (b.vy + ay) * 0.975
        const sp = Math.hypot(b.vx, b.vy) || 1
        const max = 2.3,
          min = 0.9
        const s = sp > max ? max / sp : sp < min ? min / sp : 1
        b.vx *= s
        b.vy *= s
        b.x += b.vx
        b.y += b.vy
        if (b.x < -10) b.x = w + 10
        if (b.x > w + 10) b.x = -10
        if (b.y < -10) b.y = h + 10
        if (b.y > h + 10) b.y = -10

        const isInf = b.infectedAt >= 0
        if (isInf) inf++
        const fresh = isInf ? Math.max(0, 1 - (t - b.infectedAt) / 60) : 0
        ctx.beginPath()
        if (isInf) {
          ctx.fillStyle = `rgba(255,90,90,${0.8 + 0.2 * fresh})`
          ctx.shadowColor = 'rgba(255,90,90,0.9)'
          ctx.shadowBlur = 6 + 10 * fresh
        } else {
          ctx.fillStyle = 'rgba(106,168,255,0.75)'
          ctx.shadowBlur = 0
        }
        ctx.arc(b.x, b.y, isInf ? 1.9 + fresh * 1.8 : 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.shadowBlur = 0
      if (frame % 15 === 0) setCount({ inf, total: boids.length })
      if (inf === boids.length && t > 120) {
        if (t > inf + 360) reset()
      } else if (t > 2400) reset()
      raf = requestAnimationFrame(step)
    }

    resize()
    reset()
    if (reduce) {
      for (let i = 0; i < 60; i++) step()
      cancelAnimationFrame(raf)
    } else raf = requestAnimationFrame(step)
    const ro = new ResizeObserver(() => resize())
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [n])

  return (
    <>
      <canvas ref={canvasRef} className={`block h-full w-full ${className}`} aria-hidden />
      <div className="mono pointer-events-none absolute bottom-3 right-4 rounded-md border border-line bg-void/70 px-2 py-1 text-[10.5px] text-muted backdrop-blur">
        illustrative · infected <span className="text-[#ff7b7b]">{count.inf}</span>/{count.total}
      </div>
    </>
  )
}
