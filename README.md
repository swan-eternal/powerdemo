# PowerDemo

Interactive small-power-system demo for GitHub Pages: a 7-bus network with a
full Newton-Raphson power flow solved in the browser on every control change.

**Live:** https://swan-eternal.github.io/powerdemo/

Status: **Part 2 — one-line diagram with live values and controls.** Breakers,
islanding and alarms arrive in Part 3; reactive limits, LTC and ZIP loads in
Part 4.

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
