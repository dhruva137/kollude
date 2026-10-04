import {
  Activity,
  Brain,
  FlaskConical,
  GitBranch,
  Globe,
  LayoutDashboard,
  Network,
  Radio,
  ScaleIcon,
  Search,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useJson } from '../lib/loadData'
import type { LoopKpis } from '../types'
import { CommandPalette, openPalette } from './CommandPalette'
import { ConservativeToggle } from './ConservativeToggle'
import { Kbd, cx } from './ui'

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; hint: string }

export const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Live engine',
    items: [
      { to: '/sandbox', label: 'Sandbox', icon: Radio, end: true, hint: 'live replay of agents across rooms' },
      { to: '/live', label: 'Detector', icon: Activity, hint: 'C · M · e-CUSUM scan console' },
      { to: '/backtests', label: 'Backtests', icon: FlaskConical, hint: 'real labelled data · baselines · CIs · stress' },
      { to: '/atlas', label: 'Incident atlas', icon: Globe, hint: 'swarms in the wild · datasets · standard questions' },
    ],
  },
  {
    title: 'Overview',
    items: [{ to: '/loop', label: 'The Loop', icon: LayoutDashboard, hint: 'closed loop + headline numbers' }],
  },
  {
    title: 'Investigate',
    items: [
      { to: '/swarm', label: 'Swarm map', icon: Network, hint: 'replay the outbreak' },
      { to: '/strain', label: 'Strain tree', icon: GitBranch, hint: 'who passed what to whom' },
      { to: '/agents', label: 'Agents · Say/Do', icon: Users, hint: 'claims vs actions per agent' },
    ],
  },
  {
    title: 'Inside the model',
    items: [{ to: '/brain', label: 'Brain', icon: Brain, hint: 'red nodes: misguidance by layer' }],
  },
  {
    title: 'Structure',
    items: [{ to: '/org', label: 'Org chart', icon: Activity, hint: 'coordinator, relays, workstreams' }],
  },
  {
    title: 'Proof',
    items: [{ to: '/evidence', label: 'Evidence', icon: ScaleIcon, hint: 'every number vs a baseline' }],
  },
]

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="lg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ff5a5a" />
          <stop offset="100%" stopColor="#d03b3b" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="#11161f" stroke="#2f3a4a" />
      {[
        [9, 11],
        [22, 9],
        [24, 19],
        [12, 23],
        [17, 16],
        [7, 18],
        [20, 25],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 4 ? 3.2 : 1.7} fill={i === 4 ? 'url(#lg)' : '#6aa8ff'} />
      ))}
      <path d="M17 16 L9 11 M17 16 L22 9 M17 16 L24 19 M17 16 L12 23" stroke="#ff5a5a" strokeWidth="0.9" opacity="0.7" />
    </svg>
  )
}

export function Layout() {
  const loc = useLocation()
  const kpis = useJson<LoopKpis>('loop_kpis.json')
  const g = kpis.status === 'ready' ? kpis.data.global : null

  return (
    <div className="flex h-full min-h-0 bg-void text-fg">
      {/* Sidebar */}
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-sky/80 md:flex">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Logo />
          <div className="leading-tight">
            <div className="text-[14px] font-semibold tracking-tight">kollude</div>
            <div className="mono text-[10px] uppercase tracking-[0.16em] text-muted">
              swarm forensics console
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={openPalette}
          className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-left text-[12.5px] text-muted transition hover:border-line-2 hover:text-fg-2"
        >
          <Search size={14} />
          <span className="flex-1">Jump to…</span>
          <Kbd>⌘K</Kbd>
        </button>

        <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
          {NAV_GROUPS.map((grp) => (
            <div key={grp.title} className="mt-3">
              <div className="mono px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
                {grp.title}
              </div>
              {grp.items.map((it) => (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  className={({ isActive }) =>
                    cx(
                      'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition',
                      isActive
                        ? 'bg-panel-3 text-fg'
                        : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-accent" />
                      )}
                      <it.icon size={15} strokeWidth={2} className={isActive ? 'text-accent' : 'text-muted group-hover:text-fg-2'} />
                      {it.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-line px-4 py-3 text-[11px] text-muted">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="mono text-fg-2">FORGE · ep001</span>
          </div>
          {g && (
            <div className="mono grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px]">
              <span>{g.agents} agents</span>
              <span>{g.events} events</span>
              <span>{g.claims} claims</span>
              <span>{g.strains} strains</span>
            </div>
          )}
          <div className="mt-2 leading-snug text-faint">
            Air-gapped synthetic swarm. Rule-based agents; no real site touched.
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-void/85 px-4 backdrop-blur md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <Logo />
            <span className="text-[13px] font-semibold">kollude</span>
          </div>
          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto md:hidden">
            {NAV_GROUPS.flatMap((g) => g.items).map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  cx('rounded-md p-1.5', isActive ? 'bg-panel-3 text-fg' : 'text-muted')
                }
                title={it.label}
              >
                <it.icon size={16} />
              </NavLink>
            ))}
          </nav>
          <div className="hidden min-w-0 items-center gap-2 text-[12.5px] text-muted md:flex">
            <span className="mono rounded-md border border-line bg-panel px-2 py-0.5 text-[11px] text-fg-2">
              episode ep001
            </span>
            <span className="truncate">
              {NAV_GROUPS.flatMap((g) => g.items).find((i) =>
                i.end ? loc.pathname === i.to : loc.pathname.startsWith(i.to),
              )?.hint ?? ''}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ConservativeToggle />
          </div>
        </header>

        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div key={loc.pathname} className="mx-auto w-full max-w-[1480px] animate-fade-up px-4 py-5 md:px-6">
            <Outlet />
          </div>
          <footer className="mono mx-auto max-w-[1480px] px-6 pb-6 pt-2 text-[10.5px] text-faint">
            Live engine: Moltbook (jscmp4/Moltbook), collusion.wiki, AI Village (AI Digest), Who&amp;When (ICML 2025) ·
            Investigate views: FORGE synthetic episode + AI Village window · inference only, untrusted text rendered as plain text
          </footer>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}
