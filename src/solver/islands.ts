import { SolveInput } from './spec'

export interface IslandPlan {
  buses: string[]
  /** Reference bus id, or null when the island has no source (de-energized). */
  reference: string | null
  /** True when the reference is a generator bus (droop/frequency island). */
  genRef: boolean
}

/**
 * Split the network into energized islands from breaker states: a branch
 * conducts only when all of its breakers are closed. Each island containing
 * the grid slack is referenced there; an island with only a generator uses
 * the generator bus as reference; anything else is dead.
 */
export function findIslands(input: SolveInput): IslandPlan[] {
  const parent = new Map<string, string>()
  for (const b of input.buses) parent.set(b.id, b.id)

  const find = (x: string): string => {
    let r = x
    while (parent.get(r)! !== r) r = parent.get(r)!
    // path compression
    let c = x
    while (parent.get(c)! !== c) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b))
  }

  for (const l of input.lines) {
    if (l.brkFrom === false || l.brkTo === false) continue
    union(l.from, l.to)
  }
  for (const t of input.transformers) {
    if (t.brkClosed === false) continue
    union(t.hv, t.lv)
  }

  const groups = new Map<string, string[]>()
  for (const b of input.buses) {
    const r = find(b.id)
    const g = groups.get(r)
    if (g) g.push(b.id)
    else groups.set(r, [b.id])
  }

  return [...groups.values()].map((buses) => {
    const set = new Set(buses)
    if (set.has(input.slackBusId)) {
      // A solitary slack bus (its only branch opened) is the external grid
      // equivalent, now separated — it displays de-energized.
      if (buses.length === 1) {
        return { buses, reference: null, genRef: false }
      }
      return { buses, reference: input.slackBusId, genRef: false }
    }
    const gen = input.gens.find((g) => set.has(g.bus))
    if (gen) return { buses, reference: gen.bus, genRef: true }
    return { buses, reference: null, genRef: false }
  })
}
