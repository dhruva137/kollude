import { Activity, Bot, Database, Download, FileText, Flag, Globe, Play, Radio, Search, Square, Terminal, X, Zap } from 'lucide-react'
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Flock } from '../components/Flock'
import { LiveChart } from '../components/LiveChart'
import { EmptyNote, Panel, PanelHeader, StatTile, cx } from '../components/ui'
import {
  API,
  api,
  useApiHealth,
  useRunStream,
  type ActorRow,
  type Cluster,
  type DatasetInfo,
  type Dossier,
  fmtBaseline,
  type RunBrief,
  type RunResult,
  type SpreadRow,
  type TemplateHit,
  type Tick,
} from '../lib/api'

type Mode = 'replay' | 'scan' | 'agents'

const PRESETS: Record<string, { start?: string; end?: string; note: string }> = {
  synthetic: { note: 'Generated swarm, known onset 2026-01-10 04:00. No download.' },
  forge: { note: 'FORGE ep001, shipped in the repo. Rule-based agents, known planted facts. Synthetic.' },
  moltbook: { start: '2026-02-03', end: '2026-02-09', note: 'mbc-20 wave window only. The full 1.7M-post backtest is already on Backtests — this slice stays in memory.' },
  wiki: { note: 'Whole incident (~14.6k revisions)' },
  village: { start: '2025-10-02', end: '2025-10-15', note: 'Two weeks of AI Village chat' },
}

const CLI_COMMANDS = `uv run kollude demo
uv run kollude datasets list
uv run kollude scan synthetic
uv run kollude spread synthetic
uv run kollude dossier synthetic
uv run kollude scan kollude/fixtures/swarm.jsonl
uv run kollude attribute kollude/fixtures/failure.json
uv run kollude watch kollude/fixtures/swarm.jsonl
uv run kollude backtest synthetic
uv run kollude stress --quick
uv run kollude serve`

function fmtN(v: number | null | undefined, d = 0) {
  return v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })
}

function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[1px]" onClick={onClose}>
      <aside
        className="scroll-thin h-full w-full max-w-[560px] animate-fade-up overflow-y-auto border-l border-line-2 bg-sky p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 text-[15px] font-semibold text-fg">{title}</div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg">
            <X size={16} />
          </button>
        </div>
        {children}
      </aside>
    </div>
  )
}

function Spark({ data, h = 46 }: { data: Array<{ t: string; n: number }>; h?: number }) {
  if (!data.length) return null
  const max = Math.max(...data.map((d) => d.n), 1)
  const w = 500
  const bw = w / data.length
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[46px] w-full" preserveAspectRatio="none">
      {data.map((d, i) => (
        <rect key={d.t} x={i * bw} y={h - (d.n / max) * h} width={Math.max(bw - 0.5, 0.5)} height={(d.n / max) * h} fill="#6aa8ff" opacity={0.8} />
      ))}
    </svg>
  )
}

/** Untrusted agent text: rendered as plain text only (React escapes; never HTML). */
function Excerpt({ text }: { text: string }) {
  return <div className="mono whitespace-pre-wrap break-words text-[11.5px] leading-snug text-fg-2">{text}</div>
}

type ClusterDetail = {
  tid: string
  template: string | null
  n_events: number
  n_actors: number
  label_rate: number | null
  top_actors: Array<{ actor: string; n: number }>
  hourly: Array<{ t: string; n: number }>
  events: Array<{ t: string; actor: string; text: string; channel: string | null }>
}

type ActorDetail = {
  actor: string
  n_events: number
  first_t: string | null
  last_t: string | null
  coord_frac: number | null
  label_rate: number | null
  co_actors: Array<{ actor: string; shared_events: number }>
  events: Array<{ t: string; text: string; tid: string | null; coordinated: boolean; channel: string | null }>
}

export function LiveView() {
  const health = useApiHealth()
  const [params] = useSearchParams()
  const linked = params.get('ds')
  const [datasets, setDatasets] = useState<DatasetInfo[]>([])
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode | null) ?? 'replay')
  const [ds, setDs] = useState(linked ?? 'synthetic')
  const [start, setStart] = useState(linked ? (params.get('start') ?? '') : '')
  const [end, setEnd] = useState(linked ? (params.get('end') ?? '') : '')
  const [pace, setPace] = useState(0.15)
  const [swarmShare, setSwarmShare] = useState(0.03)
  const [monName, setMonName] = useState('my-agents')
  const [watchPath, setWatchPath] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [feedInterval, setFeedInterval] = useState(30)
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [dossierBusy, setDossierBusy] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [isMonitor, setIsMonitor] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [runs, setRuns] = useState<RunBrief[]>([])
  const [binSel, setBinSel] = useState<{ t: string; hits: TemplateHit[] } | null>(null)
  const [cluster, setCluster] = useState<ClusterDetail | null>(null)
  const [actor, setActor] = useState<ActorDetail | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Array<{ t: string; actor: string; text: string; tid: string | null }> | null>(null)
  const [blame, setBlame] = useState<{ question: string; agent: string | null; step: number | null; gold?: string; source: string } | null>(null)
  const [cases, setCases] = useState<Array<{ question: string; history: Array<{ name: string; content: string }>; gold_agent: string; source: string }>>([])
  const [spread, setSpread] = useState<SpreadRow[]>([])

  const streamPace = mode === 'scan' ? 0.015 : 0
  const stream = useRunStream(runId, streamPace)
  const alpha = Number(result?.params?.alpha ?? 0.01)

  useEffect(() => {
    if (!health.online) return
    api<DatasetInfo[]>('/api/datasets').then(setDatasets).catch(() => undefined)
    api<RunBrief[]>('/api/runs').then(setRuns).catch(() => undefined)
  }, [health.online, runId])

  useEffect(() => {
    // A deep link (/live?ds=…&start=…) wins over the preset once, on first render.
    if (linked && ds === linked && (params.get('start') || params.get('end'))) return
    const p = PRESETS[ds]
    setStart(p?.start ?? '')
    setEnd(p?.end ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds])

  // Poll the run snapshot (clusters / actors) while live; once more when done.
  useEffect(() => {
    if (!runId) return
    let live = true
    const pull = () =>
      api<{ result: RunResult | null }>(`/api/runs/${runId}`)
        .then((r) => live && r.result && setResult(r.result))
        .catch(() => undefined)
    pull()
    if (stream.done) return
    const id = setInterval(pull, 2500)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [runId, stream.done])

  useEffect(() => {
    if (!runId || !stream.done) {
      setSpread([])
      return
    }
    let live = true
    api<SpreadRow[]>(`/api/runs/${runId}/spread`)
      .then((rows) => live && setSpread(rows))
      .catch(() => live && setSpread([]))
    return () => {
      live = false
    }
  }, [runId, stream.done])

  const launch = useCallback(async () => {
    setErr(null)
    setBusy(true)
    setResult(null)
    setBinSel(null)
    setHits(null)
    setDossier(null)
    try {
      let brief: RunBrief
      if (mode === 'scan') {
        brief = await api<RunBrief>('/api/runs', { method: 'POST', json: { dataset: ds, start: start || undefined, end: end || undefined } })
        setIsMonitor(false)
      } else if (mode === 'replay') {
        const body =
          ds === 'synthetic'
            ? { synthetic: true, swarm_share: swarmShare, n_events: 30000, pace_s: pace, name: 'replay' }
            : { dataset: ds, start: start || undefined, end: end || undefined, pace_s: pace, name: 'replay', bins_per_step: ds === 'moltbook' ? 2 : 1 }
        brief = await api<RunBrief>('/api/live/replay', { method: 'POST', json: body })
        setIsMonitor(true)
      } else {
        if (feedUrl.trim())
          brief = await api<RunBrief>('/api/live/watch_url', {
            method: 'POST',
            json: { name: monName, url: feedUrl.trim(), interval_s: feedInterval, params: { freq: '10min', min_actors: 3, warmup: 12 } },
          })
        else if (watchPath) brief = await api<RunBrief>('/api/live/watch', { method: 'POST', json: { name: monName, path: watchPath } })
        else brief = (await api<{ run_id: string }>(`/api/live/${monName}/ingest`, { method: 'POST', json: { events: [] } }).then((r) => ({ id: r.run_id }))) as RunBrief
        setIsMonitor(true)
      }
      setRunId(null)
      requestAnimationFrame(() => setRunId(brief.id))
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }, [mode, ds, start, end, pace, swarmShare, monName, watchPath, feedUrl, feedInterval])

  const runBlame = async (question: string, history: Array<{ name: string; content: string }>, source: string, gold?: string) => {
    const out = await api<{ agent: string | null; step: number | null }>('/api/attribute', { method: 'POST', json: { history, question } })
    setBlame({ question, agent: out.agent, step: out.step, gold, source })
  }

  const loadCases = async () => {
    const pack = await api<{
      sample: { question: string; history: Array<{ name: string; content: string }>; source: string }
      whowhen: Array<{ question: string; history: Array<{ name: string; content: string }>; gold_agent: string; source: string }>
    }>('/api/cases')
    setCases(pack.whowhen)
    await runBlame(pack.sample.question, pack.sample.history, pack.sample.source)
  }

  const buildDossier = async () => {
    if (!runId) return
    setDossierBusy(true)
    try {
      setDossier(await api<Dossier>(`/api/runs/${runId}/dossier`))
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    } finally {
      setDossierBusy(false)
    }
  }

  const stop = async () => {
    if (isMonitor && runId) await api(`/api/live/${runId.replace(/^live-/, '')}/stop`, { method: 'POST' }).catch(() => undefined)
  }

  const explain = async (t: Tick) => {
    if (!runId) return
    const hits = await api<TemplateHit[]>(`/api/runs/${runId}/bin?t=${encodeURIComponent(t.t)}`).catch(() => [])
    setBinSel({ t: t.t, hits })
  }
  const openCluster = async (tid: string) => runId && setCluster(await api<ClusterDetail>(`/api/runs/${runId}/cluster/${encodeURIComponent(tid)}`))
  const openActor = async (a: string) => runId && setActor(await api<ActorDetail>(`/api/runs/${runId}/actor/${encodeURIComponent(a)}`))
  const doSearch = async () => runId && q.length >= 2 && setHits(await api(`/api/runs/${runId}/search?q=${encodeURIComponent(q)}`))

  const ticks = stream.ticks
  const last = ticks[ticks.length - 1]
  const processed = useMemo(() => ticks.reduce((s, t) => s + t.n, 0), [ticks])
  const nAlarms = ticks.filter((t) => t.alarm).length
  const landmarks = stream.landmarks.length ? stream.landmarks : result?.landmarks ?? []
  const live = runId && !stream.done && !stream.error
  const available = datasets.filter((d) => d.available && d.id !== 'whowhen')

  if (!health.online) {
    return (
      <div>
        <Header live={false} />
        <Panel className="mt-4">
          <div className="flex items-start gap-3">
            <Terminal className="mt-0.5 text-accent" size={18} />
            <div className="text-[13px] leading-relaxed text-fg-2">
              <div className="text-[15px] font-semibold text-fg">Start the local engine</div>
              The live console talks to <span className="mono text-fg">kollude serve</span> on 127.0.0.1:8787 (nothing leaves your machine).
              <pre className="mono mt-3 rounded-lg border border-line bg-void p-3 text-[12px] text-fg">uv run kollude serve</pre>
              <CliCard />
              <div className="mt-2 text-muted">This page reconnects automatically. Measured backtests work offline under <b>Backtests</b>.</div>
            </div>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div>
      <Header live={!!live} version={health.version} />
      <CliCard />

      <div className="mt-4 grid gap-4 xl:grid-cols-[340px_1fr]">
        {/* Controls */}
        <Panel>
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-line bg-void p-1 text-[12px]">
            {(
              [
                ['replay', 'Live replay', Radio],
                ['scan', 'Full scan', Zap],
                ['agents', 'Your agents', Bot],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cx('flex items-center justify-center gap-1 rounded-md py-1.5 transition', mode === m ? 'bg-panel-3 text-fg' : 'text-muted hover:text-fg-2')}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          {mode !== 'agents' && (
            <div className="space-y-3 text-[12.5px]">
              <label className="block">
                <span className="text-muted">Dataset</span>
                <select value={ds} onChange={(e) => setDs(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5">
                  {available.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                  {!available.some((d) => d.id === 'synthetic') && <option value="synthetic">Synthetic swarm (known onset)</option>}
                </select>
              </label>
              {ds !== 'synthetic' ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <label>
                      <span className="text-muted">From</span>
                      <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1" />
                    </label>
                    <label>
                      <span className="text-muted">To</span>
                      <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1" />
                    </label>
                  </div>
                  <div className="text-[11.5px] text-faint">{PRESETS[ds]?.note}</div>
                </>
              ) : mode === 'replay' ? (
                <label className="block">
                  <span className="text-muted">Swarm share of traffic: {(swarmShare * 100).toFixed(1)}%</span>
                  <input type="range" className="scrubber mt-2 w-full" min={0.005} max={0.15} step={0.005} value={swarmShare} onChange={(e) => setSwarmShare(+e.target.value)} />
                  <div className="mt-1 text-[11.5px] text-faint">{PRESETS.synthetic.note}</div>
                </label>
              ) : (
                <div className="text-[11.5px] text-faint">{PRESETS.synthetic.note} Same stream as <span className="mono">kollude scan synthetic</span>.</div>
              )}
              {mode === 'replay' && (
                <label className="block">
                  <span className="text-muted">Speed: {pace === 0 ? 'max' : `${(1 / pace).toFixed(1)} bins/s`}</span>
                  <input type="range" className="scrubber mt-2 w-full" min={0} max={0.5} step={0.05} value={0.5 - pace} onChange={(e) => setPace(+(0.5 - +e.target.value).toFixed(2))} />
                </label>
              )}
              <div className="text-[11.5px] leading-snug text-muted">
                {mode === 'replay'
                  ? 'Events are fed in bin by bin; the detector only ever sees the past — exactly what it would have flagged live.'
                  : 'Scans the dates above, then streams the timeline. Moltbook stays on the wave window so the full 1.7M posts are not loaded into memory. The labelled full-corpus numbers are on Backtests.'}
              </div>
            </div>
          )}

          {mode === 'agents' && (
            <div className="space-y-3 text-[12.5px]">
              <label className="block">
                <span className="text-muted">Monitor name</span>
                <input value={monName} onChange={(e) => setMonName(e.target.value.replace(/[^\w-]/g, ''))} className="mono mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1" />
              </label>
              <label className="block">
                <span className="flex items-center gap-1 text-muted">
                  <Globe size={12} /> Watch a public JSON feed (swarmchasing in the wild)
                </span>
                <input
                  value={feedUrl}
                  onChange={(e) => setFeedUrl(e.target.value)}
                  placeholder="https://…/api/posts?sort=new&limit=100"
                  className="mono mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1"
                />
                <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
                  <span>list, or {'{posts|data|items: [...]}'} · ≤ 8 MB · parsed as data only</span>
                  <span className="mono">
                    every{' '}
                    <input type="number" min={5} max={3600} value={feedInterval} onChange={(e) => setFeedInterval(Math.max(5, +e.target.value || 30))} className="w-12 rounded border border-line bg-panel-2 px-1 text-right" />
                    s
                  </span>
                </div>
              </label>
              <label className="block">
                <span className="text-muted">…or tail a JSONL log (absolute path)</span>
                <input value={watchPath} onChange={(e) => setWatchPath(e.target.value)} placeholder="C:\logs\agents.jsonl" className="mono mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1" />
              </label>
              <div className="text-muted">…or push events from your swarm:</div>
              <pre className="mono overflow-x-auto rounded-lg border border-line bg-void p-2.5 text-[10.5px] leading-relaxed text-fg-2">{`import httpx
httpx.post("http://127.0.0.1:8787/api/live/${monName}/ingest",
  json={"events": [{"agent": "a1", "text": "...",
                    "timestamp": "2026-10-03T12:00:00Z"}]})`}</pre>
              <div className="text-[11.5px] text-faint">Agents can also call the MCP tools: <span className="mono">kollude mcp</span></div>
              <button type="button" onClick={() => loadCases().catch((e) => setErr(String((e as Error).message ?? e)))} className="w-full rounded-md border border-line-2 px-2 py-1.5 text-left text-[12px] text-fg-2 hover:bg-panel-2">
                Blame a failure — sample fixture, plus Who&When if the parquet is on disk
              </button>
              {blame && (
                <div className="rounded-md border border-line px-2 py-2 text-[12px]">
                  <div className="text-muted">{blame.source}</div>
                  <div className="mt-1 text-fg-2">{blame.question}</div>
                  <div className="mono mt-1 text-fg">
                    blamed {blame.agent ?? '—'} · step {blame.step ?? '—'}
                    {blame.gold ? <span className="text-muted"> · gold {blame.gold}</span> : null}
                  </div>
                </div>
              )}
              {cases.length > 0 && (
                <div className="space-y-1">
                  {cases.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => runBlame(c.question, c.history, c.source, c.gold_agent).catch((e) => setErr(String((e as Error).message ?? e)))}
                      className="block w-full truncate rounded-md px-2 py-1 text-left text-[11.5px] text-fg-2 hover:bg-panel-2"
                    >
                      Who&When · {c.gold_agent} · {c.question}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy || (mode !== 'agents' && !available.length && ds !== 'synthetic')}
              onClick={launch}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent-2 px-3 py-2 text-[13px] font-medium text-white transition hover:bg-accent disabled:opacity-50"
            >
              <Play size={14} /> {busy ? 'Starting…' : mode === 'agents' ? 'Open monitor' : 'Run'}
            </button>
            {isMonitor && live && (
              <button type="button" onClick={stop} className="flex items-center gap-1 rounded-lg border border-line-2 px-3 py-2 text-[13px] text-fg-2 hover:bg-panel-2">
                <Square size={13} /> Stop
              </button>
            )}
          </div>
          {err && <div className="mono mt-2 rounded-md border border-crit/40 bg-crit/10 p-2 text-[11px] text-serious">{err}</div>}

          {runs.length > 0 && (
            <div className="mt-5">
              <div className="mono mb-1 text-[10px] uppercase tracking-[0.14em] text-faint">Recent runs</div>
              <div className="space-y-1">
                {runs.slice(0, 6).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setIsMonitor(r.kind === 'monitor')
                      setRunId(r.id)
                    }}
                    className={cx('flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[11.5px] hover:bg-panel-2', r.id === runId && 'bg-panel-3')}
                  >
                    <span className="mono truncate text-fg-2">
                      {r.source} <span className="text-faint">· {r.kind}</span>
                    </span>
                    <span className={cx('mono', r.status === 'error' ? 'text-serious' : 'text-muted')}>{r.n_alarms ?? '·'} al</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>

        {/* Stage */}
        <div className="min-w-0 space-y-4">
          <Panel>
            <PanelHeader eyebrow="labelled · baseline next to every score" title="Where the detector is actually strong" />
            <div className="grid gap-2 sm:grid-cols-3">
              <Score n="0.913" ci="[0.912, 0.915]" label="Moltbook agent AUROC" vs="dup-fraction 0.737 · post-count 0.595" />
              <Score n="0.799" ci="[0.798, 0.801]" label="Moltbook post AUROC" vs="exact-dup 0.593 · volume 0.420" />
              <Score n="0.569" ci="[0.441, 0.688]" label="Who&When hand, agent acc" vs="last-agent 0.603 still higher" weak />
            </div>
            <p className="mt-2 text-[11.5px] leading-snug text-muted">
              mbc-20 marker was never shown to the engine (1,678,764 posts). The platform is_spam flag is a weaker target (post AUROC 0.564) and is not this headline. Who&When has no LLM and does not beat the last-agent baseline on the hand-written split.
            </p>
          </Panel>
          <Panel>
            <PanelHeader eyebrow="identities as a flock" title={result?.clusters?.length ? `${result.clusters.length} coordinated flocks` : 'Agents in the open'} />
            <Flock clusters={result?.clusters ?? []} actors={result?.actors ?? []} onActor={openActor} />
          </Panel>
          <Panel>
            <PanelHeader
              eyebrow="who moved first"
              title={spread.length ? `${spread.length} lines that reached other actors` : 'Spread'}
            />
            {spread.length ? (
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-faint">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Hours</th>
                      <th className="py-1 pr-3 font-medium">Actors</th>
                      <th className="py-1 pr-3 font-medium">First</th>
                      <th className="py-1 pr-3 font-medium">Carriers</th>
                      <th className="py-1 font-medium">Template</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spread.map((row) => (
                      <tr key={row.tid} className="border-t border-line">
                        <td className="mono py-1.5 pr-3">{row.hours_to_min_actors.toFixed(1)}</td>
                        <td className="mono py-1.5 pr-3">{row.n_actors}</td>
                        <td className="py-1.5 pr-3">{row.seeder}</td>
                        <td className="py-1.5 pr-3 text-muted">{row.carriers.slice(0, 6).join(', ')}</td>
                        <td className="max-w-[280px] truncate py-1.5 text-fg-2">{row.template}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyNote>After a run finishes, this lists who posted a shared line first, how many hours until enough others copied it, and who carried it.</EmptyNote>
            )}
          </Panel>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile
              label="Events processed"
              value={fmtN(processed)}
              sub={
                stream.poll
                  ? stream.poll.error
                    ? `poll error: ${stream.poll.error.slice(0, 40)}`
                    : `poll #${stream.polls}: +${stream.poll.new ?? 0} new of ${stream.poll.rows ?? 0}`
                  : stream.nEvents
                    ? `of ${fmtN(stream.nEvents)}`
                    : (stream.stage ?? 'idle')
              }
              icon={Database}
              accent="#6aa8ff"
            />
            <StatTile label="Bins scored" value={fmtN(ticks.length)} sub={last ? last.t.slice(0, 16).replace('T', ' ') : '—'} icon={Activity} accent="#6aa8ff" />
            <StatTile label="Alarms" value={<span className={nAlarms ? 'text-red-glow' : ''}>{nAlarms}</span>} sub={`α = ${alpha} · ARL ≥ ${Math.round(1 / alpha)} bins`} icon={Zap} accent="#ff5a5a" />
            <StatTile label="Coordinated share" value={last ? (last.C ?? 0).toFixed(3) : '—'} sub={last ? `M ${(last.M ?? 0).toFixed(1)} actors / template` : '—'} />
            <StatTile label="Evidence log₁₀ S" value={last ? (last.log10_S ?? 0).toFixed(2) : '—'} sub={`alarm at ${Math.log10(1 / alpha).toFixed(1)}`} />
          </div>

          <Panel>
            <PanelHeader
              eyebrow={live ? 'streaming' : stream.done ? 'complete' : 'timeline'}
              title={runId ? `${result?.source ?? ''} — coordination & evidence` : 'Pick a source and press Run'}
              right={
                ticks.some((t) => t.label_rate != null) ? (
                  <span className="mono text-[11px] text-warn">— — label share (ground truth)</span>
                ) : null
              }
            />
            {ticks.length ? (
              <LiveChart ticks={ticks} alpha={alpha} landmarks={landmarks} selected={binSel?.t} onSelect={explain} />
            ) : (
              <EmptyNote>{runId ? `${stream.stage ?? 'connecting'}…` : 'Live chart appears here. Click any bin to see which templates drove it.'}</EmptyNote>
            )}
            {stream.error && <div className="mono mt-2 text-[11.5px] text-serious">{stream.error}</div>}
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="standard questions · answered from data"
              title="Swarm dossier"
              right={
                runId ? (
                  <div className="flex items-center gap-2">
                    {dossier && (
                      <a
                        href={`${API}/api/runs/${runId}/dossier?format=md`}
                        download={`kollude-dossier-${runId}.md`}
                        className="mono flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-[11px] text-fg-2 hover:bg-panel-2"
                      >
                        <Download size={12} /> .md
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={buildDossier}
                      disabled={dossierBusy || ticks.length === 0}
                      className="mono flex items-center gap-1 rounded-md bg-accent-2 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-40"
                    >
                      <FileText size={12} /> {dossierBusy ? 'building…' : dossier ? 'rebuild' : 'build dossier'}
                    </button>
                  </div>
                ) : null
              }
            />
            {!dossier && (
              <EmptyNote>
                The same questionnaire for every group — size, rhythm, burstiness, multiplicity, naming, onset, spread, seeder, regime change, topics — each
                answered with a baseline next to it. Build it once bins have been scored; works mid-stream too.
              </EmptyNote>
            )}
            {dossier && (
              <Boundary>
                <DossierCards d={dossier} onCluster={openCluster} onActor={openActor} />
              </Boundary>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader eyebrow="anytime-valid" title="Alarm feed" right={<span className="mono text-[11px] text-muted">{stream.alarms.length}</span>} />
              <div className="scroll-thin max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {stream.alarms.length === 0 && <EmptyNote>No alarms yet. Each alarm needs coordinated content (C) and many identities (M ≥ m_min).</EmptyNote>}
                {stream.alarms.map((a) => (
                  <button key={a.t} type="button" onClick={() => setBinSel({ t: a.t, hits: a.templates })} className="flash-in block w-full rounded-lg border border-crit/30 px-3 py-2 text-left hover:bg-panel-2">
                    <div className="mono flex justify-between text-[11px]">
                      <span className="text-red-glow">{a.t.replace('T', ' ').slice(0, 16)}</span>
                      <span className="text-muted">
                        C {(a.C ?? 0).toFixed(2)} · M {(a.M ?? 0).toFixed(1)} · S {fmtN(a.S)}
                      </span>
                    </div>
                    {a.templates[0] && <div className="mono mt-1 truncate text-[11.5px] text-fg-2">{a.templates[0].template}</div>}
                  </button>
                ))}
              </div>
            </Panel>

            <Panel>
              <PanelHeader eyebrow="click a bin" title={binSel ? `Why ${binSel.t.replace('T', ' ').slice(0, 16)}?` : 'Bin inspector'} />
              {!binSel && <EmptyNote>Click the chart or an alarm to see the coordinated templates in that bin.</EmptyNote>}
              {binSel && binSel.hits.length === 0 && <EmptyNote>No template reached min_actors in this bin.</EmptyNote>}
              <div className="scroll-thin max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {binSel?.hits.map((h) => (
                  <button key={h.tid} type="button" onClick={() => openCluster(h.tid)} className="block w-full rounded-lg border border-line px-3 py-2 text-left hover:border-line-2 hover:bg-panel-2">
                    <div className="mono flex justify-between text-[11px] text-muted">
                      <span>{h.n_actors} actors</span>
                      <span>{h.n_events} events</span>
                    </div>
                    <div className="mono mt-1 text-[11.5px] text-fg">{h.template}</div>
                  </button>
                ))}
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Panel>
              <PanelHeader eyebrow="many identities · one template" title="Coordinated clusters" right={<span className="mono text-[11px] text-muted">{result?.clusters.length ?? 0}</span>} />
              <ClusterTable rows={result?.clusters ?? []} onOpen={openCluster} />
            </Panel>
            <Panel>
              <PanelHeader eyebrow="coord_frac × log cluster size" title="Most coordinated actors" />
              <ActorTable rows={result?.actors ?? []} onOpen={openActor} />
            </Panel>
          </div>

          <Panel>
            <PanelHeader eyebrow="substring" title="Search this run" />
            <div className="flex gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-md border border-line bg-panel-2 px-2">
                <Search size={14} className="text-muted" />
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} placeholder="e.g. mint, airdrop, wallet" className="w-full bg-transparent py-1.5 text-[13px] outline-none" />
              </div>
              <button type="button" onClick={doSearch} disabled={!runId} className="rounded-md border border-line-2 px-3 text-[12.5px] text-fg-2 hover:bg-panel-2 disabled:opacity-40">
                Search
              </button>
            </div>
            {hits && (
              <div className="scroll-thin mt-3 max-h-[280px] space-y-2 overflow-y-auto">
                {hits.length === 0 && <EmptyNote>No matches.</EmptyNote>}
                {hits.map((h, i) => (
                  <div key={i} className="rounded-md border border-line px-3 py-2">
                    <div className="mono mb-1 flex justify-between text-[10.5px] text-muted">
                      <button type="button" className="text-accent hover:underline" onClick={() => openActor(h.actor)}>
                        {h.actor}
                      </button>
                      <span>{h.t.slice(0, 16).replace('T', ' ')}</span>
                    </div>
                    <Excerpt text={h.text} />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      {cluster && (
        <Drawer title={<span className="mono text-[13px]">{cluster.template}</span>} onClose={() => setCluster(null)}>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Mini label="actors" v={fmtN(cluster.n_actors)} />
            <Mini label="events" v={fmtN(cluster.n_events)} />
            <Mini label="label share" v={cluster.label_rate == null ? '—' : cluster.label_rate.toFixed(2)} />
          </div>
          <div className="mono mb-1 text-[10px] uppercase tracking-[0.14em] text-faint">hourly volume</div>
          <Spark data={cluster.hourly} />
          <div className="mono mb-1 mt-4 text-[10px] uppercase tracking-[0.14em] text-faint">top actors</div>
          <div className="flex flex-wrap gap-1">
            {cluster.top_actors.map((a) => (
              <button key={a.actor} type="button" onClick={() => openActor(a.actor)} className="mono rounded border border-line px-1.5 py-0.5 text-[10.5px] text-fg-2 hover:border-accent">
                {a.actor.slice(0, 18)} ×{a.n}
              </button>
            ))}
          </div>
          <div className="mono mb-1 mt-4 text-[10px] uppercase tracking-[0.14em] text-faint">events (untrusted text)</div>
          <div className="space-y-2">
            {cluster.events.map((e, i) => (
              <div key={i} className="rounded-md border border-line px-3 py-2">
                <div className="mono mb-1 flex justify-between text-[10.5px] text-muted">
                  <span>{e.actor}</span>
                  <span>{e.t.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <Excerpt text={e.text} />
              </div>
            ))}
          </div>
        </Drawer>
      )}

      {actor && (
        <Drawer title={<span className="mono">{actor.actor}</span>} onClose={() => setActor(null)}>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Mini label="events" v={fmtN(actor.n_events)} />
            <Mini label="coordinated" v={actor.coord_frac == null ? '—' : `${(actor.coord_frac * 100).toFixed(0)}%`} />
            <Mini label="label share" v={actor.label_rate == null ? '—' : actor.label_rate.toFixed(2)} />
          </div>
          <div className="mono text-[11px] text-muted">
            {actor.first_t?.slice(0, 16)} → {actor.last_t?.slice(0, 16)}
          </div>
          <div className="mono mb-1 mt-4 text-[10px] uppercase tracking-[0.14em] text-faint">shares templates with</div>
          <div className="flex flex-wrap gap-1">
            {actor.co_actors.length === 0 && <span className="text-[12px] text-muted">nobody — organic</span>}
            {actor.co_actors.map((a) => (
              <button key={a.actor} type="button" onClick={() => openActor(a.actor)} className="mono rounded border border-line px-1.5 py-0.5 text-[10.5px] text-fg-2 hover:border-accent">
                {a.actor.slice(0, 18)} ×{a.shared_events}
              </button>
            ))}
          </div>
          <div className="mono mb-1 mt-4 text-[10px] uppercase tracking-[0.14em] text-faint">timeline</div>
          <div className="space-y-2">
            {actor.events.map((e, i) => (
              <div key={i} className={cx('rounded-md border px-3 py-2', e.coordinated ? 'border-crit/35' : 'border-line')}>
                <div className="mono mb-1 flex justify-between text-[10.5px] text-muted">
                  <span>{e.coordinated ? <span className="text-red-glow">coordinated</span> : 'organic'}</span>
                  <span>{e.t.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <Excerpt text={e.text} />
                {e.coordinated && e.tid && (
                  <button type="button" className="mono mt-1 text-[10.5px] text-accent hover:underline" onClick={() => openCluster(e.tid!)}>
                    open cluster →
                  </button>
                )}
              </div>
            ))}
          </div>
        </Drawer>
      )}
    </div>
  )
}

function Score({ n, ci, label, vs, weak }: { n: string; ci: string; label: string; vs: string; weak?: boolean }) {
  return (
    <div className={cx('rounded-lg border px-3 py-2', weak ? 'border-line' : 'border-good/30')}>
      <div className="mono text-[10px] uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className={cx('mt-0.5 font-semibold tabular-nums', weak ? 'text-fg' : 'text-[#4cc94c]')}>
        {n} <span className="text-[12px] font-normal text-muted">{ci}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted">{vs}</div>
    </div>
  )
}

function CliCard() {
  return (
    <details open className="mt-4 rounded-xl border border-line bg-panel px-4 py-3">
      <summary className="cursor-pointer text-[13px] font-medium text-fg">Terminal — run all of this on synthetic data</summary>
      <p className="mt-2 text-[12.5px] text-muted">
        Cursor: Terminal → New Terminal. You should be in the repo folder. <span className="mono text-fg-2">kollude demo</span> writes the fixture files and runs every command that finishes by itself. <span className="mono">watch</span>, <span className="mono">watch-url</span>, <span className="mono">serve</span>, and <span className="mono">mcp</span> stay open until Ctrl+C.
      </p>
      <pre className="mono mt-2 overflow-x-auto rounded-lg border border-line bg-void p-3 text-[12px] leading-relaxed text-fg">{CLI_COMMANDS}</pre>
      <pre className="mono mt-2 overflow-x-auto rounded-lg border border-line bg-void p-3 text-[11.5px] leading-relaxed text-fg-2">{`# second terminal, then watch-url in the first
# 8877 — skip 8765 if another local app already owns it
uv run python -m http.server 8877 --directory kollude/fixtures
uv run kollude watch-url http://127.0.0.1:8877/feed.json --interval 2`}</pre>
    </details>
  )
}

function Header({ live, version }: { live: boolean; version?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-fg">Live swarm detector</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-muted">
          Stream real agent data through the kollude engine: near-duplicate templates across many identities (C × M), scored by an anytime-valid e-detector
          whose false-alarm rate is bounded by α. Click anything to drill in.
        </p>
      </div>
      <span
        className={cx(
          'mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
          version ? 'border-good/40 text-[#4cc94c]' : 'border-line-2 text-muted',
        )}
      >
        <span className={cx('h-1.5 w-1.5 rounded-full', version ? 'bg-[#4cc94c]' : 'bg-faint', live && 'pulse-dot')} />
        {version ? `engine v${version}${live ? ' · streaming' : ''}` : 'engine offline'}
      </span>
    </div>
  )
}

class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { err: String((e as Error).message ?? e) }
  }
  render() {
    if (this.state.err) return <div className="mono rounded-md border border-crit/40 bg-crit/10 p-2 text-[11px] text-serious">render error: {this.state.err}</div>
    return this.props.children
  }
}

function DossierCards({ d, onCluster, onActor }: { d: Dossier; onCluster: (tid: string) => void; onActor: (a: string) => void }) {
  const verdictHot = /signature present/i.test(d.verdict)
  const qs = d.questions.filter((q) => q.id !== 'verdict')
  return (
    <div>
      <div className={cx('mb-3 rounded-lg border px-3 py-2.5 text-[13px] leading-snug', verdictHot ? 'border-crit/40 bg-crit/10 text-fg' : 'border-good/40 bg-good/10 text-fg')}>
        <span className="mono mr-2 text-[10px] uppercase tracking-[0.14em] text-muted">verdict</span>
        {d.verdict}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {qs.map((q) => {
          const v = q.value as Record<string, any>
          const pz = q.id === 'onset' ? (v.patient_zero as { first_actors?: string[]; tid?: string } | undefined) : undefined
          const largest = q.id === 'multiplicity' ? (v.largest as { tid?: string } | undefined) : undefined
          const baseline = fmtBaseline(q.baseline)
          return (
            <div key={q.id} className={cx('rounded-lg border px-3 py-2.5', q.flag ? 'border-warn/50' : 'border-line')}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-[12.5px] font-medium text-fg">{q.question}</div>
                {q.flag && (
                  <span className="mono flex shrink-0 items-center gap-1 rounded-full border border-warn/50 px-1.5 py-0.5 text-[10px] text-warn">
                    <Flag size={10} /> {q.flag}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[12px] leading-snug text-fg-2">{q.answer}</div>
              {(baseline || q.method) && (
                <div className="mono mt-1.5 text-[10.5px] text-faint">
                  {baseline && <span>baseline: {baseline}</span>}
                  {baseline && q.method && ' · '}
                  {q.method && <span>{q.method}</span>}
                </div>
              )}
              {(pz?.first_actors?.length || largest?.tid) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {largest?.tid && (
                    <button type="button" onClick={() => onCluster(largest.tid!)} className="mono rounded border border-line px-1.5 py-0.5 text-[10.5px] text-accent hover:border-accent">
                      open largest cluster →
                    </button>
                  )}
                  {pz?.tid && (
                    <button type="button" onClick={() => onCluster(pz.tid!)} className="mono rounded border border-line px-1.5 py-0.5 text-[10.5px] text-accent hover:border-accent">
                      dominant template →
                    </button>
                  )}
                  {pz?.first_actors?.slice(0, 5).map((a) => (
                    <button key={a} type="button" onClick={() => onActor(a)} className="mono rounded border border-line px-1.5 py-0.5 text-[10.5px] text-fg-2 hover:border-accent">
                      {a.slice(0, 20)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 text-[10.5px] text-faint">{d.note}</div>
    </div>
  )
}

function Mini({ label, v }: { label: string; v: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2 py-2">
      <div className="text-[17px] font-semibold text-fg">{v}</div>
      <div className="mono text-[10px] uppercase tracking-wider text-muted">{label}</div>
    </div>
  )
}

function ClusterTable({ rows, onOpen }: { rows: Cluster[]; onOpen: (tid: string) => void }) {
  if (!rows.length) return <EmptyNote>Clusters appear as soon as ≥ min_actors identities share a template.</EmptyNote>
  const max = Math.max(...rows.map((r) => r.n_actors))
  return (
    <div className="scroll-thin max-h-[420px] overflow-y-auto">
      <table className="w-full text-left text-[12px]">
        <thead className="mono sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-faint">
          <tr>
            <th className="py-1 pr-2">actors</th>
            <th className="pr-2">events</th>
            <th className="pr-2">span</th>
            <th>template</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tid} onClick={() => onOpen(r.tid)} className="cursor-pointer border-t border-line hover:bg-panel-2">
              <td className="py-1.5 pr-2">
                <div className="mono text-fg">{fmtN(r.n_actors)}</div>
                <div className="mt-0.5 h-1 rounded bg-crit/70" style={{ width: `${(r.n_actors / max) * 60 + 4}px` }} />
              </td>
              <td className="mono pr-2 text-fg-2">{fmtN(r.n_events)}</td>
              <td className="mono pr-2 text-muted">{r.span_h == null ? '—' : `${r.span_h.toFixed(0)}h`}</td>
              <td className="mono max-w-0 truncate text-fg-2" title={r.template}>
                {r.template}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ActorTable({ rows, onOpen }: { rows: ActorRow[]; onOpen: (a: string) => void }) {
  if (!rows.length) return <EmptyNote>No actors scored yet.</EmptyNote>
  return (
    <div className="scroll-thin max-h-[420px] overflow-y-auto">
      <table className="w-full text-left text-[12px]">
        <thead className="mono sticky top-0 bg-panel text-[10px] uppercase tracking-wider text-faint">
          <tr>
            <th className="py-1 pr-2">actor</th>
            <th className="pr-2">score</th>
            <th className="pr-2">coord</th>
            <th>events</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.actor} onClick={() => onOpen(r.actor)} className="cursor-pointer border-t border-line hover:bg-panel-2">
              <td className="mono max-w-[140px] truncate py-1.5 pr-2 text-fg" title={r.actor}>
                {r.actor}
              </td>
              <td className="mono pr-2 text-fg-2">{(r.score ?? 0).toFixed(2)}</td>
              <td className="mono pr-2 text-muted">{((r.coord_frac ?? 0) * 100).toFixed(0)}%</td>
              <td className="mono text-muted">{fmtN(r.n_events)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
