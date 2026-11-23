import { SolveInput } from '../solver/spec'

/**
 * Base-case network: seven buses, 345 kV backbone, grid tie at RES_HV
 * (architecture decision, 2026-11-23). All values are editable data —
 * Jason's numbers replace these as the app grows.
 *
 * Line constants: typical 345 kV, 0.04 + j0.68 Ω/mi, 6.9 µS/mi
 * → Zc ≈ 314 Ω, SIL ≈ 379 MW.
 */
export function makeBaseCase(): SolveInput {
  return {
    sBaseMva: 100,
    slackBusId: 'GRID',
    slackVpu: 1.0,
    buses: [
      { id: 'GRID', label: 'Grid Tie', baseKv: 345 },
      { id: 'GEN', label: 'Generator Terminal', baseKv: 13.8 },
      { id: 'GSUB', label: 'Generation Substation', baseKv: 345 },
      { id: 'IND_HV', label: 'Industrial High Voltage', baseKv: 345 },
      { id: 'IND_LV', label: 'Industrial Low Voltage', baseKv: 69 },
      { id: 'RES_HV', label: 'Residential High Voltage', baseKv: 345 },
      { id: 'RES_LV', label: 'Residential Low Voltage', baseKv: 34.5 },
    ],
    lines: [
      { id: 'L_GSUB_IND', from: 'GSUB', to: 'IND_HV', lengthMi: 25, rOhmPerMi: 0.04, xOhmPerMi: 0.68, bSPerMi: 6.9e-6, ratingMva: 500 },
      { id: 'L_GSUB_RES', from: 'GSUB', to: 'RES_HV', lengthMi: 30, rOhmPerMi: 0.04, xOhmPerMi: 0.68, bSPerMi: 6.9e-6, ratingMva: 500 },
      { id: 'L_IND_RES', from: 'IND_HV', to: 'RES_HV', lengthMi: 15, rOhmPerMi: 0.04, xOhmPerMi: 0.68, bSPerMi: 6.9e-6, ratingMva: 500 },
      { id: 'L_TIE', from: 'GRID', to: 'RES_HV', lengthMi: 20, rOhmPerMi: 0.04, xOhmPerMi: 0.68, bSPerMi: 6.9e-6, ratingMva: 500 },
    ],
    transformers: [
      // Two parallel step-up units at the plant (345 kV class).
      { id: 'T_SU1', hv: 'GSUB', lv: 'GEN', mvaRating: 120, zPuOnOwn: 0.1, xOverR: 40 },
      { id: 'T_SU2', hv: 'GSUB', lv: 'GEN', mvaRating: 120, zPuOnOwn: 0.1, xOverR: 40 },
      { id: 'T_IND', hv: 'IND_HV', lv: 'IND_LV', mvaRating: 100, zPuOnOwn: 0.09, xOverR: 30 },
      { id: 'T_RES', hv: 'RES_HV', lv: 'RES_LV', mvaRating: 75, zPuOnOwn: 0.08, xOverR: 25 },
    ],
    loads: [
      // Industrial: 90 MW at 0.85 PF.
      { id: 'IND_MAIN', bus: 'IND_LV', mw: 90, mvar: 55.8 },
      // Residential: four feeders, 15 MW at 0.95 PF each.
      { id: 'RES_F1', bus: 'RES_LV', mw: 15, mvar: 4.93 },
      { id: 'RES_F2', bus: 'RES_LV', mw: 15, mvar: 4.93 },
      { id: 'RES_F3', bus: 'RES_LV', mw: 15, mvar: 4.93 },
      { id: 'RES_F4', bus: 'RES_LV', mw: 15, mvar: 4.93 },
    ],
    gens: [
      {
        id: 'G1',
        bus: 'GEN',
        mwSet: 150,
        vSetPu: 1.02,
        mvaRating: 220,
        qMinMvar: -50,
        qMaxMvar: 90,
      },
    ],
  }
}
