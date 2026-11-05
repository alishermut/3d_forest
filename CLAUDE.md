# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A sandbox of browser games built with Three.js r184 + Vite 8, vanilla ES
modules, no framework. One Vite project serves many games: the root
`index.html` is a launcher, and each game lives in `games/<name>/`.
See `README.md` for the game list.

## Commands

- `npm install --legacy-peer-deps` installs deps. The flag is required because
  `three-good-godrays` pins `three <= 0.182`.
- `npm run dev` starts the dev server at http://localhost:5173. Each game is
  at `/games/<name>/`.
- `npm run build` builds every page into `dist/`. It's the quickest
  whole-repo check that imports still resolve.
- `node scripts/inspect-glb.mjs` lists animations, meshes and triangle counts
  for `public/models/*.glb`.

There are no tests or linters. To verify a change, build it and then load
the page in a browser. Chromium + Playwright are available in cloud sessions
for screenshots.

## Structure and rules

- **One folder per game.** `games/<name>/index.html` loads `./src/main.js`
  (water-lab has several HTML pages instead). Games never import from each
  other. If code needs sharing, copy it, or ask before creating a shared module.
- **New pages must be registered** in `vite.config.js`
  (`build.rollupOptions.input`), in the launcher `index.html`, and in the
  table in `README.md`.
- **Assets** go in the repo-root `public/` and are referenced by absolute
  path (`/models/deer.glb`, `/textures/...`, `/audio/...`). Record the
  license of every new third-party asset in `public/models/LICENSES.md` and
  in the game's README credits.
- **PLAN.md workflow.** Bigger games (`deep-forest`, `voxelcraft`, `highlands`)
  have a phased `PLAN.md`. Each phase ends with a browser-verified
  CHECKPOINT. Don't start the next phase until the user says "approved".
  Tick checklist items as they land.

## Deep Forest notes (`games/deep-forest/`)

- Entry: `src/main.js`. Modules: `src/core/` (HUD, stats, physics, asset
  loading), `src/player/` (controls), `src/world/` (terrain, trees, grass,
  water, atmosphere, wildlife), `src/weapons/` (weapons and fishing).
- `getHeight(x, z)` in `src/world/terrain.js` is the single source of truth
  for ground height. Everything placed on the ground samples it.
- Performance budget: keep heavy content instanced. Measure with the
  benchmark (`G` → Performance → run benchmark), before and after each
  phase. It reports GPU ms, CPU ms, draw calls and triangles at 4 fixed
  spots. Frame totals across all passes are ~370–880 calls and 6–10 M
  triangles (2026-11 baseline). `F3` shows live fps, calls and triangles.
- `G` opens the settings panel (`src/core/settings.js`). New tunables go in
  a folder there, not on new hotkeys.
- Headless Chromium here uses software GL: Deep Forest renders at seconds
  per frame, so perf numbers must come from the user's machine. To
  screenshot, stop the loop (`__renderer.setAnimationLoop(null)`) or
  render just the viewmodel.
- Post-processing uses `postprocessing` (EffectComposer), `n8ao` and
  `three-good-godrays` on the WebGL renderer.
- Physics is `@dimforge/rapier3d-compat`.
