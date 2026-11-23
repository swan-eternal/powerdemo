import { SolveInput } from '../solver/spec'
import { Snapshot } from '../solver/solve'
import { ControlState } from './state'
import { Selection } from './diagram'

export interface PanelHandle {
  select(sel: Selection): void
  updateValues(snap: Snapshot, input: SolveInput): void
  onDeselect(cb: () => void): void
}

interface SliderDef {
  label: string
  min: number
  max: number
  step: number
  get: () => number
  set: (v: number) => void
  fmt: (v: number) => string
}

interface Row {
  label: string
  bind: (s: Snapshot, i: SolveInput) => string
  alarm?: (s: Snapshot, i: SolveInput) => boolean
  warn?: (s: Snapshot, i: SolveInput) => boolean
}

const f = (x: number, d = 1): string => x.toFixed(d)

export function createPanel(
  host: HTMLElement,
  base: SolveInput,
  state: ControlState,
  onChange: () => void,
): PanelHandle {
  let sel: Selection = null
  let rows: Row[] = []
  const rowEls: { dd: HTMLElement; row: Row }[] = []

  const silOf = (id: string): number => {
    const l = base.lines.find((x) => x.id === id)
    if (!l) return 0
    const zc = Math.sqrt(l.xOhmPerMi / l.bSPerMi)
    const kv = base.buses.find((b) => b.id === l.from)!.baseKv
    return (kv * kv) / zc
  }

  function card(title: string, tag = ''): HTMLElement {
    const div = document.createElement('div')
    div.className = 'card'
    const h = document.createElement('h2')
    h.textContent = title
    if (tag) {
        const span = document.createElement('span')
        span.className = 'tag'
        span.textContent = tag
        h.appendChild(span)
    }
    div.appendChild(h)
    host.appendChild(div)
    return div
  }

  function kvList(c: HTMLElement, list: Row[]): void {
    const dl = document.createElement('dl')
    dl.className = 'kv'
    for (const row of list) {
      const dt = document.createElement('dt')
      dt.textContent = row.label
      const dd = document.createElement('dd')
      dl.appendChild(dt)
      dl.appendChild(dd)
      rowEls.push({ dd, row })
    }
    c.appendChild(dl)
  }

  function sliders(c: HTMLElement, defs: SliderDef[]): void {
    for (const s of defs) {
      const wrap = document.createElement('div')
      wrap.className = 'ctl'
      const label = document.createElement('label')
      const out = document.createElement('output')
      out.textContent = s.fmt(s.get())
      label.append(s.label, out)
      const rng = document.createElement('input')
      rng.type = 'range'
      rng.min = String(s.min)
      rng.max = String(s.max)
      rng.step = String(s.step)
      rng.value = String(s.get())
      rng.addEventListener('input', () => {
        const v = Number(rng.value)
        s.set(v)
        out.textContent = s.fmt(v)
        onChange()
      })
      wrap.append(label, rng)
      c.appendChild(wrap)
    }
  }

  function link(textContent: string, onClick: () => void): void {
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = textContent
    a.className = 'hint'
    a.style.display = 'block'
    a.style.marginBottom = '4px'
    a.addEventListener('click', (ev) => {
      ev.preventDefault()
      onClick()
    })
    host.appendChild(a)
  }

  function render(): void {
    host.innerHTML = ''
    rowEls.length = 0
    rows = []

    if (!sel) {
      const c = card('System', 'overview')
      rows = [
        {
          label: 'Load',
          bind: (s) => `${f(s.totals.loadMw)} MW · ${f(s.totals.loadMvar)} MVAR`,
        },
        {
          label: 'Generation',
          bind: (s) => `${f(s.totals.genMw)} MW · ${f(s.totals.genMvar)} MVAR`,
        },
        { label: 'Losses', bind: (s) => `${f(s.totals.lossMw, 2)} MW` },
        {
          label: 'Grid tie (export +)',
          bind: (s) => {
            const tie = s.branches.find((b) => b.id === 'L_TIE')
            return tie ? `${f(tie.fromMw)} MW` : '—'
          },
        },
        {
          label: 'Balance residual',
          bind: (s) => `${s.totals.balanceResidualMw.toExponential(1)} MW`,
        },
        {
          label: 'Solver',
          bind: (s) => (s.converged ? `converged · ${s.iterations} NR iters` : 'NOT CONVERGED'),
          alarm: (s) => !s.converged,
        },
      ]
      kvList(c, rows)

      const hint = card('How to use')
      hint.innerHTML +=
        '<p class="hint">Click any element on the one-line — bus, line, transformer, generator or load — to open its faceplate with readouts and controls. Generator MW/voltage, load MW/power factor and line length are live. Breaker switching, LTC taps and ZIP loads arrive in Parts 3–4.</p>'
      return
    }

    link('← system overview', () => {
      // Caller re-renders via select(null) through the diagram's deselect.
      deselectHook()
    })

    if (sel.kind === 'gen') {
      const c = card('Generator G1', 'PV bus')
      rows = [
        { label: 'Output', bind: (s) => `${f(s.gens[0].mw)} MW · ${f(s.gens[0].mvar)} MVAR` },
        {
          label: 'Terminal',
          bind: (s) => {
            const b = s.buses.find((x) => x.id === 'GEN')
            return b ? `${f(b.kv)} kV · ${b.vmagPu.toFixed(3)} pu · ${f(b.thetaDeg)}°` : '—'
          },
        },
        { label: 'Reactive limits', bind: () => 'enforced in Part 4' },
      ]
      kvList(c, rows)
      sliders(c, [
        {
          label: 'MW setpoint',
          min: 0,
          max: 220,
          step: 1,
          get: () => state.gen.mwSet,
          set: (v) => (state.gen.mwSet = v),
          fmt: (v) => `${f(v, 0)} MW`,
        },
        {
          label: 'Voltage setpoint',
          min: 0.95,
          max: 1.07,
          step: 0.005,
          get: () => state.gen.vSetPu,
          set: (v) => (state.gen.vSetPu = v),
          fmt: (v) => `${v.toFixed(3)} pu`,
        },
      ])
      return
    }

    if (sel.kind === 'line') {
      const c = card(sel.id, 'line')
      rows = [
        {
          label: 'Flow (from end)',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.fromMw)} MW · ${f(br.fromMvar)} MVAR` : '—'
          },
        },
        {
          label: 'Flow (to end)',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.toMw)} MW · ${f(br.toMvar)} MVAR` : '—'
          },
        },
        {
          label: 'Current',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.ampsFrom, 0)} A` : '—'
          },
        },
        {
          label: 'Loading',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.loadingPct, 0)}%` : '—'
          },
          warn: (s) => pctOf(s, sel!.id) > 90,
          alarm: (s) => pctOf(s, sel!.id) > 100,
        },
        {
          label: 'Losses',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.lossMw, 2)} MW` : '—'
          },
        },
        { label: 'Surge impedance loading', bind: () => `${f(silOf(sel!.id), 0)} MW` },
      ]
      kvList(c, rows)
      sliders(c, [
        {
          label: 'Length',
          min: 5,
          max: 60,
          step: 1,
          get: () => state.lines[sel!.id],
          set: (v) => (state.lines[sel!.id] = v),
          fmt: (v) => `${v} mi`,
        },
      ])
      return
    }

    if (sel.kind === 'xfmr') {
      const c = card(sel.id, 'transformer')
      rows = [
        {
          label: 'Flow (HV end)',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.fromMw)} MW · ${f(br.fromMvar)} MVAR` : '—'
          },
        },
        {
          label: 'Flow (LV end)',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.toMw)} MW · ${f(br.toMvar)} MVAR` : '—'
          },
        },
        {
          label: 'Current HV / LV',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.ampsFrom, 0)} A / ${f(br.ampsTo, 0)} A` : '—'
          },
        },
        {
          label: 'Loading',
          bind: (s) => {
            const br = s.branches.find((b) => b.id === sel!.id)
            return br ? `${f(br.loadingPct, 0)}%` : '—'
          },
          warn: (s) => pctOf(s, sel!.id) > 90,
          alarm: (s) => pctOf(s, sel!.id) > 100,
        },
      ]
      kvList(c, rows)
      const note = card('Note')
      note.innerHTML += '<p class="hint">Tap raise/lower (LTC) and transformer isolation arrive in Part 4.</p>'
      return
    }

    if (sel.kind === 'bus') {
      const c = card(sel.id, 'bus')
      rows = [
        {
          label: 'Voltage',
          bind: (s) => {
            const b = s.buses.find((x) => x.id === sel!.id)
            return b ? `${f(b.kv)} kV · ${b.vmagPu.toFixed(3)} pu` : '—'
          },
          warn: (s) => {
            const b = s.buses.find((x) => x.id === sel!.id)
            return b ? b.vmagPu < 0.97 || b.vmagPu > 1.03 : false
          },
        },
        {
          label: 'Angle',
          bind: (s) => {
            const b = s.buses.find((x) => x.id === sel!.id)
            return b ? `${f(b.thetaDeg)}°` : '—'
          },
        },
        {
          label: 'Net injection',
          bind: (s) => {
            const b = s.buses.find((x) => x.id === sel!.id)
            return b ? `${f(b.pMw)} MW · ${f(b.qMvar)} MVAR` : '—'
          },
        },
      ]
      kvList(c, rows)
      return
    }

    if (sel.kind === 'load') {
      const isInd = sel.id === 'IND_MAIN'
      const n = Number(sel.id.slice(-1))
      const c = card(isInd ? 'Industrial load' : `Residential feeder F${n}`, isInd ? 'IND_LV' : 'RES_LV')
      const loadOf = (i: SolveInput) => i.loads.find((l) => l.id === sel!.id)
      rows = [
        {
          label: 'Demand',
          bind: (_s, i) => {
            const ld = loadOf(i)
            return ld ? `${f(ld.mw)} MW · ${f(ld.mvar)} MVAR` : '—'
          },
        },
        {
          label: 'Power factor',
          bind: (_s, i) => {
            const ld = loadOf(i)
            return ld ? Math.cos(Math.atan2(ld.mvar, ld.mw)).toFixed(3) : '—'
          },
        },
        {
          label: 'Apparent power',
          bind: (_s, i) => {
            const ld = loadOf(i)
            return ld ? `${f(Math.hypot(ld.mw, ld.mvar))} MVA` : '—'
          },
        },
      ]
      kvList(c, rows)
      if (isInd) {
        sliders(c, [
          {
            label: 'MW',
            min: 0,
            max: 150,
            step: 1,
            get: () => state.ind.mw,
            set: (v) => (state.ind.mw = v),
            fmt: (v) => `${f(v, 0)} MW`,
          },
          {
            label: 'Power factor',
            min: 0.7,
            max: 1.0,
            step: 0.01,
            get: () => state.ind.pf,
            set: (v) => (state.ind.pf = v),
            fmt: (v) => v.toFixed(2),
          },
        ])
      } else {
        const fd = state.feeders.find((x) => x.n === n)!
        sliders(c, [
          {
            label: 'MW',
            min: 0,
            max: 30,
            step: 0.5,
            get: () => fd.mw,
            set: (v) => (fd.mw = v),
            fmt: (v) => `${f(v, 1)} MW`,
          },
          {
            label: 'Power factor',
            min: 0.85,
            max: 1.0,
            step: 0.01,
            get: () => fd.pf,
            set: (v) => (fd.pf = v),
            fmt: (v) => v.toFixed(2),
          },
        ])
      }
    }
  }

  function pctOf(s: Snapshot, id: string): number {
    return s.branches.find((b) => b.id === id)?.loadingPct ?? 0
  }

  let deselectHook: () => void = () => {}
  render()

  return {
    select(next) {
      sel = next
      render()
    },
    updateValues(snap, input) {
      for (const { dd, row } of rowEls) {
        dd.textContent = row.bind(snap, input)
        dd.className = ''
        if (row.alarm?.(snap, input)) dd.className = 'alarm'
        else if (row.warn?.(snap, input)) dd.className = 'warn'
      }
    },
    onDeselect(cb: () => void) {
      deselectHook = cb
    },
  }
}
