import { useEffect, useState } from 'react'

/** Resolve a data path against the deploy base so static hosting on any subpath works. */
export function dataUrl(path: string): string {
  const base = import.meta.env.BASE_URL || './'
  return `${base.replace(/\/$/, '')}/data/${path.replace(/^\/?(data\/)?/, '')}`
}

const cache = new Map<string, Promise<unknown>>()

export function loadJson<T>(path: string): Promise<T> {
  const url = dataUrl(path)
  let p = cache.get(url) as Promise<T> | undefined
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`)
      return res.json() as Promise<T>
    })
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T }

/** Load one JSON file; re-fetches when `path` changes. Pass null to skip. */
export function useJson<T>(path: string | null): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' })
  useEffect(() => {
    if (!path) return
    let live = true
    setState({ status: 'loading' })
    loadJson<T>(path)
      .then((data) => live && setState({ status: 'ready', data }))
      .catch((e: unknown) => live && setState({ status: 'error', error: String(e) }))
    return () => {
      live = false
    }
  }, [path])
  return state
}

/** IDs differ across exports ("forge:Big" vs "forge-Big"); normalize to the file slug. */
export function agentSlug(id: string): string {
  return id.replace(/:/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-')
}

export function agentLabel(id: string): string {
  const parts = id.split(/[:-]/)
  return parts.length > 1 && parts[0] === 'forge' ? parts.slice(1).join('-') : id
}
