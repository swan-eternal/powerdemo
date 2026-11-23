import { describe, it, expect } from 'vitest'
import { makeBaseCase } from '../network/baseCase'
import { solvePowerFlow } from './solve'
import { SolveInput } from './spec'

// Islanding behaviour is tested against classic constant-power loads; ZIP
// voltage dependence (and its interplay with caps/LTC) has its own suite in
// part4.test.ts.
const flatLoads = (): SolveInput => {
  const b = makeBaseCase()
  b.loads = b.loads.map((l) => ({ ...l, zip: undefined }))
  return b
}

const openLine = (input: SolveInput, id: string): SolveInput => ({
  ...input,
  lines: input.lines.map((l) => (l.id === id ? { ...l, brkFrom: false, brkTo: false } : l)),
})

const openXfmr = (input: SolveInput, id: string): SolveInput => ({
  ...input,
  transformers: input.transformers.map((t) => (t.id === id ? { ...t, brkClosed: false } : t)),
})

describe('islanding and breakers', () => {
  it('all closed: grid-tied at 60 Hz, everything energized (regression)', () => {
    const snap = solvePowerFlow(flatLoads())
    expect(snap.converged).toBe(true)
    expect(snap.frequencyHz).toBe(60)
    for (const b of snap.buses) expect(b.energized).toBe(true)
    for (const br of snap.branches) expect(br.energized).toBe(true)
    expect(snap.gens[0].isReference).toBe(false)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
    // The deliberate base-case problems are alarmed.
    expect(snap.alarms.some((a) => a.kind === 'overload' && a.where === 'T_IND')).toBe(true)
    expect(snap.alarms.some((a) => a.kind === 'voltage-low' && a.where === 'IND_LV')).toBe(true)
  })

  it('tie open: generator islands, grid de-energized, droop frequency', () => {
    const base = openLine(flatLoads(), 'L_TIE')
    base.gens[0].mwSet = 100 // load above setpoint → underfrequency
    const snap = solvePowerFlow(base)
    expect(snap.converged).toBe(true)
    expect(snap.buses.find((b) => b.id === 'GRID')!.energized).toBe(false)
    const tie = snap.branches.find((b) => b.id === 'L_TIE')!
    expect(tie.energized).toBe(false)
    expect(tie.fromMw).toBe(0)
    expect(snap.gens[0].isReference).toBe(true)
    expect(snap.gens[0].mw).toBeGreaterThan(150) // carries load + losses
    const expected = 60 * (1 - (0.05 * (snap.gens[0].mw - 100)) / 220)
    expect(snap.frequencyHz).toBeCloseTo(expected, 6)
    expect(snap.frequencyHz).toBeLessThan(59.5)
    expect(snap.alarms.some((a) => a.kind === 'underfreq')).toBe(true)
    expect(snap.alarms.some((a) => a.kind === 'dead-island')).toBe(true)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
  })

  it('transformer breaker open: downstream dead, load excluded from totals', () => {
    const snap = solvePowerFlow(openXfmr(flatLoads(), 'T_IND'))
    expect(snap.converged).toBe(true)
    expect(snap.buses.find((b) => b.id === 'IND_LV')!.energized).toBe(false)
    expect(snap.buses.find((b) => b.id === 'IND_HV')!.energized).toBe(true)
    expect(snap.totals.loadMw).toBeCloseTo(60, 1) // residential only is served
    expect(snap.frequencyHz).toBe(60)
    expect(snap.alarms.some((a) => a.kind === 'dead-island')).toBe(true)
    expect(snap.alarms.some((a) => a.kind === 'overload' && a.where === 'T_IND')).toBe(false)
  })

  it('network split: gen island overfrequency, grid side still serves load', () => {
    let net = flatLoads()
    net = openLine(net, 'L_GSUB_RES')
    net = openLine(net, 'L_IND_RES')
    // Tie stays closed: {GRID, RES_HV, RES_LV} + {GEN, GSUB, IND_HV, IND_LV}
    const snap = solvePowerFlow(net)
    expect(snap.converged).toBe(true)
    // Gen island carries only the industrial load on a 150 MW setpoint.
    expect(snap.frequencyHz).toBeGreaterThan(60.5)
    expect(snap.alarms.some((a) => a.kind === 'overfreq')).toBe(true)
    expect(snap.totals.loadMw).toBeCloseTo(150, 1) // both islands serve their load
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
  })

  it('open line carries zero flow (validation invariant)', () => {
    const snap = solvePowerFlow(openLine(flatLoads(), 'L_IND_RES'))
    const br = snap.branches.find((b) => b.id === 'L_IND_RES')!
    expect(br.energized).toBe(false)
    expect(br.fromMw).toBe(0)
    expect(br.toMw).toBe(0)
    expect(snap.converged).toBe(true)
  })

  it('a de-energized bus re-energizes cleanly with the warm-start state', () => {
    const base = openXfmr(flatLoads(), 'T_IND')
    const first = solvePowerFlow(base)
    expect(first.buses.find((b) => b.id === 'IND_LV')!.energized).toBe(false)
    const closed: SolveInput = {
      ...base,
      transformers: base.transformers.map((t) => ({ ...t, brkClosed: true })),
    }
    const second = solvePowerFlow(closed, { byBus: first.state.byBus })
    expect(second.converged).toBe(true)
    expect(second.buses.every((b) => b.energized)).toBe(true)
  })
})
