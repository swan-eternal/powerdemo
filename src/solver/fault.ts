import { SolveInput, LineSpec } from './spec'
import { zBaseOhms } from './perunit'

/**
 * Fault expansion — steady-state line faults.
 *
 * A fault on line L at `atPct` with impedance Zf becomes a tap bus at that
 * point (id `L$F`) with a shunt admittance 1/Zf to ground, and the line
 * splits into two series segments (`L$A`, `L$B`) that inherit the line's
 * per-mile constants, rating and end breakers. Everything downstream
 * (islanding, Ybus, NR) then treats it as an ordinary bus, so fault current,
 * voltage depression and breaker isolation all fall out of the same solve.
 *
 * Fault-study convention: while a fault is applied, constant-power loads are
 * converted to their 1-pu equivalent impedances. A deeply depressed system
 * then sheds load the way real impedance-like demand does — and the solve
 * stays solvable (constant-power loads past their voltage-collapse fold
 * would have no steady-state solution at all).
 *
 * The fault path is mostly inductive (X/R = 10, typical fault impedance); the
 * resistance aids convergence of the depressed tap bus. "Bolted" (zOhms = 0)
 * floors at a small impedance so the admittance stays finite.
 */

/** Fault path X/R ratio. */
const FAULT_XR = 10
/** Effective floor for a bolted fault, ohms (arc + footing; keeps the tap
 * solvable — a true 0 Ω tap would leave its angle undetermined at V≈0). */
const BOLTED_OHMS = 0.5

export interface FaultTap {
  lineId: string
  busId: string
  segA: string
  segB: string
  atPct: number
  zOhms: number
  /** Fault admittance, pu on the system base. */
  gPu: number
  bPu: number
}

/** A load bus converted to constant impedance for the fault study. */
export interface LoadShunt {
  bus: string
  /** Equivalent admittance pu on the system base (g = MW/sBase, b = −MVAR/sBase). */
  gPu: number
  bPu: number
  schedMw: number
  schedMvar: number
}

export interface ExpandedFaults {
  /** Derived input with tap buses, segment lines and impedance-mode loads. */
  input: SolveInput
  taps: FaultTap[]
  tapSet: Set<string>
  loadShunts: LoadShunt[]
}

export function expandFaults(input: SolveInput): ExpandedFaults {
  const faults = input.faults ?? []
  if (faults.length === 0) {
    return { input, taps: [], tapSet: new Set<string>(), loadShunts: [] }
  }

  const s = input.sBaseMva

  // Loads → constant-impedance equivalents at 1 pu (Y = conj(S) pu),
  // accumulated per bus. Scheduled values ride along for the UI.
  const byBus = new Map<string, LoadShunt>()
  for (const ld of input.loads) {
    const cur = byBus.get(ld.bus) ?? { bus: ld.bus, gPu: 0, bPu: 0, schedMw: 0, schedMvar: 0 }
    cur.gPu += ld.mw / s
    cur.bPu += -ld.mvar / s
    cur.schedMw += ld.mw
    cur.schedMvar += ld.mvar
    byBus.set(ld.bus, cur)
  }
  const loadShunts = [...byBus.values()]
  const buses = input.buses.map((b) => {
    const sh = byBus.get(b.id)
    return sh ? { ...b, shuntPu: { g: sh.gPu, b: sh.bPu } } : b
  })

  const lines: LineSpec[] = []
  const taps: FaultTap[] = []

  for (const ln of input.lines) {
    const flt = faults.find((f) => f.lineId === ln.id)
    if (!flt) {
      lines.push(ln)
      continue
    }
    const pct = Math.min(99.5, Math.max(0.5, flt.atPct)) / 100
    const busId = `${ln.id}$F`
    const segA = `${ln.id}$A`
    const segB = `${ln.id}$B`
    const kv = input.buses.find((b) => b.id === ln.from)?.baseKv ?? 345
    const zb = zBaseOhms(kv, input.sBaseMva)
    const z = Math.max(flt.zOhms, BOLTED_OHMS) / zb
    const ang = Math.atan(FAULT_XR)
    const r = z * Math.cos(ang)
    const x = z * Math.sin(ang)
    const den = r * r + x * x
    const g = r / den
    const b = -x / den
    buses.push({ id: busId, label: `Fault on ${ln.id}`, baseKv: kv, shuntPu: { g, b } })
    lines.push(
      { ...ln, id: segA, to: busId, lengthMi: ln.lengthMi * pct, brkTo: true },
      { ...ln, id: segB, from: busId, lengthMi: ln.lengthMi * (1 - pct), brkFrom: true },
    )
    taps.push({ lineId: ln.id, busId, segA, segB, atPct: flt.atPct, zOhms: flt.zOhms, gPu: g, bPu: b })
  }

  return {
    input: { ...input, buses, lines, loads: [] },
    taps,
    tapSet: new Set(taps.map((t) => t.busId)),
    loadShunts,
  }
}
