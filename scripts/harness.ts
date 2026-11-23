// Headless solver check (dev tool, not part of the app bundle).
import { makeBaseCase } from '../src/network/baseCase'
import { solvePowerFlow } from '../src/solver/solve'

const snap = solvePowerFlow(makeBaseCase())
const f = (x: number, d = 2): string => x.toFixed(d)

if (!snap.converged) {
  console.log('DID NOT CONVERGE')
} else {
  for (const b of snap.buses) {
    console.log(
      `${b.id.padEnd(7)} ${f(b.vmagPu, 4)} pu  ${f(b.kv, 1).padStart(6)} kV  ${f(b.thetaDeg, 2).padStart(7)}°  P ${f(b.pMw, 1).padStart(6)} MW  Q ${f(b.qMvar, 1).padStart(6)} MVAR`,
    )
  }
  console.log('')
  for (const br of snap.branches) {
    console.log(
      `${br.id.padEnd(11)} ${br.from}→${br.to}  ${f(br.fromMw, 1).padStart(6)}/${f(br.toMw, 1).padStart(6)} MW  ${f(br.ampsFrom, 0).padStart(4)} A  load ${f(br.loadingPct, 1)}%`,
    )
  }
  console.log('')
  console.log(
    `load ${f(snap.totals.loadMw, 1)} MW · gen ${f(snap.totals.genMw, 1)} MW · losses ${f(snap.totals.lossMw, 2)} MW · residual ${snap.totals.balanceResidualMw.toExponential(2)} MW · ${snap.iterations} iterations`,
  )
  for (const g of snap.gens) {
    console.log(`${g.id}: ${f(g.mw, 1)} MW, ${f(g.mvar, 1)} MVAR`)
  }
}
