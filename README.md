# Fertile Life — Conway’s GoL with Soil

A fast 2D Game of Life (200×200 by default) where dead cells become fertile soil that diffuses and powers future births.

## What’s new vs. Conway

Each cell tracks:

- `A[i,j] ∈ {0,1}` — alive
- `F[i,j] ≥ 0` — fertility (soil)

Per tick:

- Birth if dead, `neighbors == 3` and `E ≥ τ`
- Survive if alive, `neighbors ∈ {2,3}` and `E ≥ σ`
- Soil events: death `+α`, birth `−β`, survival `−κ`
- Diffuse & decay: `F ← F + d(⟨F_nbr⟩ − F)`, then `F ← (1−δ)F`
- Effective fertility: `E = w0·F + w1·⟨F_nbr⟩`

Recommended baseline (“earthlike”):

- Initial soil: `F0 = 0.7` (uniform)
- Params:
  - `τ = 0.50`
  - `σ = 0.10`
  - `α = 1.0`
  - `β = 0.4`
  - `κ = 0.03`
  - `d = 0.30`
  - `δ = 0.008`
  - `w0 = 0.6`
  - `w1 = 0.4`

## Stack

- Vue 3 + Vite + TypeScript (UI)
- Canvas 2D (single blit per frame)
- Web Worker (simulation on typed arrays)

## Features

- Place/erase cells (drag)
- Play/Pause, single Step, speed slider
- Reset (clears life and re-seeds soil to F0)
- Zoom (wheel or toolbar ±) and pan (Space/middle-drag)
- 200×200 toroidal grid, fertility heatmap under live cells

## Controls

- **Draw:** left-drag
- **Erase:** Alt+drag or right-drag
- **Pan:** hold Space or middle-drag
- **Zoom:** mouse wheel or toolbar ±
- **Transport:** Play/Pause, Step, Reset

## Quick start

Requires Node 18+.

```sh
npm install
npm run dev      # open the shown URL (e.g., http://localhost:5173)

# Production build
npm run build
npm run preview  # serves the dist build
```

Tip: If you use pnpm, there’s a pnpm-lock.yaml; the npm scripts work the same with pnpm.

## Config

- **Grid size:** change `WIDTH` and `HEIGHT` in [src/App.vue](src/App.vue).
- **Rules/soil:** tweak `params` in [src/App.vue](src/App.vue) (`f0, tau, sigma, alpha, beta, kappa, d, delta, w0`). The UI is the source of truth and pushes values to the worker; `w1` is computed as `1 - w0`. Reset uses the current `f0`.

## How it stays fast

- Zero per‑cell DOM work
- Typed arrays, branch‑light kernel
- One putImageData to a back buffer, then one drawImage per frame
- Worker keeps UI responsive

## Folder layout

- [index.html](index.html)
- [vite.config.ts](vite.config.ts)
- [tsconfig.json](tsconfig.json)
- [package.json](package.json)
- src/
  - [App.vue](src/App.vue) — UI, canvas, input, viewport, params
  - [main.ts](src/main.ts) — Vue mount
  - [simWorker.ts](src/simWorker.ts) — simulation & rendering buffer
  - [styles.css](src/styles.css) — UI styles

## License

MIT (feel free to adapt).
