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
  /** Breaker state; false removes the branch from the model. */
  inService?: boolean
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
  inService?: boolean
}

/** Constant-PQ load for Part 1; ZIP coefficients arrive in Part 4. */
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
  /** Reactive envelope; enforced from Part 4. */
  qMinMvar: number
  qMaxMvar: number
}

export interface SolveInput {
  /** System MVA base for the internal per-unit model. */
  sBaseMva: number
  /** Slack bus id for Part 1 (single island); per-island reference selection arrives in Part 3. */
  slackBusId: string
  /** Slack voltage setpoint, pu. */
  slackVpu?: number
  buses: BusSpec[]
  lines: LineSpec[]
  transformers: TransformerSpec[]
  loads: LoadSpec[]
  gens: GenSpec[]
}
