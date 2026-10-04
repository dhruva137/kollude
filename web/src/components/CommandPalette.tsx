import { CornerDownLeft, User } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { agentSlug, useJson } from '../lib/loadData'
import type { SwarmMap } from '../types'
import { NAV_GROUPS } from './Layout'
import { cx } from './ui'

const OPEN_EVENT = 'swarm:open-palette'
export const openPalette = () => window.dispatchEvent(new Event(OPEN_EVENT))

type Item = { key: string; label: string; hint: string; path: string; kind: 'view' | 'agent' }

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const navigate = useNavigate()
  const map = useJson<SwarmMap>('swarm_map.json')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQ('')
        setSel(0)
      } else if (e.key === 'Escape') setOpen(false)
    }
    const onOpen = () => {
      setOpen(true)
      setQ('')
      setSel(0)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const all = useMemo<Item[]>(() => {
    const views: Item[] = NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => ({ key: i.to, label: i.label, hint: i.hint, path: i.to, kind: 'view' as const })),
    )
    const agents: Item[] =
      map.status === 'ready'
        ? map.data.nodes.map((n) => ({
            key: n.id,
            label: n.label,
            hint: `${n.role} · open Say/Do`,
            path: `/agents?id=${agentSlug(n.id)}`,
            kind: 'agent' as const,
          }))
        : []
    return [...views, ...agents]
  }, [map])

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase()
    if (!qq) return all
    return all.filter((r) => r.label.toLowerCase().includes(qq) || r.hint.toLowerCase().includes(qq))
  }, [q, all])

  if (!open) return null
  const go = (it: Item | undefined) => {
    if (!it) return
    navigate(it.path)
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/55 px-4 pt-[14vh] backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(items.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') go(items[sel])
          }}
          placeholder="Jump to a view or an agent…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-faint"
        />
        <ul className="scroll-thin max-h-[52vh] overflow-auto py-1.5">
          {items.map((r, i) => {
            const Icon = r.kind === 'view' ? NAV_GROUPS.flatMap((g) => g.items).find((n) => n.to === r.path)?.icon ?? User : User
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => go(r)}
                  className={cx(
                    'flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]',
                    i === sel ? 'bg-panel-3 text-fg' : 'text-fg-2',
                  )}
                >
                  <Icon size={15} className="text-muted" />
                  <span className="flex-1">{r.label}</span>
                  <span className="mono text-[10.5px] text-faint">{r.hint}</span>
                  {i === sel && <CornerDownLeft size={13} className="text-muted" />}
                </button>
              </li>
            )
          })}
          {items.length === 0 && <li className="px-4 py-6 text-center text-[12px] text-muted">No matches</li>}
        </ul>
        <div className="mono flex gap-4 border-t border-line px-4 py-2 text-[10.5px] text-faint">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
