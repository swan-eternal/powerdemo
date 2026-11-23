import { Cx, cx, add, scale, div } from './complex'
import { BusSpec, LineSpec, TransformerSpec } from './spec'
import { zBaseOhms } from './perunit'

/** A branch reduced to per-unit, kept for Ybus assembly and flow calculation. */
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

/** Equivalent-pi model of a line (keeps charging and Ferranti rise on long lines). */
export function lineToBranchPu(
  ln: LineSpec,
  fromKv: number,
  toKv: number,
  sBaseMva: number,
): BranchPu {
  const zb = zBaseOhms(fromKv, sBaseMva)
  const z = cx((ln.rOhmPerMi * ln.lengthMi) / zb, (ln.xOhmPerMi * ln.lengthMi) / zb)
  const bPu = ln.bSPerMi * ln.lengthMi * zb
  return {
    id: ln.id,
    kind: 'line',
    from: -1,
    to: -1,
    fromKv,
    toKv,
    ySer: div(cx(1, 0), z),
    yShFrom: cx(0, bPu / 2),
    yShTo: cx(0, bPu / 2),
    ratingMva: ln.ratingMva,
  }
}

/** Series-impedance transformer model (off-nominal taps arrive with the LTC). */
export function xfmrToBranchPu(
  xf: TransformerSpec,
  fromKv: number,
  toKv: number,
  sBaseMva: number,
): BranchPu {
  const ang = Math.atan(xf.xOverR)
  const zOwn = cx(xf.zPuOnOwn * Math.cos(ang), xf.zPuOnOwn * Math.sin(ang))
  const zSys = scale(zOwn, sBaseMva / xf.mvaRating)
  return {
    id: xf.id,
    kind: 'xfmr',
    from: -1,
    to: -1,
    fromKv,
    toKv,
    ySer: div(cx(1, 0), zSys),
    yShFrom: cx(0, 0),
    yShTo: cx(0, 0),
    ratingMva: xf.mvaRating,
  }
}

const zeros = (n: number): Cx[][] =>
  Array.from({ length: n }, () => Array.from({ length: n }, () => cx(0, 0)))

/**
 * Build the bus admittance matrix from the given branches. Callers pass only
 * the branches they want modelled — islanding filters by breaker state
 * upstream.
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

  // Bus shunts (fault tap points) stamp into the diagonal.
  for (let i = 0; i < buses.length; i++) {
    const sh = buses[i].shuntPu
    if (sh) y[i][i] = add(y[i][i], cx(sh.g, sh.b))
  }

  const stamp = (branch: BranchPu): void => {
    y[branch.from][branch.from] = add(y[branch.from][branch.from], add(branch.ySer, branch.yShFrom))
    y[branch.to][branch.to] = add(y[branch.to][branch.to], add(branch.ySer, branch.yShTo))
    y[branch.from][branch.to] = add(y[branch.from][branch.to], scale(branch.ySer, -1))
    y[branch.to][branch.from] = add(y[branch.to][branch.from], scale(branch.ySer, -1))
  }

  for (const ln of lines) {
    const from = indexOf(ln.from, `line ${ln.id}`)
    const to = indexOf(ln.to, `line ${ln.id}`)
    const branch = lineToBranchPu(ln, buses[from].baseKv, buses[to].baseKv, sBaseMva)
    branch.from = from
    branch.to = to
    branches.push(branch)
    stamp(branch)
  }

  for (const xf of transformers) {
    const from = indexOf(xf.hv, `xfmr ${xf.id}`)
    const to = indexOf(xf.lv, `xfmr ${xf.id}`)
    const branch = xfmrToBranchPu(xf, buses[from].baseKv, buses[to].baseKv, sBaseMva)
    branch.from = from
    branch.to = to
    branches.push(branch)
    stamp(branch)
  }

  return { n, y, branches }
}

export { zBaseOhms }
