import { SolveInput } from '../solver/spec'

/**
 * UI control state, kept apart from the network spec so the solver input can
 * be rebuilt immutably on every change (solver stays a pure function).
 */

export interface FeederControl {
  n: number // 1..4, matches load id RES_F<n>
  mw: number
  pf: number
}

export interface ControlState {
  gen: { mwSet: number; vSetPu: number }
  lines: Record<string, number> // line id -> length (mi)
  ind: { mw: number; pf: number }
  feeders: FeederControl[]
}

/** MVAR absorbed by a constant-power load at the given MW and power factor. */
export const mwToMvar = (mw: number, pf: number): number =>
  mw * Math.tan(Math.acos(pf))

/** Power factor implied by MW / MVAR. */
export const pfOf = (mw: number, mvar: number): number =>
  Math.cos(Math.atan2(mvar, mw))

const IND_ID = 'IND_MAIN'
const feederId = (n: number): string => `RES_F${n}`

export function initialControlState(base: SolveInput): ControlState {
  const ind = base.loads.find((l) => l.id === IND_ID)!
  const f1 = base.loads.find((l) => l.id === feederId(1))!
  return {
    gen: {
      mwSet: base.gens[0].mwSet,
      vSetPu: base.gens[0].vSetPu,
    },
    lines: Object.fromEntries(base.lines.map((l) => [l.id, l.lengthMi])),
    ind: { mw: ind.mw, pf: pfOf(ind.mw, ind.mvar) },
    feeders: [1, 2, 3, 4].map((n) => {
      const f = base.loads.find((l) => l.id === feederId(n)) ?? f1
      return { n, mw: f.mw, pf: pfOf(f.mw, f.mvar) }
    }),
  }
}

/** Rebuild the solver input from the base case plus current control state. */
export function buildCase(base: SolveInput, c: ControlState): SolveInput {
  return {
    ...base,
    gens: base.gens.map((g) =>
      g.id === 'G1' ? { ...g, mwSet: c.gen.mwSet, vSetPu: c.gen.vSetPu } : g,
    ),
    lines: base.lines.map((l) => ({ ...l, lengthMi: c.lines[l.id] ?? l.lengthMi })),
    loads: base.loads.map((l) => {
      if (l.id === IND_ID) {
        return { ...l, mw: c.ind.mw, mvar: mwToMvar(c.ind.mw, c.ind.pf) }
      }
      const f = c.feeders.find((fd) => feederId(fd.n) === l.id)
      return f ? { ...l, mw: f.mw, mvar: mwToMvar(f.mw, f.pf) } : l
    }),
  }
}
