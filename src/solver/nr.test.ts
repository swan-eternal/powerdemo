import { describe, it, expect } from 'vitest'
import { SolveInput, LineSpec } from './spec'
import { solvePowerFlow } from './solve'
import { makeBaseCase } from '../network/baseCase'

/**
 * Hand-check helpers. The two-bus lossless line has a closed form:
 * with V1 = v1∠0, load p + jq absorbed at bus 2, reactance x (pu):
 *   v sin δ  = −p·x / v1
 *   v cos δ  = (v² + q·x) / v1
 *   (v²)² − v²(v1² − 2qx) + (p² + q²)x² = 0
 * The high-voltage root is the operating point Newton converges to from flat start.
 */
function twoBusExact(pPu: number, qPu: number, xPu: number, v1 = 1): { v: number; d: number } {
  const a = v1 * v1 - 2 * qPu * xPu
  const c = (pPu * pPu + qPu * qPu) * xPu * xPu
  const u = (a + Math.sqrt(a * a - 4 * c)) / 2
  const v = Math.sqrt(u)
  const d = Math.atan2((-pPu * xPu) / (v1 * v), (u + qPu * xPu) / (v1 * v))
  return { v, d }
}

const ZB_230 = (230 * 230) / 100 // 529 Ω on 100 MVA

/** A line specified so its total series reactance is exactly xPu pu. */
function pureXLine(id: string, from: string, to: string, xPu: number, lengthMi = 10): LineSpec {
  return {
    id,
    from,
    to,
    lengthMi,
    rOhmPerMi: 0,
    xOhmPerMi: (xPu * ZB_230) / lengthMi,
    bSPerMi: 0,
    ratingMva: 300,
  }
}

function twoBusNet(line: LineSpec, loadMw: number, loadMvar: number): SolveInput {
  return {
    sBaseMva: 100,
    slackBusId: 'B1',
    slackVpu: 1,
    buses: [
      { id: 'B1', baseKv: 230 },
      { id: 'B2', baseKv: 230 },
    ],
    lines: [line],
    transformers: [],
    loads: [{ id: 'LD', bus: 'B2', mw: loadMw, mvar: loadMvar }],
    gens: [],
  }
}

describe('Newton-Raphson solver', () => {
  it('matches the two-bus closed form (real load, lossless line)', () => {
    // x = 0.1 pu, load 50 MW + j0.
    const { v, d } = twoBusExact(0.5, 0, 0.1)
    const snap = solvePowerFlow(twoBusNet(pureXLine('L', 'B1', 'B2', 0.1), 50, 0))
    expect(snap.converged).toBe(true)
    const b2 = snap.buses.find((b) => b.id === 'B2')!
    expect(Math.abs(b2.vmagPu - v)).toBeLessThan(1e-9)
    expect(Math.abs(b2.thetaRad - d)).toBeLessThan(1e-9)
    // Lossless: slack delivers exactly the load.
    expect(Math.abs(snap.totals.genMw - 50)).toBeLessThan(1e-6)
    expect(snap.totals.lossMw).toBeLessThan(1e-9)
  })

  it('matches the two-bus closed form (real + reactive load)', () => {
    // x = 0.08 pu, load 40 MW + j20 MVAR.
    const p = 0.4
    const q = 0.2
    const x = 0.08
    const { v, d } = twoBusExact(p, q, x)
    const snap = solvePowerFlow(twoBusNet(pureXLine('L', 'B1', 'B2', x), p * 100, q * 100))
    expect(snap.converged).toBe(true)
    const b2 = snap.buses.find((b) => b.id === 'B2')!
    expect(Math.abs(b2.vmagPu - v)).toBeLessThan(1e-9)
    expect(Math.abs(b2.thetaRad - d)).toBeLessThan(1e-9)
  })

  it('shows Ferranti rise on an open-ended line (right sign and magnitude)', () => {
    // 100 mi of base-case line constants, no load at the far end.
    const line: LineSpec = {
      id: 'L',
      from: 'B1',
      to: 'B2',
      lengthMi: 100,
      rOhmPerMi: 0.055,
      xOhmPerMi: 0.77,
      bSPerMi: 5.2e-6,
      ratingMva: 300,
    }
    const snap = solvePowerFlow(twoBusNet(line, 0, 0))
    expect(snap.converged).toBe(true)
    const b2 = snap.buses.find((b) => b.id === 'B2')!

    // Closed form from the equivalent-pi model: V2 = |yser / (yser + j·b/2)|.
    const zRe = (0.055 * 100) / ZB_230
    const zIm = (0.77 * 100) / ZB_230
    const zMag2 = zRe * zRe + zIm * zIm
    const yserRe = zRe / zMag2
    const yserIm = -zIm / zMag2
    const bHalf = (5.2e-6 * 100 * ZB_230) / 2
    const denRe = yserRe
    const denIm = yserIm + bHalf
    const expected =
      Math.hypot(yserRe, yserIm) / Math.hypot(denRe, denIm)

    expect(b2.vmagPu).toBeGreaterThan(1.0 + 0.01) // clearly above sending end
    expect(Math.abs(b2.vmagPu - expected)).toBeLessThan(1e-9)
  })

  it('holds the PV bus voltage exactly and reports its reactive output', () => {
    const net: SolveInput = {
      sBaseMva: 100,
      slackBusId: 'S',
      slackVpu: 1,
      buses: [
        { id: 'S', baseKv: 230 },
        { id: 'G', baseKv: 230 },
        { id: 'L', baseKv: 230 },
      ],
      lines: [pureXLine('L1', 'S', 'G', 0.05), pureXLine('L2', 'G', 'L', 0.05)],
      transformers: [],
      loads: [{ id: 'LD', bus: 'L', mw: 80, mvar: 30 }],
      gens: [
        { id: 'G1', bus: 'G', mwSet: 80, vSetPu: 1.03, mvaRating: 150, qMinMvar: -40, qMaxMvar: 60 },
      ],
    }
    const snap = solvePowerFlow(net)
    expect(snap.converged).toBe(true)
    const g = snap.buses.find((b) => b.id === 'G')!
    expect(Math.abs(g.vmagPu - 1.03)).toBeLessThan(1e-12)
    // Generator supplies the load vars plus line consumption.
    expect(snap.gens[0].mvar).toBeGreaterThan(30)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
  })

  it('solves the base case: fast, balanced, sane voltages, small tie flow', () => {
    const snap = solvePowerFlow(makeBaseCase())
    expect(snap.converged).toBe(true)
    expect(snap.iterations).toBeLessThanOrEqual(15)
    expect(Math.abs(snap.totals.balanceResidualMw)).toBeLessThan(1e-4)
    for (const b of snap.buses) {
      expect(b.vmagPu).toBeGreaterThan(0.9)
      expect(b.vmagPu).toBeLessThan(1.1)
    }
    const tie = snap.branches.find((br) => br.id === 'L_TIE')!
    expect(Math.abs(tie.fromMw)).toBeLessThan(40)
  })
})
