# Game Sandbox

Browser games and graphics experiments built with
[Three.js](https://threejs.org) (r184) + [Vite](https://vitejs.dev).
Each game lives in its own folder under `games/`.

## Run

```bash
npm install --legacy-peer-deps
npm run dev
```

Open http://localhost:5173 for a launcher page that links to every game.
`npm run build` writes a static build of all pages to `dist/`.

> `--legacy-peer-deps` is needed because `three-good-godrays@0.12` declares
> `three <= 0.182` as a peer, while the repo uses `three@0.184`.

## Games

| Folder | What it is | Status |
|---|---|---|
| [`games/deep-forest/`](games/deep-forest/) | First-person foggy forest: instanced trees and grass, lake and river, mountains, wildlife, weapons, a fishing minigame, day/night cycle. | Main project, most complete |
| [`games/voxelcraft/`](games/voxelcraft/) | Voxel sandbox: streamed chunks, caves, ores, biomes, villages, lighting, flowing water, inventory, crafting, mobs. | In progress (see its `PLAN.md`) |
| [`games/tetris/`](games/tetris/) | Classic falling-blocks puzzle in one self-contained HTML file (2D canvas, no Three.js). | Playable |
| [`games/highlands/`](games/highlands/) | Scaffold for a large low-poly streamed world with mountains and clouds. | Phase 0 only |
| [`games/water-lab/`](games/water-lab/) | Water-rendering tech demos: tuner/benchmark, simple surface, ocean, pool, WebGPU particle fluid. | Experiments, not a game |

Each game folder holds its own `index.html` (entry page), `src/` (code) and,
where it has one, a `PLAN.md` (phased build plan) and `README.md`.

## Repo layout

```
index.html          launcher page linking to every game
games/<name>/       one folder per game (index.html, src/, PLAN.md)
public/             static assets served at / (currently Deep Forest's
                    models, textures, audio, Draco decoder)
scripts/            dev utilities (e.g. inspect-glb.mjs)
vite.config.js      multi-page build: lists every game's HTML entry
```

## Adding a game

1. Create `games/<name>/index.html` that loads `./src/main.js`.
2. Add the page to `build.rollupOptions.input` in `vite.config.js`.
3. Add a card to the root `index.html` and a row to the table above.

Asset credits for Deep Forest are in `games/deep-forest/README.md` and
`public/models/LICENSES.md`.
