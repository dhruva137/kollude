import { useMemo } from 'react'
import type { StrainData, StrainIndex, SwarmEdge, SwarmMap, SwarmNode } from '../types'
import { agentSlug, useJson, type Loadable } from './loadData'

export interface AgentState extends SwarmNode {
  slug: string
  /** first time this agent asserted the primary (planted) strain, ms; null = never */
  adoptedAt: number | null
  isPatientZero: boolean
  nClaimsInStrain: number
}

export interface Episode {
  map: SwarmMap
  strain: StrainData
  strainIndex: StrainIndex
  t0: number
  t1: number
  agents: AgentState[]
  agentById: Map<string, AgentState>
  /** cross-agent edges only (self-loops are within-agent repeats, kept separately) */
  edges: SwarmEdge[]
  selfLoops: number
  patientZero: string
}

/** Loads swarm map + strain index + the primary strain and derives outbreak state. */
export function useEpisode(): Loadable<Episode> {
  const map = useJson<SwarmMap>('swarm_map.json')
  const idx = useJson<StrainIndex>('strains/index.json')
  const primaryFile = idx.status === 'ready' ? idx.data.strains[0]?.file : null
  const strain = useJson<StrainData>(primaryFile ? `strains/${primaryFile}` : null)

  return useMemo<Loadable<Episode>>(() => {
    for (const s of [map, idx, strain]) {
      if (s.status === 'error') return { status: 'error', error: s.error }
    }
    if (map.status !== 'ready' || idx.status !== 'ready' || strain.status !== 'ready')
      return { status: 'loading' }

    const m = map.data
    const st = strain.data
    const t0 = Date.parse(m.t_min)
    const t1 = Date.parse(m.t_max)

    const firstAdopt = new Map<string, number>()
    const count = new Map<string, number>()
    for (const mem of st.members) {
      const id = agentSlug(mem.agent_id)
      const t = Date.parse(mem.t)
      count.set(id, (count.get(id) ?? 0) + 1)
      if (!firstAdopt.has(id) || t < firstAdopt.get(id)!) firstAdopt.set(id, t)
    }
    const pz = agentSlug(st.origin.agent_id)

    const agents: AgentState[] = m.nodes
      .map((n) => ({
        ...n,
        slug: agentSlug(n.id),
        adoptedAt: firstAdopt.get(agentSlug(n.id)) ?? null,
        isPatientZero: agentSlug(n.id) === pz,
        nClaimsInStrain: count.get(agentSlug(n.id)) ?? 0,
      }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role) || natural(a.label, b.label))

    const edges = m.edges.filter((e) => e.src !== e.dst)
    return {
      status: 'ready',
      data: {
        map: m,
        strain: st,
        strainIndex: idx.data,
        t0,
        t1: Math.max(t1, ...st.members.map((x) => Date.parse(x.t))),
        agents,
        agentById: new Map(agents.map((a) => [a.slug, a])),
        edges,
        selfLoops: m.edges.length - edges.length,
        patientZero: pz,
      },
    }
  }, [map, idx, strain])
}

export function roleRank(role: string): number {
  return { coordinator: 0, orchestrator: 0, relay: 1, worker: 2 }[role] ?? 3
}

export function natural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

export const ROLE_LABEL: Record<string, string> = {
  coordinator: 'Coordinator',
  orchestrator: 'Coordinator',
  relay: 'Relay',
  worker: 'Worker',
}
