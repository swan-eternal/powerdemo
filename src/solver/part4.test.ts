import { describe, it, expect } from 'vitest'
import { solvePowerFlow, Snapshot } from './solve'
import { makeBaseCase } from '../network/baseCase'
import { SolveInput } from './spec'
import { initialControlState, buildCase } from '../ui/state'

const vOf = (s: Snapshot, id: string): number => s.buses.find((b) => b.id === id)!.vmagPu
const pctOf = (s: Snapshot, id: string): number => s.branches.find((b) => b.id === id)!.loadingPct

/** Base case with every load stripped to classic constant power. */
const constantPower = (): SolveInput => {
  const input = makeBaseCase()
  input.loads = input.loads.map((l) => ({ ...l, zip: undefined }))
  return input
}

describe('part 4 — ZIP loads', () => {
  it('a 0/0/1 ZIP mix is exactly the classic constant-power solve', () => {
    const plain = constantPower()
    const cp = makeBaseCase()
    cp.loads = cp.loads.map((l) => ({ ...l, zip: { z: 0, i: 0, p: 1 } }))
    const a = solvePowerFlow(plain)
    const b = solvePowerFlow(cp)
    expect(b.converged).toBe(true)
    for (const bus of a.buses) {
      expect(vOf(b, bus.id)).toBeCloseTo(bus.vmagPu, 9)
    }
  })

  it('ZIP fractions shed load as voltage sags, lifting the depressed bus', () => {
    const a = solvePowerFlow(constantPower())
    const b = solvePowerFlow(makeBaseCase())
    expect(a.converged).toBe(true)
    expect(b.converged).toBe(true)
    // Served load below the 150 MW schedule, and less than the constant-power case.
    expect(b.totals.loadMw).toBeLessThan(149)
    expect(b.totals.loadMw).toBeLessThan(a.totals.loadMw)
    // The industrial bus rides higher than the same schedule at constant power.
    expect(vOf(b, 'IND_LV')).toBeGreaterThan(vOf(a, 'IND_LV'))
    expect(Math.abs(b.totals.balanceResidualMw)).toBeLessThan(0.05)
  })
})

describe('part 4 — capacitor banks', () => {
  it('both banks in service lift Industrial LV above 0.95 pu and unload T_IND', () => {
    const input = makeBaseCase()
    input.capBanks = input.capBanks!.map((c) => ({ ...c, closed: true }))
    const s = solvePowerFlow(input)
    expect(s.converged).toBe(true)
    expect(vOf(s, 'IND_LV')).toBeGreaterThanOrEqual(0.95)
    expect(pctOf(s, 'T_IND')).toBeLessThan(100)
    const out = s.caps.reduce((t, c) => t + c.mvarOut, 0)
    expect(out).toBeGreaterThan(20) // 24 MVAR rated, riding below 1 pu
    expect(out).toBeLessThan(24)
    expect(Math.abs(s.totals.balanceResidualMw)).toBeLessThan(0.05)
  })

  it('banks out of service report zero and leave the base case alone', () => {
    const s = solvePowerFlow(makeBaseCase())
    expect(s.caps.every((c) => !c.closed && c.mvarOut === 0)).toBe(true)
    expect(vOf(s, 'IND_LV')).toBeLessThan(0.95)
  })
})

describe('part 4 — generator reactive limits', () => {
  it('G1 pins at Q-max and stops regulating when excitation is pushed too hard', () => {
    const input = makeBaseCase()
    input.gens = input.gens.map((g) => ({ ...g, vSetPu: 1.06 }))
    const s = solvePowerFlow(input)
    expect(s.converged).toBe(true)
    const gen = s.gens[0]
    expect(gen.atQLimit).toBe('max')
    expect(gen.mvar).toBeCloseTo(87, 1)
    expect(vOf(s, 'GEN')).toBeLessThan(1.06) // voltage control lost
    expect(s.alarms.some((a) => a.kind === 'qlimit' && a.where === 'G1')).toBe(true)
    expect(Math.abs(s.totals.balanceResidualMw)).toBeLessThan(0.05)
  })

  it('switching in the cap banks releases G1 back to voltage control', () => {
    const pushing = (): SolveInput => {
      const input = makeBaseCase()
      input.gens = input.gens.map((g) => ({ ...g, vSetPu: 1.05 }))
      return input
    }
    const limited = solvePowerFlow(pushing())
    expect(limited.gens[0].atQLimit).toBe('max')
    expect(vOf(limited, 'IND_LV')).toBeLessThan(0.95)
    const rescued = pushing()
    rescued.capBanks = rescued.capBanks!.map((c) => ({ ...c, closed: true }))
    const s = solvePowerFlow(rescued)
    expect(s.converged).toBe(true)
    expect(s.gens[0].atQLimit).toBeNull()
    expect(vOf(s, 'GEN')).toBeCloseTo(1.05, 4) // regulating again, at setpoint
    // Local MVARs relieve the machine and fix the local voltage.
    expect(s.gens[0].mvar).toBeLessThan(87)
    expect(vOf(s, 'IND_LV')).toBeGreaterThanOrEqual(0.95)
    expect(Math.abs(s.totals.balanceResidualMw)).toBeLessThan(0.05)
  })
})

describe('part 4 — LTC tap', () => {
  it('tap raise boosts Residential LV, tap lower depresses it', () => {
    const at = (t: number): Snapshot => {
      const input = makeBaseCase()
      input.transformers = input.transformers.map((xf) =>
        xf.id === 'T_RES' ? { ...xf, tapPu: t } : xf,
      )
      return solvePowerFlow(input)
    }
    const up = at(1.05)
    const mid = at(1.0)
    const down = at(0.95)
    for (const s of [up, mid, down]) {
      expect(s.converged).toBe(true)
      expect(Math.abs(s.totals.balanceResidualMw)).toBeLessThan(0.05)
    }
    expect(vOf(up, 'RES_LV') - vOf(mid, 'RES_LV')).toBeGreaterThan(0.02)
    expect(vOf(mid, 'RES_LV') - vOf(down, 'RES_LV')).toBeGreaterThan(0.02)
    // ZIP response: served residential load rises with the boosted voltage.
    expect(up.totals.loadMw).toBeGreaterThan(down.totals.loadMw)
  })
})

describe('part 4 — control state plumbing', () => {
  it('cap bank toggles and the LTC tap round-trip through buildCase', () => {
    const base = makeBaseCase()
    const c = initialControlState(base)
    expect(c.capBanks.CAP1).toBe(false)
    expect(c.ltcTap).toBe(1)
    c.capBanks.CAP1 = true
    c.ltcTap = 1.05
    const input = buildCase(base, c)
    expect(input.capBanks!.find((x) => x.id === 'CAP1')!.closed).toBe(true)
    expect(input.capBanks!.find((x) => x.id === 'CAP2')!.closed).toBe(false)
    expect(input.transformers.find((t) => t.id === 'T_RES')!.tapPu).toBe(1.05)
    expect(input.transformers.find((t) => t.id === 'T_IND')!.tapPu).toBeUndefined()
  })
})
