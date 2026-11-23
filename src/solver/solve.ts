import { Cx, add, sub, mul, scale, conj, expj, abs } from './complex'
import { SolveInput } from './spec'
import { buildYbus, BranchPu } from './ybus'
import { newtonRaphson, injections, Roles } from './nr'
import { iBaseAmps } from './perunit'
import { findIslands } from './islands'

export const F_BASE_HZ = 60

export type AlarmKind =
  | 'voltage-low'
  | 'voltage-high'
  | 'overload'
  | 'underfreq'
  | 'overfreq'
  | 'collapse'
  | 'dead-island'

export interface Alarm {
  kind: AlarmKind
  severity: 'alarm' | 'info'
  /** Bus or branch id. */
  where: string
  detail: string
}

export interface BusResult {
  id: string
  label?: string
  baseKv: number
  energized: boolean
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
  energized: boolean
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
  /** True when the generator is its island's reference (islanded operation). */
  isReference: boolean
  /** Part 4: reactive envelope enforcement. */
  atQLimit: boolean
}

export interface Snapshot {
  /** True when every energized island converged. */
  converged: boolean
  /** True when at least one island failed to converge (values held). */
  collapse: boolean
  iterations: number
  /** Island frequency: 60.0 when tied to the grid, droop-derived when islanded. */
  frequencyHz: number
  buses: BusResult[]
  branches: BranchResult[]
  gens: GenResult[]
  alarms: Alarm[]
  totals: {
    loadMw: number
    loadMvar: number
    genMw: number
    genMvar: number
    lossMw: number
    /** genMw − loadMw − lossMw; ~0 when solved (validation invariant). */
    balanceResidualMw: number
  }
  /** Solved state by bus id, usable as a warm start for the next solve. */
  state: { byBus: Record<string, { v: number; th: number }> }
}

/** Warm-start state, e.g. the previous snapshot. */
export interface SolveInit {
  byBus: Record<string, { v: number; th: number }>
}

const phasor = (mag: number, ang: number): Cx => scale(expj(ang), mag)

const lineConducts = (l: { brkFrom?: boolean; brkTo?: boolean }): boolean =>
  l.brkFrom !== false && l.brkTo !== false
const xfmrConducts = (t: { brkClosed?: boolean }): boolean => t.brkClosed !== false

/**
 * One direction of data flow: SolveInput (engineering units at the boundary)
 * → islanding → per-island Ybus → Newton-Raphson → immutable Snapshot back in
 * engineering units. Pure function, no UI knowledge.
 *
 * Islanding: conducting branches (all breakers closed) partition the network.
 * The island containing the slack bus is grid-tied (frequency 60 Hz); an
 * island with only a generator uses the generator as reference — its MW comes
 * out of the solve and frequency follows algebraically from governor droop.
 * Islands without a source are de-energized. A failed island keeps its
 * warm-start values and raises a collapse alarm (hold-last-good behaviour).
 */
export function solvePowerFlow(input: SolveInput, init?: SolveInit): Snapshot {
  try {
    return solve(input, init)
  } catch {
    return {
      converged: false,
      collapse: false,
      iterations: 0,
      frequencyHz: F_BASE_HZ,
      buses: [],
      branches: [],
      gens: [],
      alarms: [],
      totals: {
        loadMw: 0,
        loadMvar: 0,
        genMw: 0,
        genMvar: 0,
        lossMw: 0,
        balanceResidualMw: NaN,
      },
      state: { byBus: {} },
    }
  }
}

function solve(input: SolveInput, init?: SolveInit): Snapshot {
  const { sBaseMva } = input
  const buses = input.buses
  const n = buses.length
  const idx = new Map(buses.map((b, i) => [b.id, i]))
  const islands = findIslands(input)

  const alarms: Alarm[] = []
  const vBy = new Array<number>(n).fill(0)
  const thBy = new Array<number>(n).fill(0)
  const pBy = new Array<number>(n).fill(0)
  const qBy = new Array<number>(n).fill(0)
  const live = new Array<boolean>(n).fill(false)

  let converged = true
  let collapse = false
  let iterations = 0
  let frequencyHz = F_BASE_HZ

  const loadAt = (busId: string): { mw: number; mvar: number } =>
    input.loads.reduce(
      (s, l) => (l.bus === busId ? { mw: s.mw + l.mw, mvar: s.mvar + l.mvar } : s),
      { mw: 0, mvar: 0 },
    )

  for (const island of islands) {
    if (island.reference === null) {
      alarms.push({
        kind: 'dead-island',
        severity: 'info',
        where: island.buses[0],
        detail: `${island.buses.length} bus${island.buses.length > 1 ? 'es' : ''} de-energized`,
      })
      continue
    }

    // Live island: assemble and solve it on its own.
    const set = new Set(island.buses)
    const iBuses = buses.filter((b) => set.has(b.id))
    const iLines = input.lines.filter((l) => set.has(l.from) && set.has(l.to) && lineConducts(l))
    const iXfmrs = input.transformers.filter((t) => set.has(t.hv) && set.has(t.lv) && xfmrConducts(t))
    const iLoads = input.loads.filter((l) => set.has(l.bus))
    const iGens = input.gens.filter((g) => set.has(g.bus))

    const m = iBuses.length
    const subIdx = new Map(iBuses.map((b, i) => [b.id, i]))
    const slack = subIdx.get(island.reference)!
    const pv = [...new Set(iGens.map((g) => subIdx.get(g.bus)!))].filter((i) => i !== slack)
    const pvSet = new Set(pv)
    const pq: number[] = []
    for (let i = 0; i < m; i++) if (i !== slack && !pvSet.has(i)) pq.push(i)

    const pSp = new Array<number>(m).fill(0)
    const qSp = new Array<number>(m).fill(0)
    for (const ld of iLoads) {
      pSp[subIdx.get(ld.bus)!] -= ld.mw / sBaseMva
      qSp[subIdx.get(ld.bus)!] -= ld.mvar / sBaseMva
    }
    for (const g of iGens) {
      const b = subIdx.get(g.bus)!
      if (b !== slack) pSp[b] += g.mwSet / sBaseMva
    }

    const warm = (flat: boolean): { v0: number[]; th0: number[] } => ({
      v0: iBuses.map((b) => (flat ? 1 : init?.byBus[b.id]?.v ?? 1)),
      th0: iBuses.map((b) => (flat ? 0 : init?.byBus[b.id]?.th ?? 0)),
    })
    const refGen = island.genRef ? iGens.find((g) => subIdx.get(g.bus) === slack) : undefined
    const applySetpoints = ({ v0, th0 }: { v0: number[]; th0: number[] }): void => {
      v0[slack] = refGen ? refGen.vSetPu : input.slackVpu ?? 1
      th0[slack] = 0
      for (const g of iGens) {
        const b = subIdx.get(g.bus)!
        if (b !== slack) v0[b] = g.vSetPu
      }
    }

    const { y } = buildYbus(iBuses, iLines, iXfmrs, sBaseMva)
    const roles: Roles = { slack, pv, pq }

    let start = warm(false)
    applySetpoints(start)
    let nr = newtonRaphson(y, pSp, qSp, roles, start.v0, start.th0)
    if (!nr.converged) {
      start = warm(true)
      applySetpoints(start)
      nr = newtonRaphson(y, pSp, qSp, roles, start.v0, start.th0)
    }

    for (const id of island.buses) {
      const gi = idx.get(id)!
      live[gi] = true
      const si = subIdx.get(id)!
      if (nr.converged) {
        vBy[gi] = nr.V[si]
        thBy[gi] = nr.th[si]
      } else {
        // Hold the warm-start (last good) values for this island.
        vBy[gi] = start.v0[si]
        thBy[gi] = start.th0[si]
      }
    }

    if (!nr.converged) {
      converged = false
      collapse = true
      alarms.push({
        kind: 'collapse',
        severity: 'alarm',
        where: island.buses[0],
        detail: 'island did not converge — holding last good state',
      })
      continue
    }

    iterations = Math.max(iterations, nr.iterations)
    const { p, q } = injections(y, nr.V, nr.th)
    for (const id of island.buses) {
      const gi = idx.get(id)!
      const si = subIdx.get(id)!
      pBy[gi] = p[si]
      qBy[gi] = q[si]
    }

    if (refGen) {
      const pGenMw = p[slack] * sBaseMva + loadAt(refGen.bus).mw
      frequencyHz =
        F_BASE_HZ * (1 - ((refGen.droop ?? 0.05) * (pGenMw - refGen.mwSet)) / refGen.mvaRating)
      if (frequencyHz < 59.5 || pGenMw > refGen.pMaxMw) {
        alarms.push({
          kind: 'underfreq',
          severity: 'alarm',
          where: refGen.id,
          detail: `${frequencyHz.toFixed(2)} Hz · ${pGenMw.toFixed(1)} MW / ${refGen.pMaxMw} MW limit`,
        })
      } else if (frequencyHz > 60.5) {
        alarms.push({
          kind: 'overfreq',
          severity: 'alarm',
          where: refGen.id,
          detail: `${frequencyHz.toFixed(2)} Hz`,
        })
      }
    }
  }

  // --- Bus results ---
  const busResults: BusResult[] = buses.map((b, i) => ({
    id: b.id,
    label: b.label,
    baseKv: b.baseKv,
    energized: live[i],
    vmagPu: live[i] ? vBy[i] : 0,
    kv: live[i] ? vBy[i] * b.baseKv : 0,
    thetaRad: live[i] ? thBy[i] : 0,
    thetaDeg: live[i] ? (thBy[i] * 180) / Math.PI : 0,
    pMw: live[i] ? pBy[i] * sBaseMva : 0,
    qMvar: live[i] ? qBy[i] * sBaseMva : 0,
  }))
  const busById = new Map(busResults.map((b) => [b.id, b]))

  // --- Branch flows (conducting branches only; others carry nothing) ---
  const condLines = input.lines.filter(lineConducts)
  const condXfmrs = input.transformers.filter(xfmrConducts)
  const { branches } = buildYbus(buses, condLines, condXfmrs, sBaseMva)

  const branchResults: BranchResult[] = input.lines.map((l) => {
    const br = branches.find((b) => b.id === l.id)
    return br && busEnergized(br) ? flowResult(br) : deadBranch(l.id, 'line', l.from, l.to)
  }).concat(
    input.transformers.map((t) => {
      const br = branches.find((b) => b.id === t.id)
      return br && busEnergized(br) ? flowResult(br) : deadBranch(t.id, 'xfmr', t.hv, t.lv)
    }),
  )

  function busEnergized(br: BranchPu): boolean {
    return live[br.from] && live[br.to]
  }

  function flowResult(br: BranchPu): BranchResult {
    const vf = phasor(vBy[br.from], thBy[br.from])
    const vt = phasor(vBy[br.to], thBy[br.to])
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
      energized: true,
      fromMw: sFrom.re * sBaseMva,
      fromMvar: sFrom.im * sBaseMva,
      toMw: sTo.re * sBaseMva,
      toMvar: sTo.im * sBaseMva,
      lossMw: (sFrom.re + sTo.re) * sBaseMva,
      ampsFrom: abs(iFrom) * iBaseAmps(br.fromKv, sBaseMva),
      ampsTo: abs(iTo) * iBaseAmps(br.toKv, sBaseMva),
      loadingPct: (Math.max(fromMva, toMva) / br.ratingMva) * 100,
    }
  }

  function deadBranch(id: string, kind: 'line' | 'xfmr', from: string, to: string): BranchResult {
    return {
      id,
      kind,
      from,
      to,
      energized: false,
      fromMw: 0,
      fromMvar: 0,
      toMw: 0,
      toMvar: 0,
      lossMw: 0,
      ampsFrom: 0,
      ampsTo: 0,
      loadingPct: 0,
    }
  }

  // --- Generator results ---
  const gens: GenResult[] = input.gens.map((g) => {
    const b = idx.get(g.bus)!
    const ld = loadAt(g.bus)
    const isRef = live[b] && islands.some((i) => i.genRef && i.reference === g.bus)
    return {
      id: g.id,
      bus: g.bus,
      mw: live[b] ? pBy[b] * sBaseMva + ld.mw : 0,
      mvar: live[b] ? qBy[b] * sBaseMva + ld.mvar : 0,
      isReference: isRef,
      atQLimit: false,
    }
  })

  // --- Alarms: voltage band and overloads ---
  for (const b of busResults) {
    if (!b.energized) continue
    if (b.vmagPu < 0.95) {
      alarms.push({ kind: 'voltage-low', severity: 'alarm', where: b.id, detail: `${b.vmagPu.toFixed(3)} pu` })
    } else if (b.vmagPu > 1.05) {
      alarms.push({ kind: 'voltage-high', severity: 'alarm', where: b.id, detail: `${b.vmagPu.toFixed(3)} pu` })
    }
  }
  for (const br of branchResults) {
    if (br.energized && br.loadingPct > 100) {
      alarms.push({ kind: 'overload', severity: 'alarm', where: br.id, detail: `${br.loadingPct.toFixed(0)}%` })
    }
  }

  // --- Totals over the served system ---
  // The live slack bus is a source too (the grid equivalent): count its
  // output unless an explicit generator already sits there.
  const slackI = idx.get(input.slackBusId)!
  const slackLive = live[slackI]
  const slackHasGen = input.gens.some((g) => idx.get(g.bus) === slackI)
  const slackSrcMw =
    slackLive && !slackHasGen ? pBy[slackI] * sBaseMva + loadAt(input.slackBusId).mw : 0
  const slackSrcMvar =
    slackLive && !slackHasGen ? qBy[slackI] * sBaseMva + loadAt(input.slackBusId).mvar : 0
  const loadMw = input.loads.filter((l) => busById.get(l.bus)?.energized).reduce((s, l) => s + l.mw, 0)
  const loadMvar = input.loads.filter((l) => busById.get(l.bus)?.energized).reduce((s, l) => s + l.mvar, 0)
  const genMw = gens.reduce((s, g) => s + g.mw, 0) + slackSrcMw
  const genMvar = gens.reduce((s, g) => s + g.mvar, 0) + slackSrcMvar
  const lossMw = branchResults.reduce((s, br) => s + br.lossMw, 0)

  return {
    converged,
    collapse,
    iterations,
    frequencyHz,
    buses: busResults,
    branches: branchResults,
    gens,
    alarms,
    totals: {
      loadMw,
      loadMvar,
      genMw,
      genMvar,
      lossMw,
      balanceResidualMw: genMw - loadMw - lossMw,
    },
    state: {
      byBus: Object.fromEntries(
        buses.map((b, i) => [b.id, { v: live[i] ? vBy[i] : init?.byBus[b.id]?.v ?? 1, th: live[i] ? thBy[i] : init?.byBus[b.id]?.th ?? 0 }]),
      ),
    },
  }
}
