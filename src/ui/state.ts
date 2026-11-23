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
  /** Breaker states by breaker id; true = closed. */
  breakers: Record<string, boolean>
  /** Cap bank states by id; true = closed (in service). */
  capBanks: Record<string, boolean>
  /** LTC tap on T_RES, pu (1 = nominal; ±10% range). */
  ltcTap: number
  /** Single applied line fault; null = none. */
  fault: { lineId: string; atPct: number; zOhms: number } | null
}

/** MVAR absorbed by a constant-power load at the given MW and power factor. */
export const mwToMvar = (mw: number, pf: number): number =>
  mw * Math.tan(Math.acos(pf))

/** Power factor implied by MW / MVAR. */
export const pfOf = (mw: number, mvar: number): number =>
  Math.cos(Math.atan2(mvar, mw))

const IND_ID = 'IND_MAIN'
const feederId = (n: number): string => `RES_F${n}`
export const lineBrkId = (lineId: string, end: 'from' | 'to'): string => `${lineId}:${end}`
export const xfmrBrkId = (xfId: string): string => `${xfId}:brk`

export function initialControlState(base: SolveInput): ControlState {
  const ind = base.loads.find((l) => l.id === IND_ID)!
  const f1 = base.loads.find((l) => l.id === feederId(1))!
  const breakers: Record<string, boolean> = {}
  for (const l of base.lines) {
    breakers[lineBrkId(l.id, 'from')] = l.brkFrom !== false
    breakers[lineBrkId(l.id, 'to')] = l.brkTo !== false
  }
  for (const t of base.transformers) {
    breakers[xfmrBrkId(t.id)] = t.brkClosed !== false
  }
  const capBanks: Record<string, boolean> = {}
  for (const c of base.capBanks ?? []) {
    capBanks[c.id] = c.closed
  }
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
    breakers,
    capBanks,
    ltcTap: base.transformers.find((t) => t.id === 'T_RES')?.tapPu ?? 1,
    fault: null,
  }
}

/** Rebuild the solver input from the base case plus current control state. */
export function buildCase(base: SolveInput, c: ControlState): SolveInput {
  return {
    ...base,
    faults: c.fault ? [{ ...c.fault }] : [],
    gens: base.gens.map((g) =>
      g.id === 'G1' ? { ...g, mwSet: c.gen.mwSet, vSetPu: c.gen.vSetPu } : g,
    ),
    lines: base.lines.map((l) => ({
      ...l,
      lengthMi: c.lines[l.id] ?? l.lengthMi,
      brkFrom: c.breakers[lineBrkId(l.id, 'from')] ?? true,
      brkTo: c.breakers[lineBrkId(l.id, 'to')] ?? true,
    })),
    transformers: base.transformers.map((t) => ({
      ...t,
      tapPu: t.id === 'T_RES' ? c.ltcTap : t.tapPu,
      brkClosed: c.breakers[xfmrBrkId(t.id)] ?? true,
    })),
    capBanks: (base.capBanks ?? []).map((b) => ({ ...b, closed: c.capBanks[b.id] ?? b.closed })),
    loads: base.loads.map((l) => {
      if (l.id === IND_ID) {
        return { ...l, mw: c.ind.mw, mvar: mwToMvar(c.ind.mw, c.ind.pf) }
      }
      const f = c.feeders.find((fd) => feederId(fd.n) === l.id)
      return f ? { ...l, mw: f.mw, mvar: mwToMvar(f.mw, f.pf) } : l
    }),
  }
}
