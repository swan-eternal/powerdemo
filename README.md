# PowerDemo

Interactive small-power-system demo for GitHub Pages: a 7-bus network with a
full Newton-Raphson power flow solved in the browser on every control change.

**Live:** https://swan-eternal.github.io/powerdemo/

Status: **Part 4 — Q-limits, cap banks, LTC tap, ZIP loads.** G1 enforces
its reactive envelope (PV→PQ bus-type switching with alarms), two switchable
12 MVAR cap banks live at Industrial LV, T_RES carries a ±10% LTC, and loads
ride a ZIP mix that sheds with voltage. Motor start was cut — a dynamic
event the steady-state solver shouldn't fake.

## Commands

- `npm install`
- `npm test` — solver test suite (Vitest)
- `npm run dev` — placeholder harness page (text dump)
- `npm run build` — static bundle for Pages

## Layout

- `src/solver/` — pure solver, no UI knowledge: complex helpers, network spec
  types, Ybus assembly, Newton-Raphson, solve orchestration
- `src/network/baseCase.ts` — the 7-bus base case as editable data
- Architecture doc: "PowerDemo Architecture" (Obsidian vault)
