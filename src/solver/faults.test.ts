import { describe, it, expect } from 'vitest'
import { makeBaseCase } from '../network/baseCase'
import { solvePowerFlow } from './solve'
import { SolveInput } from './spec'

const withFault = (
  input: SolveInput,
  lineId: string,
  atPct: number,
  zOhms: number,
): SolveInput => ({ ...input, faults: [{ lineId, atPct, zOhms }] })

describe('line faults', () => {
  it('100 Ω fault: converges, current flows, vars absorbed, balance closes', () => {
    const snap = solvePowerFlow(withFault(makeBaseCase(), 'L_GSUB_IND', 50, 100))
    expect(snap.converged).toBe(true)
    const br = snap.branches.find((b) => b.id === 'L_GSUB_IND')!
    expect(br.energized).toBe(true)
    expect(br.fault).toBeDefined()
    expect(br.fault!.live).toBe(true)
    expect(br.fault!.tapVPu).toBeGreaterThan(0.5)
    expect(br.fault!.tapVPu).toBeLessThan(1.0)
    expect(br.fault!.faultAmps).toBeGreaterThan(100)
    expect(br.fault!.faultMvar).toBeGreaterThan(br.fault!.faultMw) // inductive path
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-3)
    expect(snap.alarms.some((a) => a.kind === 'fault' && a.where === 'L_GSUB_IND')).toBe(true)
  })

  it('bolted fault on the tie: tap collapses, current explodes, loads ride at impedance', () => {
    const snap = solvePowerFlow(withFault(makeBaseCase(), 'L_TIE', 30, 0))
    expect(snap.converged).toBe(true)
    const br = snap.branches.find((b) => b.id === 'L_TIE')!
    expect(br.fault!.live).toBe(true)
    expect(br.fault!.tapVPu).toBeLessThan(0.2)
    expect(br.fault!.faultAmps).toBeGreaterThan(4000)
    expect(br.loadingPct).toBeGreaterThan(100)
    expect(snap.alarms.some((a) => a.kind === 'overload' && a.where === 'L_TIE')).toBe(true)
    // Fault-study loads ride at constant impedance: served load sags with V².
    expect(snap.totals.loadMw).toBeLessThan(140)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(0.05)
  })

  it('fault isolated by opening the line breakers goes quiet', () => {
    const base = withFault(makeBaseCase(), 'L_GSUB_IND', 40, 0)
    base.lines = base.lines.map((l) =>
      l.id === 'L_GSUB_IND' ? { ...l, brkFrom: false, brkTo: false } : l,
    )
    const snap = solvePowerFlow(base)
    expect(snap.converged).toBe(true)
    const br = snap.branches.find((b) => b.id === 'L_GSUB_IND')!
    expect(br.energized).toBe(false)
    expect(br.fault!.live).toBe(false)
    expect(br.fault!.faultAmps).toBe(0)
    expect(snap.alarms.some((a) => a.kind === 'fault')).toBe(false)
    expect(snap.frequencyHz).toBe(60)
  })

  it('fault fed from one end only still draws current', () => {
    const base = withFault(makeBaseCase(), 'L_GSUB_IND', 40, 5)
    base.lines = base.lines.map((l) => (l.id === 'L_GSUB_IND' ? { ...l, brkFrom: false } : l))
    const snap = solvePowerFlow(base)
    expect(snap.converged).toBe(true)
    const br = snap.branches.find((b) => b.id === 'L_GSUB_IND')!
    expect(br.energized).toBe(true)
    expect(br.fault!.live).toBe(true)
    expect(br.fault!.faultAmps).toBeGreaterThan(100)
    expect(br.ampsFrom).toBe(0) // from end open
    expect(br.ampsTo).toBeGreaterThan(0) // fed from the to end
  })

  it('clearing the fault restores the unfaulted solution', () => {
    const clean = solvePowerFlow(makeBaseCase())
    const faulted = solvePowerFlow(withFault(makeBaseCase(), 'L_GSUB_RES', 60, 10), {
      byBus: clean.state.byBus,
    })
    expect(faulted.converged).toBe(true)
    const cleared = solvePowerFlow(makeBaseCase(), { byBus: faulted.state.byBus })
    expect(cleared.converged).toBe(true)
    for (const b of clean.buses) {
      const b2 = cleared.buses.find((x) => x.id === b.id)!
      expect(Math.abs(b2.vmagPu - b.vmagPu)).toBeLessThan(1e-6)
      expect(Math.abs(b2.thetaRad - b.thetaRad)).toBeLessThan(1e-6)
    }
  })
})
