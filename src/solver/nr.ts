import { Cx, cx, add, mul, scale, conj, expj } from './complex'

export interface Roles {
  slack: number
  pv: number[]
  pq: number[]
}

/** Calculated bus injections (pu, injection-positive) at a given state. */
export function injections(Y: Cx[][], V: number[], th: number[]): { p: number[]; q: number[] } {
  const n = V.length
  const ph = V.map((m, i) => scale(expj(th[i]), m))
  const p: number[] = []
  const q: number[] = []
  for (let i = 0; i < n; i++) {
    let cur = cx(0, 0)
    for (let j = 0; j < n; j++) cur = add(cur, mul(Y[i][j], ph[j]))
    const s = mul(ph[i], conj(cur))
    p.push(s.re)
    q.push(s.im)
  }
  return { p, q }
}

export interface Blocks {
  dPdTh: number[][]
  dPdV: number[][]
  dQdTh: number[][]
  dQdV: number[][]
}

/**
 * Analytic polar-form Jacobian blocks for all buses (full n×n; callers pick
 * the rows/columns their bus roles require). Standard textbook entries,
 * verified against central finite differences in jacobian.test.ts.
 */
export function jacobianBlocks(Y: Cx[][], V: number[], th: number[]): Blocks {
  const n = V.length
  const m = () => Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const dPdTh = m()
  const dPdV = m()
  const dQdTh = m()
  const dQdV = m()
  const { p, q } = injections(Y, V, th)

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        const G = Y[i][i].re
        const B = Y[i][i].im
        const v2 = V[i] * V[i]
        dPdTh[i][i] = -q[i] - B * v2
        dPdV[i][i] = (p[i] + G * v2) / V[i]
        dQdTh[i][i] = p[i] - G * v2
        dQdV[i][i] = (q[i] - B * v2) / V[i]
      } else {
        const G = Y[i][j].re
        const B = Y[i][j].im
        const t = th[i] - th[j]
        const ct = Math.cos(t)
        const st = Math.sin(t)
        dPdTh[i][j] = V[i] * V[j] * (G * st - B * ct)
        dPdV[i][j] = V[i] * (G * ct + B * st)
        dQdTh[i][j] = -V[i] * V[j] * (G * ct + B * st)
        dQdV[i][j] = V[i] * (G * st - B * ct)
      }
    }
  }
  return { dPdTh, dPdV, dQdTh, dQdV }
}

/** A voltage-dependent (ZIP) load: consumption at 1 pu scaled by
 *  (z·V² + i·V + p) at the load bus. */
export interface ZipLoadPu {
  bus: number
  /** Scheduled consumption at 1 pu, pu on the system base (positive). */
  pPu: number
  qPu: number
  z: number
  i: number
  p: number
}

export interface NrOptions {
  maxIterations?: number
  /** Max absolute power mismatch (pu) that counts as converged. */
  tol?: number
}

export interface NrResult {
  converged: boolean
  iterations: number
  V: number[]
  th: number[]
  maxMismatch: number
}

/**
 * Full Newton-Raphson power flow, polar form, dense Jacobian.
 *
 * Unknowns: angles at PV+PQ buses, magnitudes at PQ buses.
 * V[slack] and V[pv] are held at their v0 entries — pass gen voltage
 * setpoints there. `loads` carries optional ZIP voltage dependence; the
 * mismatch and Jacobian include it exactly. At seven buses this converges
 * in a handful of sub-millisecond iterations.
 */
export function newtonRaphson(
  Y: Cx[][],
  pSp: number[],
  qSp: number[],
  roles: Roles,
  v0: number[],
  th0: number[],
  opts: NrOptions = {},
  loads: ZipLoadPu[] = [],
): NrResult {
  const maxIter = opts.maxIterations ?? 50
  const tol = opts.tol ?? 1e-10
  const V = [...v0]
  const th = [...th0]
  th[roles.slack] = th0[roles.slack]

  // ZIP loads indexed by bus (entries at one bus accumulate).
  const byBus = new Map<number, ZipLoadPu[]>()
  for (const ld of loads) {
    const arr = byBus.get(ld.bus)
    if (arr) arr.push(ld)
    else byBus.set(ld.bus, [ld])
  }
  const zipP = (b: number): number => {
    let s = 0
    for (const ld of byBus.get(b) ?? []) s += ld.pPu * (ld.z * V[b] * V[b] + ld.i * V[b] + ld.p)
    return s
  }
  const zipQ = (b: number): number => {
    let s = 0
    for (const ld of byBus.get(b) ?? []) s += ld.qPu * (ld.z * V[b] * V[b] + ld.i * V[b] + ld.p)
    return s
  }
  const dZipP = (b: number): number => {
    let s = 0
    for (const ld of byBus.get(b) ?? []) s += ld.pPu * (2 * ld.z * V[b] + ld.i)
    return s
  }
  const dZipQ = (b: number): number => {
    let s = 0
    for (const ld of byBus.get(b) ?? []) s += ld.qPu * (2 * ld.z * V[b] + ld.i)
    return s
  }

  const angIdx = [...roles.pv, ...roles.pq]
  const voltIdx = roles.pq
  const nAng = angIdx.length
  const m = nAng + voltIdx.length

  let iterations = 0
  let maxMismatch = Infinity

  for (let it = 0; it <= maxIter; it++) {
    const { p, q } = injections(Y, V, th)
    const mism: number[] = []
    maxMismatch = 0
    for (const i of angIdx) {
      const d = pSp[i] - p[i] - zipP(i)
      mism.push(d)
      maxMismatch = Math.max(maxMismatch, Math.abs(d))
    }
    for (const i of roles.pq) {
      const d = qSp[i] - q[i] - zipQ(i)
      mism.push(d)
      maxMismatch = Math.max(maxMismatch, Math.abs(d))
    }
    if (maxMismatch < tol) return { converged: true, iterations, V, th, maxMismatch }
    if (it === maxIter) break

    const { dPdTh, dPdV, dQdTh, dQdV } = jacobianBlocks(Y, V, th)
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0))
    angIdx.forEach((bi, r) => {
      angIdx.forEach((bj, c) => { J[r][c] = dPdTh[bi][bj] })
      voltIdx.forEach((bj, c) => { J[r][nAng + c] = dPdV[bi][bj] + (bi === bj ? dZipP(bi) : 0) })
    })
    roles.pq.forEach((bi, r) => {
      const row = nAng + r
      angIdx.forEach((bj, c) => { J[row][c] = dQdTh[bi][bj] })
      voltIdx.forEach((bj, c) => { J[row][nAng + c] = dQdV[bi][bj] + (bi === bj ? dZipQ(bi) : 0) })
    })

    const dx = solveDense(J, mism)
    if (dx.some(Number.isNaN)) break
    // Damped update: cap the angle step and the relative voltage step so a
    // single iteration cannot throw a bus magnitude through zero — stiff
    // fault shunts make raw Newton steps violent. Damping only engages on
    // large steps; ordinary quadratic convergence is untouched.
    let damp = 1
    for (let k = 0; k < nAng; k++) {
      damp = Math.min(damp, 0.5 / Math.max(Math.abs(dx[k]), 1e-12))
    }
    for (let k = 0; k < voltIdx.length; k++) {
      const allowed = 0.25 * Math.max(V[voltIdx[k]], 0.05)
      damp = Math.min(damp, allowed / Math.max(Math.abs(dx[nAng + k]), 1e-12))
    }
    angIdx.forEach((b, k) => { th[b] += damp * dx[k] })
    voltIdx.forEach((b, k) => { V[b] += damp * dx[nAng + k] })
    iterations++
  }

  return { converged: false, iterations, V, th, maxMismatch }
}

/** Dense linear solve, Gaussian elimination with partial pivoting. */
export function solveDense(aIn: number[][], b: number[]): number[] {
  const n = b.length
  const a = aIn.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r
    }
    if (Math.abs(a[piv][col]) < 1e-14) throw new Error('singular Jacobian')
    ;[a[col], a[piv]] = [a[piv], a[col]]
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col]
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n]
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c]
    x[r] = s / a[r][r]
  }
  return x
}
