import './style.css'
import { makeBaseCase } from './network/baseCase'
import { solvePowerFlow } from './solver/solve'
import { initialControlState, buildCase } from './ui/state'
import { createDiagram, Selection } from './ui/diagram'
import { createPanel } from './ui/faceplate'

// Data flow: controls -> buildCase (immutable rebuild) -> pure solver ->
// snapshot -> diagram + faceplates. The solver warm-starts from the previous
// solution on every change.
const base = makeBaseCase()
const state = initialControlState(base)

const svg = document.getElementById('diagram') as unknown as SVGSVGElement
const badge = document.getElementById('sysbadge')!
const panelHost = document.getElementById('panel')!

const diagram = createDiagram(svg)

let input = buildCase(base, state)
let snap = solvePowerFlow(input)

function refresh(): void {
  input = buildCase(base, state)
  snap = solvePowerFlow(input, snap.converged ? snap.state : undefined)
  diagram.update(snap, input)
  panel.updateValues(snap, input)
  badge.innerHTML = snap.converged
    ? `load <b>${snap.totals.loadMw.toFixed(1)}</b> MW · gen <b>${snap.totals.genMw.toFixed(1)}</b> MW · losses <b>${snap.totals.lossMw.toFixed(2)}</b> MW · NR <b>${snap.iterations}</b> it`
    : 'solver: <b>NOT CONVERGED</b>'
}

const panel = createPanel(panelHost, base, state, refresh)

function select(sel: Selection): void {
  panel.select(sel)
  diagram.setSelected(sel)
}

diagram.onSelect(select)
panel.onDeselect(() => select(null))

refresh()
