import { Cx, add, sub, mul, scale, conj, expj, abs } from './complex'
import { SolveInput } from './spec'
import { buildYbus } from './ybus'
import { newtonRaphson, injections, Roles } from './nr'
import { iBaseAmps } from './perunit'

export interface BusResult {
  id: string
  label?: string
  baseKv: number
  vmagPu: number
  kv: number
  thetaRad: number
  thetaDeg: number
  /** Net calculated injection (generation − load) at the solved state. */
  pMw: number
  qMvar: number
}

export interface BranchResult {
  id: string
  kind: 'line' | 'xfmr'
  from: string
  to: string
  fromMw: number
  fromMvar: number
  toMw: number
  toMvar: number
  lossMw: number
  ampsFrom: number
  ampsTo: number
  loadingPct: number
}

export interface GenResult {
  id: string
  bus: string
  mw: number
  mvar: number
  /** Part 4: reactive envelope enforcement. */
  atQLimit: boolean
}

export interface Snapshot {
  converged: boolean
  iterations: number
  buses: BusResult[]
  branches: BranchResult[]
  gens: GenResult[]
  totals: {
    loadMw: number
    loadMvar: number
    genMw: number
    genMvar: number
    lossMw: number
    /** genMw − loadMw − lossMw; ~0 when solved (validation invariant). */
    balanceResidualMw: number
  }
  /** Solved state, usable as a warm start for the next solve. */
  state: { V: number[]; th: number[] }
}

/** Warm-start state, e.g. the previous snapshot. */
export interface SolveInit {
  V: number[]
  th: number[]
}

const phasor = (mag: number, ang: number): Cx => scale(expj(ang), mag)

/**
 * One direction of data flow: SolveInput (engineering units at the boundary)
 * → per-unit model → Ybus → Newton-Raphson → immutable Snapshot back in
 * engineering units. Pure function, no UI knowledge.
 */
export function solvePowerFlow(input: SolveInput, init?: SolveInit): Snapshot {
  const { sBaseMva } = input
  const buses = input.buses
  const n = buses.length
  const idx = new Map(buses.map((b, i) => [b.id, i]))
  const busOf = (id: string): number => {
    const i = idx.get(id)
    if (i === undefined) throw new Error(`unknown bus "${id}"`)
    return i
  }

  const slack = busOf(input.slackBusId)

  // Bus roles: gen buses are PV, everything else PQ (Part 3 adds islanding).
  const pv = [...new Set(input.gens.map((g) => busOf(g.bus)))].filter((i) => i !== slack)
  const pvSet = new Set(pv)
  const pq: number[] = []
  for (let i = 0; i < n; i++) {
    if (i !== slack && !pvSet.has(i)) pq.push(i)
  }

  // Scheduled injections in pu (loads are negative injections).
  const pSp = new Array<number>(n).fill(0)
  const qSp = new Array<number>(n).fill(0)
  for (const ld of input.loads) {
    pSp[busOf(ld.bus)] -= ld.mw / sBaseMva
    qSp[busOf(ld.bus)] -= ld.mvar / sBaseMva
  }
  for (const g of input.gens) {
    if (busOf(g.bus) !== slack) pSp[busOf(g.bus)] += g.mwSet / sBaseMva
  }

  // Initial state: warm start or flat start, with enforced setpoints on top.
  const V0 = init ? [...init.V] : new Array<number>(n).fill(1)
  const th0 = init ? [...init.th] : new Array<number>(n).fill(0)
  V0[slack] = input.slackVpu ?? 1
  th0[slack] = 0
  for (const g of input.gens) {
    const b = busOf(g.bus)
    if (b !== slack) V0[b] = g.vSetPu
  }

  const { y, branches } = buildYbus(buses, input.lines, input.transformers, sBaseMva)
  const roles: Roles = { slack, pv, pq }

  let nr
  try {
    nr = newtonRaphson(y, pSp, qSp, roles, V0, th0)
  } catch {
    return emptySnapshot(input, false)
  }
  if (!nr.converged) return emptySnapshot(input, false)

  const { p, q } = injections(y, nr.V, nr.th)

  const busResults: BusResult[] = buses.map((b, i) => ({
    id: b.id,
    label: b.label,
    baseKv: b.baseKv,
    vmagPu: nr.V[i],
    kv: nr.V[i] * b.baseKv,
    thetaRad: nr.th[i],
    thetaDeg: (nr.th[i] * 180) / Math.PI,
    pMw: p[i] * sBaseMva,
    qMvar: q[i] * sBaseMva,
  }))

  const branchResults: BranchResult[] = branches.map((br) => {
    const vf = phasor(nr.V[br.from], nr.th[br.from])
    const vt = phasor(nr.V[br.to], nr.th[br.to])
    const iFrom = add(mul(sub(vf, vt), br.ySer), mul(vf, br.yShFrom))
    const iTo = add(mul(sub(vt, vf), br.ySer), mul(vt, br.yShTo))
    const sFrom = mul(vf, conj(iFrom))
    const sTo = mul(vt, conj(iTo))
    const fromMva = abs(sFrom) * sBaseMva
    const toMva = abs(sTo) * sBaseMva
    return {
      id: br.id,
      kind: br.kind,
      from: buses[br.from].id,
      to: buses[br.to].id,
      fromMw: sFrom.re * sBaseMva,
      fromMvar: sFrom.im * sBaseMva,
      toMw: sTo.re * sBaseMva,
      toMvar: sTo.im * sBaseMva,
      lossMw: (sFrom.re + sTo.re) * sBaseMva,
      ampsFrom: abs(iFrom) * iBaseAmps(br.fromKv, sBaseMva),
      ampsTo: abs(iTo) * iBaseAmps(br.toKv, sBaseMva),
      loadingPct: (Math.max(fromMva, toMva) / br.ratingMva) * 100,
    }
  })

  const loadAt = (busId: string, f: (mw: number, mvar: number) => number): number =>
    input.loads.filter((ld) => ld.bus === busId).reduce((s, ld) => s + f(ld.mw, ld.mvar), 0)

  const gens: GenResult[] = input.gens.map((g) => {
    const b = busOf(g.bus)
    if (b === slack) {
      // Slack output is whatever balances the network.
      return {
        id: g.id,
        bus: g.bus,
        mw: p[b] * sBaseMva + loadAt(g.bus, (mw) => mw),
        mvar: q[b] * sBaseMva + loadAt(g.bus, (_mw, mvar) => mvar),
        atQLimit: false,
      }
    }
    return {
      id: g.id,
      bus: g.bus,
      mw: g.mwSet,
      mvar: q[b] * sBaseMva + loadAt(g.bus, (_mw, mvar) => mvar),
      atQLimit: false,
    }
  })

  const loadMw = input.loads.reduce((s, ld) => s + ld.mw, 0)
  const loadMvar = input.loads.reduce((s, ld) => s + ld.mvar, 0)
  // The slack bus is a source too (e.g. the GRID equivalent): count its output
  // unless an explicit generator already sits there.
  const slackHasGen = input.gens.some((g) => busOf(g.bus) === slack)
  const slackGenMw = slackHasGen
    ? 0
    : p[slack] * sBaseMva + loadAt(input.slackBusId, (mw) => mw)
  const slackGenMvar = slackHasGen
    ? 0
    : q[slack] * sBaseMva + loadAt(input.slackBusId, (_mw, mvar) => mvar)
  const genMw = gens.reduce((s, g) => s + g.mw, 0) + slackGenMw
  const genMvar = gens.reduce((s, g) => s + g.mvar, 0) + slackGenMvar
  const lossMw = branchResults.reduce((s, br) => s + br.lossMw, 0)

  return {
    converged: true,
    iterations: nr.iterations,
    buses: busResults,
    branches: branchResults,
    gens,
    totals: {
      loadMw,
      loadMvar,
      genMw,
      genMvar,
      lossMw,
      balanceResidualMw: genMw - loadMw - lossMw,
    },
    state: { V: nr.V, th: nr.th },
  }
}

function emptySnapshot(input: SolveInput, converged: boolean): Snapshot {
  return {
    converged,
    iterations: 0,
    buses: [],
    branches: [],
    gens: [],
    totals: {
      loadMw: input.loads.reduce((s, l) => s + l.mw, 0),
      loadMvar: input.loads.reduce((s, l) => s + l.mvar, 0),
      genMw: 0,
      genMvar: 0,
      lossMw: 0,
      balanceResidualMw: NaN,
    },
    state: { V: [], th: [] },
  }
}
