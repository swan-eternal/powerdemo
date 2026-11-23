/**
 * Network specification types — the boundary layer.
 *
 * Physical / engineering units live here. The solver converts everything to
 * per-unit on the system MVA base internally and converts results back at the
 * edges of `solvePowerFlow`.
 */

export interface BusSpec {
  id: string
  label?: string
  /** Nominal line-to-line kV of the voltage level this bus belongs to. */
  baseKv: number
  /** Shunt admittance to ground, pu on the system base (fault tap points). */
  shuntPu?: { g: number; b: number }
}

export interface LineSpec {
  id: string
  from: string
  to: string
  lengthMi: number
  /** Positive-sequence, per-phase values per mile. */
  rOhmPerMi: number
  xOhmPerMi: number
  /** Total line charging susceptance per mile (S). */
  bSPerMi: number
  ratingMva: number
  /** Breaker at the from end; false = open. Default closed. */
  brkFrom?: boolean
  /** Breaker at the to end; false = open. Default closed. */
  brkTo?: boolean
}

export interface TransformerSpec {
  id: string
  hv: string
  lv: string
  /** Nameplate MVA of one unit. */
  mvaRating: number
  /** Impedance magnitude in pu on own rating. */
  zPuOnOwn: number
  xOverR: number
  /** Off-nominal tap ratio, 1 = nominal. LTC stepping arrives in Part 4. */
  tapPu?: number
  /** Breaker on the unit; false = open. Default closed. */
  brkClosed?: boolean
}

/** Constant-PQ load for now; ZIP coefficients arrive in Part 4. */
export interface LoadSpec {
  id: string
  bus: string
  mw: number
  mvar: number
}

export interface GenSpec {
  id: string
  bus: string
  mwSet: number
  vSetPu: number
  mvaRating: number
  /** Governor droop (pu frequency change per pu power change), used when islanded. */
  droop?: number
  /** Active power ceiling; exceeding it raises an underfrequency alarm. */
  pMaxMw: number
  /** Reactive envelope; enforced from Part 4. */
  qMinMvar: number
  qMaxMvar: number
}

/** Fault path impedance, phase ohms. X/R fixed at 10 (mostly inductive). 0 = bolted. */
export interface FaultSpec {
  lineId: string
  /** Distance along the line from the `from` bus, percent. */
  atPct: number
  zOhms: number
}

export interface SolveInput {
  /** System MVA base for the internal per-unit model. */
  sBaseMva: number
  /**
   * Reference bus for the grid-tied island (the GRID equivalent). Islands
   * without it use their generator as reference; islands without any source
   * are de-energized.
   */
  slackBusId: string
  /** Grid-tied slack voltage setpoint, pu. */
  slackVpu?: number
  buses: BusSpec[]
  lines: LineSpec[]
  transformers: TransformerSpec[]
  loads: LoadSpec[]
  gens: GenSpec[]
  /** Applied line faults (steady-state shunt at a tap point). */
  faults?: FaultSpec[]
}
