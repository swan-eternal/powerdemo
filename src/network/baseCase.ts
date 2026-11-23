import { SolveInput } from '../solver/spec'

/**
 * Base-case network: seven buses, 230 kV backbone, grid tie at RES_HV
 * (architecture decision, 2026-11-23). All values are editable data —
 * Jason's numbers replace these as the app grows.
 *
 * Line constants: typical 230 kV, 0.055 + j0.77 Ω/mi, 5.2 µS/mi
 * → Zc ≈ 385 Ω, SIL ≈ 137 MW.
 */
export function makeBaseCase(): SolveInput {
  return {
    sBaseMva: 100,
    slackBusId: 'GRID',
    slackVpu: 1.0,
    buses: [
      { id: 'GRID', label: 'Grid equivalent', baseKv: 230 },
      { id: 'GEN', label: 'Generator terminal', baseKv: 13.8 },
      { id: 'GSUB', label: 'Gen substation HV', baseKv: 230 },
      { id: 'IND_HV', label: 'Industrial HV', baseKv: 230 },
      { id: 'IND_LV', label: 'Industrial LV', baseKv: 69 },
      { id: 'RES_HV', label: 'Residential HV', baseKv: 230 },
      { id: 'RES_LV', label: 'Residential LV', baseKv: 34.5 },
    ],
    lines: [
      { id: 'L_GSUB_IND', from: 'GSUB', to: 'IND_HV', lengthMi: 25, rOhmPerMi: 0.055, xOhmPerMi: 0.77, bSPerMi: 5.2e-6, ratingMva: 300 },
      { id: 'L_GSUB_RES', from: 'GSUB', to: 'RES_HV', lengthMi: 30, rOhmPerMi: 0.055, xOhmPerMi: 0.77, bSPerMi: 5.2e-6, ratingMva: 300 },
      { id: 'L_IND_RES', from: 'IND_HV', to: 'RES_HV', lengthMi: 15, rOhmPerMi: 0.055, xOhmPerMi: 0.77, bSPerMi: 5.2e-6, ratingMva: 300 },
      { id: 'L_TIE', from: 'GRID', to: 'RES_HV', lengthMi: 20, rOhmPerMi: 0.055, xOhmPerMi: 0.77, bSPerMi: 5.2e-6, ratingMva: 300 },
    ],
    transformers: [
      // Two parallel step-up units at the plant.
      { id: 'T_SU1', hv: 'GSUB', lv: 'GEN', mvaRating: 120, zPuOnOwn: 0.085, xOverR: 35 },
      { id: 'T_SU2', hv: 'GSUB', lv: 'GEN', mvaRating: 120, zPuOnOwn: 0.085, xOverR: 35 },
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
