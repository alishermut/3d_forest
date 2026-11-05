# Code audit — 2026-11-05

Static code review of every game. Nothing was played in a browser, so items
marked *(unverified)* are inferred from the code. Deep Forest findings are
already in `games/deep-forest/PLAN.md` (Phase 54.5 and notes in phases
55–66); everything else is listed here until it gets its own plan items.

## Deep Forest

See `games/deep-forest/PLAN.md` → v6 arc. Most important:
- Player movement isn't on the fixed physics step. On high-refresh screens,
  walking, sprinting and jumping run at roughly 42% (Phase 54.5).
- Ctrl as the down key can close the tab (Ctrl+W) (Phase 54.5).
- Wave and water-level logic is copied in five places; the fishing bobber
  doesn't ride the waves (Phase 60).

## Voxelcraft

Plan vs code: phases 0–16 and 19 are marked done, but none was approved
by the user. The plan also claims headless tests that aren't in the repo.

Bugs:
- `world/mobs/mobs.js:299` references an out-of-scope `mob`, which throws.
  Hitting a mob does nothing, so mobs can't be killed.
- `engine/raycast.js:41,63` only targets solid blocks, so torches,
  flowers and grass can't be broken. You also can't place a block into
  water or grass (`main.js:351`).
- Right-clicking a crafting table opens both the 3×3 and 2×2 grids. The
  3×3 is never cleaned up, so items left in it are lost (`main.js:367`,
  `ui/inventory.js:402`).
- Closing the inventory while holding a creative stack fills every empty
  slot (`ui/inventory.js:68-75`).
- Bedrock can be broken; `breakBlock` never checks hardness
  (`main.js:314`).
- The mesher stretches one texture tile across each merged quad, samples
  light/AO only at the quad corners, and builds boundary faces twice
  (`engine/mesher.js:106,186,256`).
- 3D noise has its y/z blend weights swapped, which makes seams in caves
  and ores (`engine/noise.js:114`) *(visual unverified)*.
- Cactus renders at 85% opacity; you can't swim; mob drops of 2 give 1.

Performance: generation, meshing and lighting all run on the main thread,
at least 2 columns per frame. There's one mesh per sub-chunk, so possibly
1–2k draw calls *(unverified)*. Every block edit relights the whole column.

Gaps: no saving, and edits are lost when a chunk unloads. Also missing:
fog at the edge of the view, block-break feedback, a pause/settings menu
and touch support.

Branding: the page title says "Minecraft clone". Several names come from
Minecraft (Deepslate, Redstone, and Creeper/Enderman in the plan). Rename
them to keep it a generic voxel game.

Next: (1) fix the bugs above (S); (2) fix the mesher (M); (3) move
generation and meshing to a Web Worker and use one mesh per column (L);
(4) keep edits on unload, then save to IndexedDB (M); (5) swimming, fog,
break feedback (M).

## Tetris

- Missing: SRS wall-kick tables (it only shifts sideways), lock delay,
  DAS/ARR, high-score saving and a pause overlay.
- Bugs:
  - Holding Space or Up chains hard drops, because `e.repeat` isn't checked.
  - Every unpause starts an extra render loop.
  - The double-tap gesture can hard-drop after game over.
  - The layout overflows on phones.
- "Tetris" is a trademark. Rename it before publishing anything.

Next: SRS kicks + lock delay (M); DAS/ARR (S); high score, pause overlay and
the loop-leak fix (S); responsive layout and touch buttons (M).

## Highlands

Really is at Phase 0 (orbit camera, ground plate, one peak). The `PLAN.md`
has no checklists or checkpoints, and its reuse map points to old forest
paths. Next: rewrite the plan as checklists (S), add a perf HUD (S), then
streamed chunks in a worker (L).

## Water lab

- Bugs:
  - `simplewater-demo.js:135`: the waves are frozen, because the clock is
    never ticked.
  - The ripple sims step a fixed number of times per frame, so wave speed
    depends on frame rate.
  - None of the shaders apply tone mapping or colour space.
  - The Ultra preset can render at 4× pixel ratio.
- Best base for the Deep Forest ocean: `simpleWater.js` combined with
  waterlab's wave table and amplitude/choppiness uniforms. Changes needed
  are listed in the Deep Forest Phase 61 notes.
