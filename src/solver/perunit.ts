/** Base-quantity helpers for the per-unit boundary. */

/** Z_base (ohms) = kV_LL² / MVA_3φ. */
export const zBaseOhms = (baseKv: number, sBaseMva: number): number =>
  (baseKv * baseKv) / sBaseMva

/** I_base (amps) = MVA·10⁶ / (√3 · kV·10³). */
export const iBaseAmps = (baseKv: number, sBaseMva: number): number =>
  (sBaseMva * 1e6) / (Math.sqrt(3) * baseKv * 1000)
