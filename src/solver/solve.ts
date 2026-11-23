import { Cx, add, sub, mul, scale, conj, expj, abs } from './complex'
import { SolveInput } from './spec'
import { buildYbus, BranchPu } from './ybus'
import { newtonRaphson, injections, Roles, NrResult } from './nr'
import { iBaseAmps } from './perunit'
import { findIslands } from './islands'
import { expandFaults } from './fault'

export const F_BASE_HZ = 60

export type AlarmKind =
  | 'voltage-low'
  | 'voltage-high'
  | 'overload'
  | 'underfreq'
  | 'overfreq'
  | 'collapse'
  | 'dead-island'
  | 'fault'

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
  /** Present when a fault is applied on this line. */
  fault?: FaultResult
}

export interface FaultResult {
  atPct: number
  zOhms: number
  /** True when the fault point is energized. */
  live: boolean
  tapVPu: number
  faultAmps: number
  faultMw: number
  faultMvar: number
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
  const { input: net, taps, tapSet, loadShunts } = expandFaults(input)
  const buses = net.buses
  const n = buses.length
  const idx = new Map(buses.map((b, i) => [b.id, i]))
  const islands = findIslands(net)

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
    net.loads.reduce(
      (s, l) => (l.bus === busId ? { mw: s.mw + l.mw, mvar: s.mvar + l.mvar } : s),
      { mw: 0, mvar: 0 },
    )

  for (const island of islands) {
    if (island.reference === null) {
      const real = island.buses.filter((bid) => !tapSet.has(bid))
      // A tap-only island is just the fault point on an isolated line.
      if (real.length > 0) {
        alarms.push({
          kind: 'dead-island',
          severity: 'info',
          where: real[0],
          detail: `${real.length} bus${real.length > 1 ? 'es' : ''} de-energized`,
        })
      }
      continue
    }

    // Live island: assemble and solve it on its own.
    const set = new Set(island.buses)
    const iBuses = buses.filter((b) => set.has(b.id))
    const iLines = net.lines.filter((l) => set.has(l.from) && set.has(l.to) && lineConducts(l))
    const iXfmrs = net.transformers.filter((t) => set.has(t.hv) && set.has(t.lv) && xfmrConducts(t))
    const iLoads = net.loads.filter((l) => set.has(l.bus))
    const iGens = net.gens.filter((g) => set.has(g.bus))

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
      v0[slack] = refGen ? refGen.vSetPu : net.slackVpu ?? 1
      th0[slack] = 0
      for (const g of iGens) {
        const b = subIdx.get(g.bus)!
        if (b !== slack) v0[b] = g.vSetPu
      }
    }

    const roles: Roles = { slack, pv, pq }

    // Continuation helper: rebuild Ybus with fault tap shunts scaled by λ.
    const buildScaled = (lam: number): Cx[][] =>
      buildYbus(
        lam === 1
          ? iBuses
          : iBuses.map((b) =>
              b.shuntPu ? { ...b, shuntPu: { g: b.shuntPu.g * lam, b: b.shuntPu.b * lam } } : b,
            ),
        iLines,
        iXfmrs,
        sBaseMva,
      ).y

    // Newton never throws out of here: a singular Jacobian mid-solve counts
    // as a failed attempt (fell through to flat/ramp retries), not an error.
    const trySolve = (y: Cx[][], v0: number[], th0: number[]): NrResult => {
      try {
        return newtonRaphson(y, pSp, qSp, roles, v0, th0)
      } catch {
        return { converged: false, iterations: 0, V: [...v0], th: [...th0], maxMismatch: Infinity }
      }
    }

    let start = warm(false)
    applySetpoints(start)
    let nr = trySolve(buildScaled(1), start.v0, start.th0)
    if (nr.converged && loadShunts.length === 0) {
      // Low-voltage-branch guard: a warm start from a depressed state (e.g.
      // a just-cleared fault) can converge onto the collapsed root of the
      // constant-power equations. If the flat solve finds the operable root,
      // prefer it.
      const minV = Math.min(...roles.pq.map((i) => nr.V[i]))
      if (minV < 0.8) {
        const flat0 = warm(true)
        applySetpoints(flat0)
        const flat = trySolve(buildScaled(1), flat0.v0, flat0.th0)
        if (flat.converged && Math.min(...roles.pq.map((i) => flat.V[i])) > 0.8) nr = flat
      }
    }
    if (!nr.converged) {
      start = warm(true)
      applySetpoints(start)
      nr = trySolve(buildScaled(1), start.v0, start.th0)
    }
    if (!nr.converged && iBuses.some((b) => b.shuntPu)) {
      // A low-impedance fault shunt makes one Newton step from flat start
      // violent enough to diverge. Ramp the fault admittance up in ×2 stages,
      // warm-starting each stage, so the tap voltage walks down instead.
      start = warm(true)
      for (const lam of [0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.256, 0.512, 1]) {
        applySetpoints(start)
        nr = trySolve(buildScaled(lam), start.v0, start.th0)
        if (!nr.converged) break
        start = { v0: [...nr.V], th0: [...nr.th] }
      }
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
    const { p, q } = injections(buildScaled(1), nr.V, nr.th)
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
  const busResults: BusResult[] = buses
    .map((b, i) => ({
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
    .filter((b) => !tapSet.has(b.id))
  const busById = new Map(busResults.map((b) => [b.id, b]))

  // --- Branch flows (conducting branches only; others carry nothing) ---
  // Faulted lines are solved as two segments around a tap bus; their results
  // merge back into one physical line with fault readouts attached.
  const condLines = net.lines.filter(lineConducts)
  const condXfmrs = net.transformers.filter(xfmrConducts)
  const { branches } = buildYbus(buses, condLines, condXfmrs, sBaseMva)

  const segResult = (id: string): BranchResult | undefined => {
    const br = branches.find((b) => b.id === id)
    return br && busEnergized(br) ? flowResult(br) : undefined
  }

  const branchResults: BranchResult[] = input.lines.map((l): BranchResult => {
    const tap = taps.find((t) => t.lineId === l.id)
    if (!tap) {
      const br = branches.find((b) => b.id === l.id)
      return br && busEnergized(br) ? flowResult(br) : deadBranch(l.id, 'line', l.from, l.to)
    }
    const ti = idx.get(tap.busId)!
    const tapLive = live[ti]
    const v2 = vBy[ti] * vBy[ti]
    const fr: FaultResult = {
      atPct: tap.atPct,
      zOhms: tap.zOhms,
      live: tapLive,
      tapVPu: tapLive ? vBy[ti] : 0,
      faultAmps: tapLive
        ? vBy[ti] * Math.hypot(tap.gPu, tap.bPu) * iBaseAmps(buses[ti].baseKv, sBaseMva)
        : 0,
      faultMw: tapLive ? v2 * tap.gPu * sBaseMva : 0,
      faultMvar: tapLive ? -v2 * tap.bPu * sBaseMva : 0,
    }
    const a = segResult(tap.segA)
    const b = segResult(tap.segB)
    if (!a && !b) return { ...deadBranch(l.id, 'line', l.from, l.to), fault: fr }
    return {
      id: l.id,
      kind: 'line',
      from: l.from,
      to: l.to,
      energized: true,
      fromMw: a?.fromMw ?? 0,
      fromMvar: a?.fromMvar ?? 0,
      toMw: b?.toMw ?? 0,
      toMvar: b?.toMvar ?? 0,
      lossMw: (a?.lossMw ?? 0) + (b?.lossMw ?? 0) + fr.faultMw,
      ampsFrom: a?.ampsFrom ?? 0,
      ampsTo: b?.ampsTo ?? 0,
      loadingPct: Math.max(a?.loadingPct ?? 0, b?.loadingPct ?? 0),
      fault: fr,
    }
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
  const gens: GenResult[] = net.gens.map((g) => {
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
  for (const br of branchResults) {
    if (br.fault?.live) {
      alarms.push({
        kind: 'fault',
        severity: 'alarm',
        where: br.id,
        detail: `${br.fault.faultAmps.toFixed(0)} A at ${br.fault.atPct}% · V ${br.fault.tapVPu.toFixed(3)} pu`,
      })
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
  // Served load: constant-power loads report their schedule; during a fault
  // study loads ride at constant impedance and report V²·Y actuals.
  let loadMw = 0
  let loadMvar = 0
  if (loadShunts.length > 0) {
    for (const sh of loadShunts) {
      if (!busById.get(sh.bus)?.energized) continue
      const v2 = vBy[idx.get(sh.bus)!] * vBy[idx.get(sh.bus)!]
      loadMw += v2 * sh.gPu * sBaseMva
      loadMvar += -v2 * sh.bPu * sBaseMva
    }
  } else {
    for (const l of net.loads) {
      if (!busById.get(l.bus)?.energized) continue
      loadMw += l.mw
      loadMvar += l.mvar
    }
  }
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
