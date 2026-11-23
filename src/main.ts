import { makeBaseCase } from './network/baseCase'
import { solvePowerFlow } from './solver/solve'

// Part 1 placeholder harness — the one-line diagram UI replaces this in Part 2.
const snap = solvePowerFlow(makeBaseCase())

const el = document.getElementById('app')!
const out: string[] = ['PowerDemo — solver harness (Part 1)', '']
const f = (x: number, d = 2): string => x.toFixed(d)

if (snap.converged) {
  for (const b of snap.buses) {
    out.push(
      `${b.id.padEnd(7)} ${f(b.vmagPu, 4)} pu  ${f(b.kv, 1).padStart(6)} kV  ${f(b.thetaDeg, 2).padStart(7)}°  P ${f(b.pMw, 1).padStart(6)} MW  Q ${f(b.qMvar, 1).padStart(6)} MVAR`,
    )
  }
  out.push('')
  for (const br of snap.branches) {
    out.push(
      `${br.id.padEnd(11)} ${br.from}→${br.to}  ${f(br.fromMw, 1).padStart(6)}/${f(br.toMw, 1).padStart(6)} MW  ${f(br.ampsFrom, 0).padStart(4)} A  load ${f(br.loadingPct, 1)}%`,
    )
  }
  out.push('')
  out.push(
    `load ${f(snap.totals.loadMw, 1)} MW · gen ${f(snap.totals.genMw, 1)} MW · losses ${f(snap.totals.lossMw, 2)} MW · residual ${snap.totals.balanceResidualMw.toExponential(2)} MW · ${snap.iterations} iterations`,
  )
} else {
  out.push('DID NOT CONVERGE')
}
el.textContent = out.join('\n')
