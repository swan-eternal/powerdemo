import { Snapshot } from '../solver/solve'
import { SolveInput } from '../solver/spec'

export type Selection =
  | { kind: 'bus'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'xfmr'; id: string }
  | { kind: 'gen'; id: string }
  | { kind: 'load'; id: string }
  | null

export interface DiagramHandle {
  update(snap: Snapshot, input: SolveInput): void
  setSelected(sel: Selection): void
  onSelect(cb: (sel: Selection) => void): void
}

const NS = 'http://www.w3.org/2000/svg'

function e<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  if (parent) parent.appendChild(el)
  return el
}

function text(
  parent: Element,
  x: number,
  y: number,
  cls: string,
  anchor: 'start' | 'middle' | 'end' = 'middle',
  content = '',
): SVGTextElement {
  const t = e('text', { x, y, class: cls, 'text-anchor': anchor }, parent)
  t.textContent = content
  return t
}

interface BusDraw {
  x: number
  y: number
  w: number
  /** User-facing name; '\n' starts a new line. */
  name: string
  nx: number
  ny: number
  anchor: 'start' | 'middle' | 'end'
  v1y: number
  v2y: number
}

const BUS: Record<string, BusDraw> = {
  GRID: { x: 955, y: 145, w: 64, name: 'Grid Tie', nx: 995, ny: 128, anchor: 'start', v1y: 148, v2y: 164 },
  GSUB: { x: 185, y: 305, w: 96, name: 'Generation\nSubstation', nx: 128, ny: 280, anchor: 'end', v1y: 314, v2y: 330 },
  IND_HV: { x: 480, y: 205, w: 84, name: 'Industrial HV', nx: 430, ny: 168, anchor: 'end', v1y: 186, v2y: 202 },
  IND_LV: { x: 480, y: 105, w: 84, name: 'Industrial LV', nx: 428, ny: 88, anchor: 'end', v1y: 104, v2y: 120 },
  RES_HV: { x: 770, y: 255, w: 84, name: 'Residential HV', nx: 720, ny: 192, anchor: 'end', v1y: 208, v2y: 224 },
  RES_LV: { x: 770, y: 395, w: 150, name: 'Residential LV', nx: 685, ny: 386, anchor: 'end', v1y: 402, v2y: 418 },
}

interface LineDraw {
  id: string
  from: [number, number]
  to: [number, number]
  /** flow text block */
  tx: number
  ty: number
}

const LINES: LineDraw[] = [
  { id: 'L_GSUB_IND', from: [185, 305], to: [480, 205], tx: 322, ty: 232 },
  { id: 'L_GSUB_RES', from: [185, 305], to: [770, 255], tx: 455, ty: 316 },
  { id: 'L_IND_RES', from: [480, 205], to: [770, 255], tx: 618, ty: 172 },
  { id: 'L_TIE', from: [955, 145], to: [770, 255], tx: 840, ty: 172 },
]

interface XfmrDraw {
  id: string
  x: number
  yTop: number
  yBot: number
  symY: number
  brkY: number
  label?: string
  lx?: number
}

const XFMRS: XfmrDraw[] = [
  { id: 'T_SU1', x: 167, yTop: 311, yBot: 456, symY: 392, brkY: 437 },
  { id: 'T_SU2', x: 203, yTop: 311, yBot: 456, symY: 392, brkY: 437 },
  { id: 'T_IND', x: 480, yTop: 111, yBot: 199, symY: 155, brkY: 182, label: 'IND', lx: 502 },
  { id: 'T_RES', x: 770, yTop: 261, yBot: 389, symY: 317, brkY: 284, label: 'LTC', lx: 792 },
]

const GEN = { x: 185, y: 480, r: 24 }

const IND_ARROW = { x: 480, y1: 99, y2: 52 } // upward, above Industrial LV
const FEEDERS = [
  { n: 1, x: 710 },
  { n: 2, x: 755 },
  { n: 3, x: 800 },
  { n: 4, x: 840 },
]
const FEEDER_Y1 = 401
const FEEDER_Y2 = 442

const f1 = (x: number, d = 1): string => x.toFixed(d)
const f0 = (x: number): string => x.toFixed(0)

export function createDiagram(host: SVGSVGElement): DiagramHandle {
  const selGroups = new Map<string, SVGGElement>()
  let selectCb: (sel: Selection) => void = () => {}

  const clickable = (g: SVGGElement, sel: NonNullable<Selection>) => {
    selGroups.set(`${sel.kind}:${sel.id}`, g)
    g.classList.add('el')
    g.addEventListener('click', () => selectCb(sel))
  }

  // Live-updatable text nodes.
  const busVal: Record<string, [SVGTextElement, SVGTextElement]> = {}
  const lineVal: Record<string, [SVGTextElement, SVGTextElement]> = {}
  const xfmrVal: Record<string, SVGTextElement> = {}
  const flowEls: Record<string, SVGPathElement> = {}
  let genVal: [SVGTextElement, SVGTextElement]
  let indVal: [SVGTextElement, SVGTextElement]
  const feederVal: Record<string, [SVGTextElement, SVGTextElement]> = {}

  // --- Buses ---
  for (const [id, b] of Object.entries(BUS)) {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    e('rect', { x: b.x - b.w / 2, y: b.y - 3, width: b.w, height: 6, rx: 1, class: 'bar sketch' }, g)
    b.name.split('\n').forEach((line, i) => {
      text(g, b.nx, b.ny + i * 15, 't-name', b.anchor, line)
    })
    busVal[id] = [
      text(g, b.nx, b.v1y, 't-val', b.anchor),
      text(g, b.nx, b.v2y, 't-val', b.anchor),
    ]
    // hit area
    const hit = e('rect', { x: b.x - b.w / 2 - 8, y: b.y - 14, width: b.w + 16, height: 28, class: 'hit' }, g)
    void hit
    clickable(g, { kind: 'bus', id })
  }

  // --- Lines ---
  for (const l of LINES) {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    const d = `M ${l.from[0]} ${l.from[1]} L ${l.to[0]} ${l.to[1]}`
    e('path', { d, class: 'ln sketch' }, g)
    flowEls[l.id] = e('path', { d, class: 'flow off' }, g)
    // breakers at both ends (red = closed; interaction arrives in Part 3)
    for (const t of [0.16, 0.84]) {
      const bx = l.from[0] + t * (l.to[0] - l.from[0])
      const by = l.from[1] + t * (l.to[1] - l.from[1])
      e('rect', { x: bx - 4.5, y: by - 4.5, width: 9, height: 9, class: 'brk closed' }, g)
    }
    lineVal[l.id] = [
      text(g, l.tx, l.ty, 't-val'),
      text(g, l.tx, l.ty + 14, 't-sub'),
    ]
    e('path', { d, class: 'hit' }, g)
    clickable(g, { kind: 'line', id: l.id })
  }

  // --- Transformers ---
  for (const xf of XFMRS) {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    e('path', { d: `M ${xf.x} ${xf.yTop} L ${xf.x} ${xf.yBot}`, class: 'ln sketch' }, g)
    for (const dy of [-7, 7]) {
      e('circle', { cx: xf.x, cy: xf.symY + dy, r: 9, class: 'xfmr-circle sketch' }, g)
    }
    e('rect', { x: xf.x - 4.5, y: xf.brkY - 4.5, width: 9, height: 9, class: 'brk closed' }, g)
    if (xf.label) text(g, xf.lx!, xf.symY - 18, 't-sub', 'start', xf.label)
    xfmrVal[xf.id] = text(g, xf.lx ?? xf.x + (xf.x === 167 ? -12 : 12), xf.symY + 4, 't-sub', 'start', '')
    e('rect', { x: xf.x - 16, y: xf.symY - 22, width: 32, height: 44, class: 'hit' }, g)
    clickable(g, { kind: 'xfmr', id: xf.id })
  }
  // combined loading marker between the two step-up units
  xfmrVal['T_SU'] = text(host, 185, 350, 't-sub', 'middle', '')

  // --- Generator ---
  {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    e('circle', { cx: GEN.x, cy: GEN.y, r: GEN.r, class: 'gen-circle sketch' }, g)
    text(g, GEN.x, GEN.y + 5, 't-name', 'middle', 'G')
    text(g, GEN.x - GEN.r - 14, GEN.y + 4, 't-name', 'end', 'Generator')
    genVal = [
      text(g, GEN.x, GEN.y + 44, 't-val'),
      text(g, GEN.x, GEN.y + 60, 't-val'),
    ]
    e('circle', { cx: GEN.x, cy: GEN.y, r: GEN.r + 12, class: 'hit' }, g)
    clickable(g, { kind: 'gen', id: 'G1' })
  }

  // --- Industrial load arrow (points up, above Industrial LV) ---
  {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    e('path', { d: `M ${IND_ARROW.x} ${IND_ARROW.y1} L ${IND_ARROW.x} ${IND_ARROW.y2}`, class: 'load-arrow sketch' }, g)
    e('path', { d: `M ${IND_ARROW.x - 5} ${IND_ARROW.y2 + 8} L ${IND_ARROW.x} ${IND_ARROW.y2} L ${IND_ARROW.x + 5} ${IND_ARROW.y2 + 8} Z`, class: 'load-head sketch' }, g)
    indVal = [
      text(g, IND_ARROW.x, IND_ARROW.y2 - 16, 't-val'),
      text(g, IND_ARROW.x, IND_ARROW.y2 - 32, 't-sub'),
    ]
    e('rect', { x: IND_ARROW.x - 14, y: IND_ARROW.y2 - 34, width: 28, height: IND_ARROW.y1 - IND_ARROW.y2 + 36, class: 'hit' }, g)
    clickable(g, { kind: 'load', id: 'IND_MAIN' })
  }

  // --- Residential feeders ---
  for (const f of FEEDERS) {
    const g = e('g', { class: 'live' })
    host.appendChild(g)
    e('path', { d: `M ${f.x} ${FEEDER_Y1} L ${f.x} ${FEEDER_Y2}`, class: 'load-arrow sketch' }, g)
    e('path', { d: `M ${f.x - 4.5} ${FEEDER_Y2 - 7} L ${f.x} ${FEEDER_Y2} L ${f.x + 4.5} ${FEEDER_Y2 - 7} Z`, class: 'load-head sketch' }, g)
    text(g, f.x + 9, FEEDER_Y1 + 18, 't-sub', 'start', `F${f.n}`)
    feederVal[f.n] = [
      text(g, f.x, FEEDER_Y2 + 18, 't-val'),
      text(g, f.x, FEEDER_Y2 + 32, 't-sub'),
    ]
    e('rect', { x: f.x - 12, y: FEEDER_Y1, width: 24, height: 52, class: 'hit' }, g)
    clickable(g, { kind: 'load', id: `RES_F${f.n}` })
  }

  const loadingClass = (pct: number): string =>
    pct > 100 ? 't-sub t-alarm' : pct > 90 ? 't-sub t-warn' : 't-sub'

  return {
    update(snap, input) {
      const offline = !snap.converged
      host.classList.toggle('offline', offline)
      document.getElementById('offline-banner')?.classList.toggle('show', offline)
      if (offline) return

      const busById = new Map(snap.buses.map((b) => [b.id, b]))
      const brById = new Map(snap.branches.map((b) => [b.id, b]))

      for (const [id, [t1, t2]] of Object.entries(busVal)) {
        const b = busById.get(id)
        if (!b) continue
        t1.textContent = `${f1(b.kv, 1)} kV · ${b.vmagPu.toFixed(3)} pu`
        t2.textContent = `${f1(b.thetaDeg, 1)}°`
      }

      for (const l of LINES) {
        const br = brById.get(l.id)
        if (!br) continue
        const [t1, t2] = lineVal[l.id]
        t1.textContent = `${f1(br.fromMw)} MW · ${f1(br.fromMvar)} MVAR`
        t2.textContent = `${f0(br.ampsFrom)} A · ${f1(br.loadingPct, 0)}%`
        t2.setAttribute('class', loadingClass(br.loadingPct))

        const flow = flowEls[l.id]
        const mw = Math.abs(br.fromMw)
        if (mw < 0.05) {
          flow.setAttribute('class', 'flow off')
        } else {
          flow.setAttribute('class', `flow ${br.fromMw > 0 ? 'fwd' : 'rev'}`)
          const dur = Math.min(8, Math.max(0.4, 220 / mw))
          flow.style.setProperty('--dur', `${dur.toFixed(2)}s`)
        }
      }

      for (const xf of XFMRS) {
        const br = brById.get(xf.id)
        if (!br) continue
        const t = xfmrVal[xf.id]
        t.textContent = `${f1(br.loadingPct, 0)}%`
        t.setAttribute('class', loadingClass(br.loadingPct))
      }
      const su1 = brById.get('T_SU1')
      const su2 = brById.get('T_SU2')
      if (su1 && su2) {
        const pct = Math.max(su1.loadingPct, su2.loadingPct)
        xfmrVal['T_SU'].textContent = `${f1(pct, 0)}%`
        xfmrVal['T_SU'].setAttribute('class', loadingClass(pct))
      }

      const gen = snap.gens[0]
      const genBus = busById.get('GEN')
      if (gen && genBus) {
        genVal[0].textContent = `${f1(genBus.kv, 1)} kV · ${genBus.vmagPu.toFixed(3)} pu`
        genVal[1].textContent = `${f1(gen.mw)} MW · ${f1(gen.mvar)} MVAR`
      }

      const ind = input.loads.find((l) => l.id === 'IND_MAIN')
      if (ind) {
        indVal[0].textContent = `${f1(ind.mw)} MW · ${f1(ind.mvar)} MVAR`
        const pf = Math.cos(Math.atan2(ind.mvar, ind.mw))
        indVal[1].textContent = `${pf.toFixed(2)} PF · ${f1(Math.hypot(ind.mw, ind.mvar))} MVA`
      }

      for (const f of FEEDERS) {
        const ld = input.loads.find((l) => l.id === `RES_F${f.n}`)
        if (!ld) continue
        feederVal[f.n][0].textContent = `${f1(ld.mw)} MW`
        feederVal[f.n][1].textContent = `${f1(ld.mvar)} MVAR`
      }
    },

    setSelected(sel) {
      for (const [key, g] of selGroups) {
        g.classList.toggle('sel', !!sel && `${sel.kind}:${sel.id}` === key)
      }
    },

    onSelect(cb) {
      selectCb = cb
    },
  }
}
