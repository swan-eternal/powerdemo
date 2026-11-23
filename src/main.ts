import './style.css'
import { makeBaseCase } from './network/baseCase'
import { solvePowerFlow } from './solver/solve'
import { initialControlState, buildCase } from './ui/state'
import { createDiagram, Selection } from './ui/diagram'
import { createPanel } from './ui/faceplate'

// Data flow: controls -> buildCase (immutable rebuild) -> pure solver ->
// snapshot -> diagram + faceplates + alarms. The solver warm-starts from the
// previous solution on every change; failed islands hold their last good
// state and raise a collapse alarm.
const base = makeBaseCase()
const state = initialControlState(base)

const svg = document.getElementById('diagram') as unknown as SVGSVGElement
const badge = document.getElementById('sysbadge')!
const alarmsHost = document.getElementById('alarms')!
const panelHost = document.getElementById('panel-body')!

const diagram = createDiagram(svg)

let input = buildCase(base, state)
let snap = solvePowerFlow(input)

const ALARM_LABEL: Record<string, string> = {
  'voltage-low': 'Low voltage',
  'voltage-high': 'High voltage',
  overload: 'Overload',
  underfreq: 'Underfrequency',
  overfreq: 'Overfrequency',
  collapse: 'Collapse',
  'dead-island': 'De-energized',
}

const whereLabel = (w: string): string => base.buses.find((b) => b.id === w)?.label ?? w

function renderAlarms(): void {
  const items = snap.alarms
    .map(
      (a) =>
        `<div class="alarm-item ${a.severity}">${a.severity === 'alarm' ? '⚠ ' : ''}${ALARM_LABEL[a.kind] ?? a.kind} — ${whereLabel(a.where)}: ${a.detail}</div>`,
    )
    .join('')
  alarmsHost.innerHTML = `<div class="card"><h2>Alarms</h2><div class="alarm-list">${items || '<div class="alarm-item ok">No active alarms</div>'}</div></div>`
}

function refresh(): void {
  input = buildCase(base, state)
  snap = solvePowerFlow(input, { byBus: snap.state.byBus })
  diagram.update(snap, input)
  panel.updateValues(snap, input)
  renderAlarms()
  const fBad = snap.alarms.some((a) => a.kind === 'underfreq' || a.kind === 'overfreq')
  const alarmCount = snap.alarms.filter((a) => a.severity === 'alarm').length
  const collapseTag = snap.collapse ? '<span class="freq-bad">⚠ collapse · </span>' : ''
  badge.innerHTML =
    `${collapseTag}load <b>${snap.totals.loadMw.toFixed(1)}</b> MW · gen <b>${snap.totals.genMw.toFixed(1)}</b> MW · ` +
    `<span class="${fBad ? 'freq-bad' : ''}"><b>${snap.frequencyHz.toFixed(2)} Hz</b></span> · ` +
    `losses <b>${snap.totals.lossMw.toFixed(2)}</b> MW · NR <b>${snap.iterations}</b> it` +
    (alarmCount ? ` · <span class="freq-bad">⚠ <b>${alarmCount}</b></span>` : '')
}

const panel = createPanel(panelHost, base, state, refresh)

function select(sel: Selection): void {
  panel.select(sel)
  diagram.setSelected(sel)
}

diagram.onSelect(select)
panel.onDeselect(() => select(null))

refresh()
