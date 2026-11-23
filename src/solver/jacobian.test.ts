import { describe, it, expect } from 'vitest'
import { makeBaseCase } from '../network/baseCase'
import { buildYbus } from './ybus'
import { jacobianBlocks, injections } from './nr'

// Deterministic pseudo-random state (LCG), so the test is reproducible.
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('analytic Jacobian', () => {
  it('matches central finite differences on the base-case network', () => {
    const c = makeBaseCase()
    const { y } = buildYbus(c.buses, c.lines, c.transformers, c.sBaseMva)
    const n = c.buses.length

    const rnd = lcg(42)
    const th = Array.from({ length: n }, () => (rnd() - 0.5) * 0.6)
    const V = Array.from({ length: n }, () => 0.95 + rnd() * 0.1)

    const B = jacobianBlocks(y, V, th)
    const h = 1e-6

    const fdBlock = (
      pick: (s: { p: number[]; q: number[] }) => number[],
      perturb: 'th' | 'V',
      j: number,
    ): number[] => {
      const plusTh = [...th]
      const minusTh = [...th]
      const plusV = [...V]
      const minusV = [...V]
      if (perturb === 'th') {
        plusTh[j] += h
        minusTh[j] -= h
      } else {
        plusV[j] += h
        minusV[j] -= h
      }
      const a = pick(injections(y, plusV, plusTh))
      const b = pick(injections(y, minusV, minusTh))
      return a.map((va, k) => (va - b[k]) / (2 * h))
    }

    const tol = 1e-5
    for (let j = 0; j < n; j++) {
      const fdPTh = fdBlock((s) => s.p, 'th', j)
      const fdPV = fdBlock((s) => s.p, 'V', j)
      const fdQTh = fdBlock((s) => s.q, 'th', j)
      const fdQV = fdBlock((s) => s.q, 'V', j)
      for (let i = 0; i < n; i++) {
        expect(Math.abs(B.dPdTh[i][j] - fdPTh[i])).toBeLessThan(tol)
        expect(Math.abs(B.dPdV[i][j] - fdPV[i])).toBeLessThan(tol)
        expect(Math.abs(B.dQdTh[i][j] - fdQTh[i])).toBeLessThan(tol)
        expect(Math.abs(B.dQdV[i][j] - fdQV[i])).toBeLessThan(tol)
      }
    }
  })
})
