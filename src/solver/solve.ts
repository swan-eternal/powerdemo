import { Cx, add, sub, mul, scale, conj, expj, abs } from './complex'
import { SolveInput, LoadSpec } from './spec'
import { buildYbus, BranchPu } from './ybus'
import { newtonRaphson, injections, Roles, NrResult, ZipLoadPu } from './nr'
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
  | 'qlimit'

export interface Alarm {
  kind: AlarmKind
  severity: 'alarm' | 'info'
  /** Bus, branch, gen or cap id. */
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
  /** Reactive limit the machine is pinned at, if any. */
  atQLimit: 'max' | 'min' | null
}

export interface CapResult {
  id: string
  bus: string
  closed: boolean
  /** Rated output at 1 pu, MVAR. */
  bankMvar: number
  /** Actual output V²·bank at the solved voltage, MVAR. */
  mvarOut: number
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
  caps: CapResult[]
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

/** ZIP voltage scaling of a load at pu voltage v (1 when constant power). */
const zipScale = (l: LoadSpec, v: number): number => {
  const z = l.zip
  return z ? z.z * v * v + z.i * v + z.p : 1
}

/** Fold closed capacitor banks into bus shunts (constant admittance). */
const foldCaps = (input: SolveInput): SolveInput => {
  const perBus = new Map<string, number>()
  for (const c of input.capBanks ?? []) {
    if (c.closed !== false) perBus.set(c.bus, (perBus.get(c.bus) ?? 0) + c.bankMvar)
  }
  if (perBus.size === 0) return input
  return {
    ...input,
    buses: input.buses.map((b) => {
      const mv = perBus.get(b.id)
      if (!mv) return b
      return {
        ...b,
        shuntPu: { g: b.shuntPu?.g ?? 0, b: (b.shuntPu?.b ?? 0) + mv / input.sBaseMva },
      }
    }),
  }
}

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
 *
 * Reactive limits: after a converged solve, a PV generator beyond its
 * reactive envelope is switched to a PQ bus pinned at the violated limit
 * (textbook bus-type switching) and the island re-solves; the machine stops
 * regulating voltage until the release test succeeds. The islanded reference
 * generator cannot be switched (it carries the angle), so its limit is
 * reported only.
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
      caps: [],
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
  const { input: net, taps, tapSet, faultActive } = expandFaults(foldCaps(input))
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
  /** Reactive limit each generator ended the solve pinned at. */
  const genLimit = new Map<string, 'max' | 'min'>()

  let converged = true
  let collapse = false
  let iterations = 0
  let frequencyHz = F_BASE_HZ

  const loadAtV = (busId: string, v: number): { mw: number; mvar: number } =>
    net.loads.reduce(
      (s, l) =>
        l.bus === busId
          ? { mw: s.mw + l.mw * zipScale(l, v), mvar: s.mvar + l.mvar * zipScale(l, v) }
          : s,
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
    const pv0 = [...new Set(iGens.map((g) => subIdx.get(g.bus)!))].filter((i) => i !== slack)
    const pvSet = new Set(pv0)
    const pq0: number[] = []
    for (let i = 0; i < m; i++) if (i !== slack && !pvSet.has(i)) pq0.push(i)

    const pSp = new Array<number>(m).fill(0)
    const qSp = new Array<number>(m).fill(0)
    for (const g of iGens) {
      const b = subIdx.get(g.bus)!
      if (b !== slack) pSp[b] += g.mwSet / sBaseMva
    }
    // ZIP loads ride in the Newton mismatch (voltage-dependent), not in pSp.
    const zipLoads: ZipLoadPu[] = iLoads.map((l) => {
      const z = l.zip
      return {
        bus: subIdx.get(l.bus)!,
        pPu: l.mw / sBaseMva,
        qPu: l.mvar / sBaseMva,
        z: z?.z ?? 0,
        i: z?.i ?? 0,
        p: z?.p ?? 1,
      }
    })
    const zipQPu = (b: number, v: number): number => {
      let s = 0
      for (const ld of zipLoads) {
        if (ld.bus !== b) continue
        s += ld.qPu * (ld.z * v * v + ld.i * v + ld.p)
      }
      return s
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

    const roles: Roles = { slack, pv: pv0, pq: pq0 }

    // Continuation helper: rebuild Ybus with fault tap shunts scaled by λ.
    const buildScaled = (lam: number): Cx[][] =>
      buildYbus(
        lam === 1
          ? iBuses
          : iBuses.map((b) =>
              b.shuntPu && tapSet.has(b.id)
                ? { ...b, shuntPu: { g: b.shuntPu.g * lam, b: b.shuntPu.b * lam } }
                : b,
            ),
        iLines,
        iXfmrs,
        sBaseMva,
      ).y

    // Newton never throws out of here: a singular Jacobian mid-solve counts
    // as a failed attempt (fell through to flat/ramp retries), not an error.
    const trySolve = (
      y: Cx[][],
      rolesX: Roles,
      qSpX: number[],
      v0: number[],
      th0: number[],
    ): NrResult => {
      try {
        return newtonRaphson(y, pSp, qSpX, rolesX, v0, th0, {}, zipLoads)
      } catch {
        return { converged: false, iterations: 0, V: [...v0], th: [...th0], maxMismatch: Infinity }
      }
    }

    let start = warm(false)
    applySetpoints(start)
    let nr = trySolve(buildScaled(1), roles, qSp, start.v0, start.th0)
    if (nr.converged && !faultActive) {
      // Low-voltage-branch guard: a warm start from a depressed state (e.g.
      // a just-cleared fault) can converge onto the collapsed root of the
      // constant-power equations. If the flat solve finds the operable root,
      // prefer it. (Not while a fault is on: the depressed root is real.)
      const minV = Math.min(...roles.pq.map((i) => nr.V[i]))
      if (minV < 0.8) {
        const flat0 = warm(true)
        applySetpoints(flat0)
        const flat = trySolve(buildScaled(1), roles, qSp, flat0.v0, flat0.th0)
        if (flat.converged && Math.min(...roles.pq.map((i) => flat.V[i])) > 0.8) nr = flat
      }
    }
    if (!nr.converged) {
      start = warm(true)
      applySetpoints(start)
      nr = trySolve(buildScaled(1), roles, qSp, start.v0, start.th0)
    }
    if (!nr.converged && iBuses.some((b) => b.shuntPu && tapSet.has(b.id))) {
      // A low-impedance fault shunt makes one Newton step from flat start
      // violent enough to diverge. Ramp the fault admittance up in ×2 stages,
      // warm-starting each stage, so the tap voltage walks down instead.
      start = warm(true)
      for (const lam of [0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.256, 0.512, 1]) {
        applySetpoints(start)
        nr = trySolve(buildScaled(lam), roles, qSp, start.v0, start.th0)
        if (!nr.converged) break
        start = { v0: [...nr.V], th0: [...nr.th] }
      }
    }

    // --- Generator reactive limits (PV→PQ bus-type switching) ---
    if (nr.converged && pv0.length > 0) {
      let limited = new Map<number, 'max' | 'min'>()
      const sticky = new Set<number>()
      for (let round = 0; round < 8; round++) {
        const { q } = injections(buildScaled(1), nr.V, nr.th)
        const attempt = new Map(limited)
        let switched = false
        for (const g of iGens) {
          const b = subIdx.get(g.bus)!
          if (b === slack || attempt.has(b)) continue
          const qg = (q[b] + zipQPu(b, nr.V[b])) * sBaseMva
          if (qg > g.qMaxMvar) {
            attempt.set(b, 'max')
            switched = true
          } else if (qg < g.qMinMvar) {
            attempt.set(b, 'min')
            switched = true
          }
        }
        if (!switched) {
          // Release test: lift one non-sticky limit and see whether the
          // machine can regulate again without violating.
          let released = false
          for (const b of limited.keys()) {
            if (sticky.has(b)) continue
            attempt.delete(b)
            sticky.add(b)
            released = true
          }
          if (!released) break
        }
        const attemptSet = new Set(attempt.keys())
        const pv2: number[] = []
        const pq2: number[] = []
        for (let i = 0; i < m; i++) {
          if (i === slack) continue
          if (pv0.includes(i) && !attemptSet.has(i)) pv2.push(i)
          else pq2.push(i)
        }
        const qSpL = [...qSp]
        for (const [b, w] of attempt) {
          const g = iGens.find((gg) => subIdx.get(gg.bus) === b)!
          qSpL[b] = (w === 'max' ? g.qMaxMvar : g.qMinMvar) / sBaseMva
        }
        // Warm start, but re-apply the voltage setpoint on buses that are
        // (re-)regulating: Newton holds PV entries at their v0 values, so a
        // released machine must be restarted at its setpoint, not at the
        // voltage it floated to while limited.
        const v0t = [...nr.V]
        for (const g of iGens) {
          const b = subIdx.get(g.bus)!
          if (b !== slack && pv2.includes(b)) v0t[b] = g.vSetPu
        }
        const trial = trySolve(buildScaled(1), { slack, pv: pv2, pq: pq2 }, qSpL, v0t, nr.th)
        if (!trial.converged) break // keep the last consistent solution
        nr = trial
        limited = attempt
      }
      for (const [b, w] of limited) {
        const g = iGens.find((gg) => subIdx.get(gg.bus) === b)!
        genLimit.set(g.id, w)
        alarms.push({
          kind: 'qlimit',
          severity: 'alarm',
          where: g.id,
          detail: `${w === 'max' ? 'Q-max' : 'Q-min'} ${w === 'max' ? g.qMaxMvar : g.qMinMvar} MVAR — voltage control lost`,
        })
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
      const pGenMw = p[slack] * sBaseMva + loadAtV(refGen.bus, nr.V[slack]).mw
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
      // The reference machine carries the island angle and cannot be
      // switched to PQ; report its reactive limit instead.
      const qRef = (q[slack] + zipQPu(slack, nr.V[slack])) * sBaseMva
      if (qRef > refGen.qMaxMvar || qRef < refGen.qMinMvar) {
        const w = qRef > refGen.qMaxMvar ? 'max' : 'min'
        genLimit.set(refGen.id, w)
        alarms.push({
          kind: 'qlimit',
          severity: 'alarm',
          where: refGen.id,
          detail: `${w === 'max' ? 'Q-max' : 'Q-min'} while islanded — voltage at risk`,
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
    const ld = loadAtV(g.bus, vBy[b])
    const isRef = live[b] && islands.some((i) => i.genRef && i.reference === g.bus)
    return {
      id: g.id,
      bus: g.bus,
      mw: live[b] ? pBy[b] * sBaseMva + ld.mw : 0,
      mvar: live[b] ? qBy[b] * sBaseMva + ld.mvar : 0,
      isReference: isRef,
      atQLimit: live[b] ? genLimit.get(g.id) ?? null : null,
    }
  })

  // --- Capacitor bank results ---
  const caps: CapResult[] = (input.capBanks ?? []).map((c) => {
    const bi = idx.get(c.bus)
    const v = bi !== undefined && live[bi] ? vBy[bi] : 0
    return {
      id: c.id,
      bus: c.bus,
      closed: c.closed !== false,
      bankMvar: c.bankMvar,
      mvarOut: c.closed !== false ? v * v * c.bankMvar : 0,
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
    slackLive && !slackHasGen ? pBy[slackI] * sBaseMva + loadAtV(input.slackBusId, vBy[slackI]).mw : 0
  const slackSrcMvar =
    slackLive && !slackHasGen ? qBy[slackI] * sBaseMva + loadAtV(input.slackBusId, vBy[slackI]).mvar : 0
  // Served load is ZIP-evaluated at the solved voltage: constant-power
  // fractions report their schedule, impedance fractions sag with V².
  let loadMw = 0
  let loadMvar = 0
  for (const l of net.loads) {
    if (!busById.get(l.bus)?.energized) continue
    const sc = zipScale(l, vBy[idx.get(l.bus)!])
    loadMw += l.mw * sc
    loadMvar += l.mvar * sc
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
    caps,
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
