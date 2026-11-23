import { Cx, cx, add, scale, div } from './complex'
import { BusSpec, LineSpec, TransformerSpec } from './spec'
import { zBaseOhms } from './perunit'

/** A branch reduced to per-unit, kept for post-solve flow calculation. */
export interface BranchPu {
  id: string
  kind: 'line' | 'xfmr'
  from: number
  to: number
  /** Nominal kV at each end, for amp conversion (differs across transformers). */
  fromKv: number
  toKv: number
  ySer: Cx
  yShFrom: Cx
  yShTo: Cx
  ratingMva: number
}

export interface YbusModel {
  n: number
  y: Cx[][]
  branches: BranchPu[]
}

const zeros = (n: number): Cx[][] =>
  Array.from({ length: n }, () => Array.from({ length: n }, () => cx(0, 0)))

/**
 * Build the bus admittance matrix from in-service lines (equivalent-pi model,
 * so long lines keep their charging and Ferranti rise) and transformers
 * (series impedance; off-nominal taps arrive with the LTC in Part 4).
 */
export function buildYbus(
  buses: BusSpec[],
  lines: LineSpec[],
  transformers: TransformerSpec[],
  sBaseMva: number,
): YbusModel {
  const n = buses.length
  const y = zeros(n)
  const idx = new Map(buses.map((b, i) => [b.id, i]))

  const indexOf = (id: string, what: string): number => {
    const i = idx.get(id)
    if (i === undefined) throw new Error(`${what}: unknown bus "${id}"`)
    return i
  }

  const branches: BranchPu[] = []

  for (const ln of lines) {
    if (ln.inService === false) continue
    const from = indexOf(ln.from, `line ${ln.id}`)
    const to = indexOf(ln.to, `line ${ln.id}`)
    const zb = zBaseOhms(buses[from].baseKv, sBaseMva)
    const z = cx((ln.rOhmPerMi * ln.lengthMi) / zb, (ln.xOhmPerMi * ln.lengthMi) / zb)
    const bPu = ln.bSPerMi * ln.lengthMi * zb
    const branch: BranchPu = {
      id: ln.id,
      kind: 'line',
      from,
      to,
      fromKv: buses[from].baseKv,
      toKv: buses[to].baseKv,
      ySer: div(cx(1, 0), z),
      yShFrom: cx(0, bPu / 2),
      yShTo: cx(0, bPu / 2),
      ratingMva: ln.ratingMva,
    }
    branches.push(branch)
    y[from][from] = add(y[from][from], add(branch.ySer, branch.yShFrom))
    y[to][to] = add(y[to][to], add(branch.ySer, branch.yShTo))
    y[from][to] = add(y[from][to], scale(branch.ySer, -1))
    y[to][from] = add(y[to][from], scale(branch.ySer, -1))
  }

  for (const xf of transformers) {
    if (xf.inService === false) continue
    const from = indexOf(xf.hv, `xfmr ${xf.id}`)
    const to = indexOf(xf.lv, `xfmr ${xf.id}`)
    const ang = Math.atan(xf.xOverR)
    const zOwn = cx(xf.zPuOnOwn * Math.cos(ang), xf.zPuOnOwn * Math.sin(ang))
    const zSys = scale(zOwn, sBaseMva / xf.mvaRating)
    const branch: BranchPu = {
      id: xf.id,
      kind: 'xfmr',
      from,
      to,
      fromKv: buses[from].baseKv,
      toKv: buses[to].baseKv,
      ySer: div(cx(1, 0), zSys),
      yShFrom: cx(0, 0),
      yShTo: cx(0, 0),
      ratingMva: xf.mvaRating,
    }
    branches.push(branch)
    y[from][from] = add(y[from][from], branch.ySer)
    y[to][to] = add(y[to][to], branch.ySer)
    y[from][to] = add(y[from][to], scale(branch.ySer, -1))
    y[to][from] = add(y[to][from], scale(branch.ySer, -1))
  }

  return { n, y, branches }
}
