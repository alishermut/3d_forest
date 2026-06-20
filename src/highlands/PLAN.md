# Highlands — big stylized streamed world (subproject)

A **separate world/mode** that lives alongside the Deep Forest without touching it.
Own entry (`/highlands.html` → `/src/highlands/main.js`), own `src/highlands/`
folder. The forest (`index.html` → `src/main.js`) is never modified.

## Vision

A large, low-poly, procedurally-generated world you can roam far into: big
climbable mountains that rise into a cloud layer, stylized water (sea/lakes),
and a long, atmospheric view. Deliberately **low-poly as an art direction**
(flat-shaded, bold color, altitude-based tinting) — not high-fidelity. The
stylization is what *buys* the scale.

## Locked decisions (2026-06-12)

- **Renderer:** stay **WebGL** (same as the forest). No WebGPU. Clouds + water
  are hand-rolled in a low-poly style — we forgo the WebGPU-only Three.js Water
  Pro on purpose.
- **Isolation:** **separate mode**, own entry + folder. Forest stays intact as
  the always-works fallback. Reuses the two-canvas / one-scene-active pattern.
- **Scale:** **large finite, expandable.** A big bounded region, fully streamed.
  The streaming architecture means the bound can be lifted toward infinite later
  with no rework.
- **Mutability:** **read-only world** to start (walk/look/climb, no terrain
  destruction). So no edit/diff persistence layer yet — pure seed regeneration.

## The core idea (why it stays fast)

```
frame cost  ≈  per-chunk detail  ×  visible chunks
```

Low-poly keeps per-chunk detail tiny, so we can afford a large render distance.
Streaming keeps the *working set* constant regardless of world size: generate
ahead, free behind. Performance is bounded by **render distance**, not map size.

## Technique ledger

**Backbone — built new here**
- Level streaming — chunk load/free by distance ring around the player
- Web Worker generation — chunk meshes built off the main thread (no hitches)
- Deterministic per-chunk seeding — `hash(worldSeed, cx, cz)`; walk back = identical
- Geomorphing terrain LOD (CDLOD) — distant chunks fewer tris, morph = no pop
- HLOD — far chunks render as cheap merged proxies ("skeleton remains")

**Carried over from the forest (already proven)**
- Frustum culling · instancing · discrete LOD · impostors/billboards
- Fog (mood + streaming-frontier hider) · seeded RNG (`mulberry32`, SimplexNoise)

**Cheap upgrades worth adding**
- LOD cross-fade (dithered transitions) — kills popping, the most visible win
- Per-system self-cull discipline — every system culls by distance

**Deliberately skipped (revisit only if profiling demands)**
- GPU-driven rendering / indirect draws — WebGPU-only
- Real Nanite / virtualized geometry — WebGPU-only; approximate via geomorph + cross-fade
- Occlusion culling — hard on WebGL; mountains are big occluders so reconsider if needed
- Edit/diff persistence — only if the world becomes destructible
- BatchedMesh / multidraw — reserve lever, pull only if draw calls bite

## What we nerf (and why it's free)

| Drop | Reason |
|------|--------|
| Multi-pass realistic water | Top cost in the forest; stylized plane instead |
| Per-pixel PBR | Flat/vertex shading is cheaper *and* the look |
| Heavy dynamic shadows | Stylized/blob or baked; big GPU savings |
| Detailed hero assets (e.g. 315k oak) | Low-poly procedural everything |
| Godrays / N8AO / heavy post | Light fog + sky gradient sets mood near-free |

## Build phases (each ends runnable)

0. **Shell** — entry html + isolated boot, sky + flat ground + orbit cam. *(this commit)*
1. **Streamed flat terrain** — chunk grid, worker gen, ring load/free, walk around. Prove no hitching.
2. **Mountains** — fBm + ridged noise, vertical scale, altitude coloring (grass→rock→snow).
3. **LOD + fog** — geomorphing chunk LOD, distance fog. Make the long view cheap.
4. **Water** — stylized low-poly plane / lakes at sea level.
5. **Vegetation** — per-chunk deterministic ez-tree scatter + impostors.
6. **Clouds + sky + polish** — altitude cloud layer (billboards or low-poly mesh), sky gradient.

## Performance guardrails

- **Render distance** is the master dial — sets `visible chunks`; tune vs frame time.
- **Fog at the frontier** — hides streaming-in chunks and caps draw distance.
- **Amortize generation** — ≤1–2 chunks built per frame; worker queue absorbs the rest.
- **Everything self-culls** — adding a system must not erode the budget.
- Measure each phase (frame ms, draw calls, tris) before adding the next.

## Reuse map (forest code we can lift, read-only)

- `src/world/terrain.js` — noise/height patterns to adapt (not import directly)
- `@dgreenheck/ez-tree` — already a dependency; low-poly presets for vegetation
- `src/world/impostors.js` — impostor baking approach for distant trees
- `mulberry32` seeding pattern (in `trees.js`) — re-key per chunk
