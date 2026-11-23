# PowerDemo

Interactive small-power-system demo for GitHub Pages: a 7-bus network with a
full Newton-Raphson power flow solved in the browser on every control change.

**Live:** https://swan-eternal.github.io/powerdemo/

Status: **Line faults — apply from any line faceplate at a chosen position and
impedance; isolate with the breakers.** Reactive limits, LTC taps, ZIP loads
and motor start arrive in Part 4.

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
