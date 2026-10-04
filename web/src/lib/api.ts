import { useEffect, useRef, useState } from 'react'

/** kollude local API (``kollude serve`` → 127.0.0.1:8787; Vite dev proxies /api). */
export const API = (import.meta.env.VITE_KOLLUDE_API as string | undefined) ?? ''

export type Tick = {
  t: string
  n: number
  actors: number
  C: number | null
  M: number | null
  coord: number
  p: number | null
  log10_S: number | null
  alarm: boolean
  label_rate: number | null
}

export type TemplateHit = { tid: string; template: string; n_actors: number; n_events: number; sample: string }

export type Alarm = {
  t: string
  S: number | null
  C: number | null
  M: number | null
  n_events: number
  label_rate?: number | null
  templates: TemplateHit[]
}

export type Cluster = {
  tid: string
  template: string
  n_events: number
  n_actors: number
  first_t: string
  last_t: string
  span_h: number | null
  label_rate: number | null
  burst?: number | null
  sample: string
}

export type SpreadRow = {
  tid: string
  template: string
  channel: string | null
  seeder: string
  t0: string
  hours_to_min_actors: number
  n_actors: number
  n_events: number
  carriers: string[]
}

export type ActorRow = {
  actor: string
  n_events: number
  coord_frac: number | null
  max_cluster: number | null
  score: number | null
  dup_frac: number | null
  label_rate: number | null
}

export type Landmark = { t: string; label: string; kind: string }

export type RunResult = {
  params: Record<string, unknown>
  summary: Record<string, number | string | boolean | null>
  timeline: Tick[]
  alarms: Alarm[]
  clusters: Cluster[]
  actors: ActorRow[]
  timings?: Record<string, number>
  landmarks?: Landmark[]
  source?: string
}

export type RunBrief = {
  id: string
  kind: string
  source: string
  status: string
  created: number
  n_events: number | null
  n_alarms: number | null
  error: string | null
}

export type DatasetInfo = {
  id: string
  title: string
  description: string
  url: string
  labels: string
  available: boolean
  size_hint: string
  requires_token: boolean
  landmarks: Landmark[]
  defaults: Record<string, unknown>
  fetch?: { status: string; error?: string } | null
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!res.ok) {
    let msg = `${res.status}`
    try {
      const j = await res.json()
      msg = j.detail ?? JSON.stringify(j)
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

/** Poll /api/health; `online` flips as `kollude serve` starts/stops. */
export function useApiHealth(intervalMs = 4000) {
  const [state, setState] = useState<{ online: boolean; version?: string }>({ online: false })
  useEffect(() => {
    let live = true
    const ping = () =>
      api<{ ok: boolean; version: string }>('/api/health')
        .then((h) => live && setState({ online: h.ok, version: h.version }))
        .catch(() => live && setState({ online: false }))
    ping()
    const id = setInterval(ping, intervalMs)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [intervalMs])
  return state
}

export type Poll = { url: string; rows?: number; new?: number; t?: string; error?: string }

export type DossierQ = {
  id: string
  question: string
  answer: string
  value: Record<string, unknown>
  baseline: string | Record<string, unknown> | null
  method: string | null
  flag: string | null
}

export function fmtBaseline(b: DossierQ['baseline']): string | null {
  if (b == null) return null
  if (typeof b === 'string') return b
  return Object.entries(b)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} = ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v)}`)
    .join(' · ')
}

export type Dossier = {
  questions: DossierQ[]
  verdict: string
  flags: string[]
  landmarks: Landmark[]
  params: Record<string, unknown>
  note: string
}

export type StreamState = {
  stage: string | null
  ticks: Tick[]
  alarms: Alarm[]
  done: boolean
  error: string | null
  nEvents: number | null
  landmarks: Landmark[]
  poll: Poll | null
  polls: number
}

const EMPTY: StreamState = { stage: null, ticks: [], alarms: [], done: false, error: null, nEvents: null, landmarks: [], poll: null, polls: 0 }

/** Subscribe to a run's SSE stream. Ticks are batched per animation frame. */
export function useRunStream(runId: string | null, pace: number) {
  const [state, setState] = useState<StreamState>(EMPTY)
  const buf = useRef<{ ticks: Tick[]; alarms: Alarm[] }>({ ticks: [], alarms: [] })
  useEffect(() => {
    setState(EMPTY)
    buf.current = { ticks: [], alarms: [] }
    if (!runId) return
    const es = new EventSource(`${API}/api/runs/${runId}/stream?pace=${pace}`)
    let raf = 0
    const flush = () => {
      raf = 0
      const { ticks, alarms } = buf.current
      if (!ticks.length && !alarms.length) return
      buf.current = { ticks: [], alarms: [] }
      setState((s) => ({ ...s, ticks: s.ticks.concat(ticks), alarms: alarms.length ? alarms.reverse().concat(s.alarms) : s.alarms }))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush)
    }
    es.addEventListener('tick', (e) => {
      buf.current.ticks.push(JSON.parse((e as MessageEvent).data))
      schedule()
    })
    es.addEventListener('alarm', (e) => {
      buf.current.alarms.push(JSON.parse((e as MessageEvent).data))
      schedule()
    })
    es.addEventListener('stage', (e) => {
      const d = JSON.parse((e as MessageEvent).data)
      setState((s) => ({ ...s, stage: d.name, nEvents: d.n_events ?? s.nEvents, landmarks: d.landmarks ?? s.landmarks }))
    })
    es.addEventListener('poll', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as Poll
      setState((s) => ({ ...s, poll: d, polls: s.polls + 1 }))
    })
    es.addEventListener('done', () => {
      flush()
      setState((s) => ({ ...s, done: true, stage: 'done' }))
      es.close()
    })
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) {
        setState((s) => ({ ...s, error: JSON.parse(data).error ?? 'stream error' }))
        es.close()
      }
    })
    return () => {
      es.close()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [runId, pace])
  return state
}
