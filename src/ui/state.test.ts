import { describe, it, expect } from 'vitest'
import { makeBaseCase } from '../network/baseCase'
import { solvePowerFlow } from '../solver/solve'
import { initialControlState, buildCase, mwToMvar, pfOf } from './state'

describe('control state', () => {
  it('round-trips the base case through initial state and buildCase', () => {
    const base = makeBaseCase()
    const rebuilt = buildCase(base, initialControlState(base))
    expect(rebuilt.gens[0].mwSet).toBe(base.gens[0].mwSet)
    expect(rebuilt.gens[0].vSetPu).toBe(base.gens[0].vSetPu)
    for (const l of rebuilt.lines) {
      expect(l.lengthMi).toBe(base.lines.find((b) => b.id === l.id)!.lengthMi)
    }
    for (const ld of rebuilt.loads) {
      const orig = base.loads.find((b) => b.id === ld.id)!
      expect(ld.mw).toBeCloseTo(orig.mw, 9)
      expect(ld.mvar).toBeCloseTo(orig.mvar, 9)
    }
  })

  it('maps pf to mvar correctly', () => {
    expect(mwToMvar(90, 0.85)).toBeCloseTo(55.774, 2)
    expect(pfOf(90, mwToMvar(90, 0.85))).toBeCloseTo(0.85, 10)
    expect(pfOf(90, 55.774)).toBeCloseTo(0.85, 4)
    expect(mwToMvar(50, 1)).toBe(0)
  })

  it('applies control overrides to the rebuilt case', () => {
    const base = makeBaseCase()
    const c = initialControlState(base)
    c.gen.mwSet = 120
    c.ind = { mw: 60, pf: 0.95 }
    c.lines['L_TIE'] = 40
    c.feeders[0] = { n: 1, mw: 22, pf: 0.9 }
    c.breakers['L_TIE:from'] = false
    c.breakers['T_IND:brk'] = false
    const rebuilt = buildCase(base, c)
    expect(rebuilt.gens[0].mwSet).toBe(120)
    const ind = rebuilt.loads.find((l) => l.id === 'IND_MAIN')!
    expect(ind.mw).toBe(60)
    expect(ind.mvar).toBeCloseTo(mwToMvar(60, 0.95), 12)
    const tie = rebuilt.lines.find((l) => l.id === 'L_TIE')!
    expect(tie.lengthMi).toBe(40)
    expect(tie.brkFrom).toBe(false)
    expect(tie.brkTo).toBe(true)
    expect(rebuilt.transformers.find((t) => t.id === 'T_IND')!.brkClosed).toBe(false)
    expect(rebuilt.loads.find((l) => l.id === 'RES_F1')!.mw).toBe(22)
    // other feeders untouched
    expect(rebuilt.loads.find((l) => l.id === 'RES_F2')!.mw).toBe(15)
  })

  it('breaker states from the UI de-energize the right islands', () => {
    const base = makeBaseCase()
    const c = initialControlState(base)
    c.breakers['L_TIE:from'] = false
    c.breakers['T_IND:brk'] = false
    const snap = solvePowerFlow(buildCase(base, c))
    expect(snap.buses.find((b) => b.id === 'GRID')!.energized).toBe(false)
    expect(snap.buses.find((b) => b.id === 'IND_LV')!.energized).toBe(false)
    expect(snap.buses.find((b) => b.id === 'RES_LV')!.energized).toBe(true)
  })

  it('solves a heavily-adjusted case with warm-started rebuilds', () => {
    const base = makeBaseCase()
    const c = initialControlState(base)
    let snap = solvePowerFlow(buildCase(base, c))
    c.ind = { mw: 120, pf: 0.8 }
    c.feeders.forEach((fd) => (fd.mw = 20))
    c.gen.mwSet = 180
    snap = solvePowerFlow(buildCase(base, c), { byBus: snap.state.byBus })
    expect(snap.converged).toBe(true)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
  })
})
