import { AlertTriangle, CheckCircle2, ExternalLink, HelpCircle, Play, Radar } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyNote, ErrorBlock, LoadingBlock, PageHeader, Panel, PanelHeader, cx } from '../components/ui'
import { useJson } from '../lib/loadData'

type Status = 'backtested' | 'measured' | 'wanted'

type Incident = {
  id: string
  title: string
  when: string
  where: string
  status: Status
  kind: string
  scale: string
  data: { source: string; url: string; size: string; labels: string; dataset_id: string | null }
  story: string
  landmarks: Array<{ t: string; label: string; kind: string }>
  found: string[]
  needs?: string
  caveat?: string
  replay: { dataset: string; start?: string; end?: string } | null
}

type Atlas = { generated_note: string; incidents: Incident[]; questions: string[] }

const STATUS: Record<Status, { label: string; cls: string; icon: typeof CheckCircle2; blurb: string }> = {
  backtested: { label: 'backtested', cls: 'border-good/50 text-[#4cc94c]', icon: CheckCircle2, blurb: 'labelled ground truth · baselines · 95% CIs' },
  measured: { label: 'measured', cls: 'border-accent/50 text-accent', icon: Radar, blurb: 'fetched and scanned · no labels' },
  wanted: { label: 'wanted', cls: 'border-warn/50 text-warn', icon: HelpCircle, blurb: 'known incident · data not in hand' },
}

const LM: Record<string, string> = { ground_truth: '#ff5a5a', intervention: '#f5b942', human: '#6aa8ff', context: '#8a8fa3' }

function replayHref(r: Incident['replay']) {
  if (!r) return null
  const q = new URLSearchParams({ ds: r.dataset, mode: 'replay' })
  if (r.start) q.set('start', r.start)
  if (r.end) q.set('end', r.end)
  return `/live?${q.toString()}`
}

export function AtlasView() {
  const atlas = useJson<Atlas>('atlas.json')
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)

  const rows = useMemo(() => (atlas.status === 'ready' ? atlas.data.incidents.filter((i) => filter === 'all' || i.status === filter) : []), [atlas, filter])

  if (atlas.status === 'loading') return <LoadingBlock label="Loading incident atlas" />
  if (atlas.status === 'error') return <ErrorBlock error={atlas.error} />
  const counts = atlas.data.incidents.reduce<Record<string, number>>((m, i) => ({ ...m, [i.status]: (m[i.status] ?? 0) + 1 }), {})

  return (
    <div>
      <PageHeader
        title="Incident atlas — swarms in the wild"
        subtitle="One registry of agent-swarm incidents and the datasets that record them. Every entry carries the same standard questions; the ones we hold data for show what kollude measured, the rest show exactly what is missing."
        right={
          <div className="flex gap-1 rounded-lg border border-line bg-void p-1 text-[12px]">
            {(['all', 'backtested', 'measured', 'wanted'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={cx('rounded-md px-2.5 py-1 transition', filter === s ? 'bg-panel-3 text-fg' : 'text-muted hover:text-fg-2')}
              >
                {s} {s !== 'all' && <span className="mono text-faint">{counts[s] ?? 0}</span>}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          {rows.length === 0 && <EmptyNote>No incidents in this bucket.</EmptyNote>}
          {rows.map((inc) => {
            const S = STATUS[inc.status]
            const expanded = open === inc.id
            const href = replayHref(inc.replay)
            return (
              <Panel key={inc.id} className={cx('transition', expanded && 'ring-1 ring-line-2')}>
                <button type="button" onClick={() => setOpen(expanded ? null : inc.id)} className="flex w-full items-start justify-between gap-3 text-left">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx('mono inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]', S.cls)}>
                        <S.icon size={11} /> {S.label}
                      </span>
                      <span className="mono text-[11px] text-muted">{inc.kind}</span>
                    </div>
                    <div className="mt-1.5 text-[15px] font-semibold text-fg">{inc.title}</div>
                    <div className="mono mt-0.5 text-[11.5px] text-muted">
                      {inc.when} · {inc.where} · {inc.scale}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {inc.landmarks.length > 0 && (
                      <div className="flex justify-end gap-1">
                        {inc.landmarks.map((l) => (
                          <span key={l.t} title={`${l.t} — ${l.label}`} className="h-2 w-2 rounded-full" style={{ background: LM[l.kind] ?? '#8a8fa3' }} />
                        ))}
                      </div>
                    )}
                    <div className="mono mt-1 text-[10.5px] text-faint">{inc.found.length ? `${inc.found.length} findings` : 'no data yet'}</div>
                  </div>
                </button>

                <p className="mt-3 text-[13px] leading-relaxed text-fg-2">{inc.story}</p>

                {expanded && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
                    <div>
                      <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.14em] text-faint">{inc.found.length ? 'what kollude found' : 'what kollude needs'}</div>
                      {inc.found.length ? (
                        <ul className="space-y-1.5 text-[12.5px] leading-snug text-fg-2">
                          {inc.found.map((f, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="rounded-lg border border-dashed border-warn/40 p-3 text-[12.5px] text-fg-2">{inc.needs}</div>
                      )}
                      {inc.caveat && (
                        <div className="mt-3 flex gap-2 rounded-lg border border-line bg-panel-2 p-2.5 text-[11.5px] leading-snug text-muted">
                          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" /> {inc.caveat}
                        </div>
                      )}
                    </div>
                    <div className="space-y-3">
                      <div>
                        <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.14em] text-faint">data</div>
                        <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[12px]">
                          <dt className="text-muted">source</dt>
                          <dd className="mono break-all text-fg-2">
                            <a href={inc.data.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-accent">
                              {inc.data.source} <ExternalLink size={10} />
                            </a>
                          </dd>
                          <dt className="text-muted">size</dt>
                          <dd className="mono text-fg-2">{inc.data.size}</dd>
                          <dt className="text-muted">labels</dt>
                          <dd className="text-fg-2">{inc.data.labels}</dd>
                        </dl>
                      </div>
                      {inc.landmarks.length > 0 && (
                        <div>
                          <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.14em] text-faint">landmarks</div>
                          <div className="space-y-1">
                            {inc.landmarks.map((l) => (
                              <div key={l.t} className="flex items-center gap-2 text-[12px]">
                                <span className="h-2 w-2 rounded-full" style={{ background: LM[l.kind] ?? '#8a8fa3' }} />
                                <span className="mono text-muted">{l.t}</span>
                                <span className="text-fg-2">{l.label}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {href ? (
                        <Link to={href} className="flex items-center justify-center gap-1.5 rounded-lg bg-accent-2 px-3 py-2 text-[12.5px] font-medium text-white transition hover:bg-accent">
                          <Play size={13} /> Replay live in the detector
                        </Link>
                      ) : inc.data.dataset_id ? (
                        <Link to="/backtests" className="flex items-center justify-center gap-1.5 rounded-lg border border-line-2 px-3 py-2 text-[12.5px] text-fg-2 hover:bg-panel-2">
                          See backtest
                        </Link>
                      ) : (
                        <div className="mono rounded-lg border border-line bg-void p-2.5 text-[10.5px] leading-relaxed text-fg-2">
                          uv run kollude scan &lt;file&gt;
                          <br />
                          uv run kollude watch-url &lt;public json feed&gt;
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Panel>
            )
          })}
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader eyebrow="same for every group" title="Standard questions" />
            <ol className="space-y-1.5 text-[12.5px] leading-snug text-fg-2">
              {atlas.data.questions.map((q, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mono w-4 shrink-0 text-faint">{i + 1}</span>
                  <span>{q}</span>
                </li>
              ))}
            </ol>
            <div className="mt-3 text-[11.5px] leading-snug text-muted">
              The Live detector answers all ten from data for any run (<span className="mono">build dossier</span>), each with a baseline beside it. The CLI does the same:{' '}
              <span className="mono text-fg-2">kollude dossier &lt;dataset|file&gt;</span>.
            </div>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="status legend" title="How to read this page" />
            <div className="space-y-2">
              {(Object.keys(STATUS) as Status[]).map((s) => {
                const S = STATUS[s]
                return (
                  <div key={s} className="flex items-start gap-2 text-[12px]">
                    <span className={cx('mono mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]', S.cls)}>
                      <S.icon size={11} /> {S.label}
                    </span>
                    <span className="text-fg-2">{S.blurb}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 text-[11px] leading-snug text-faint">{atlas.data.generated_note}</div>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="add an incident" title="Bring your own swarm" />
            <div className="space-y-2 text-[12px] leading-snug text-fg-2">
              <div>
                Public feed → <span className="mono">Live detector → Your agents → Watch a public JSON feed</span>
              </div>
              <div>
                File on disk → <span className="mono">uv run kollude scan path.jsonl</span>
              </div>
              <div>
                From an agent → MCP tools <span className="mono">scan_events</span>, <span className="mono">swarm_dossier</span> via <span className="mono">kollude mcp</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
