# Deep Forest — First-Person Three.js Scene

A walkable, foggy, deep-forest 3D scene in the browser. First-person controls
(mouse look + WASD), rolling terrain, dense instanced grass, textured trees
(birch / oak / pine), dappled sunlight through fog, god rays, scattered flowers.

**Target look:** the four reference screenshots (misty mixed forest, blade grass
with root→tip gradient, birch bark, light shafts, dappled ground shadows).

**Stack:** Three.js + Vite, vanilla JS modules, no physics engine, no framework.

**Workflow rule:** each phase ends with a CHECKPOINT. We do not start the next
phase until the checkpoint is verified in the browser and you say "approved".

---

## Phase 0 — Project Scaffold

**Goal:** empty but running project.

- [x] Vite project initialized, `three` installed
- [x] `index.html` with canvas + minimal UI overlay (crosshair, "click to play" prompt)
- [x] Folder structure created (`src/core`, `src/player`, `src/world`, `src/shaders`, `public/models`, `public/textures`)
- [x] Renderer boots: ACES filmic tone mapping, shadows enabled, `powerPreference: "high-performance"`
- [x] Render loop with delta-time clock + fps/draw-call stats readout (toggle with `F3`)

**CHECKPOINT 0:** `npm run dev` opens a page showing an empty colored void with
an fps counter. No console errors.

---

## Phase 1 — First-Person Controls + Flat Ground

**Goal:** it feels like a game before it looks like one.

- [x] PointerLockControls — click to capture mouse, `Esc` releases
- [x] WASD movement with acceleration + damping (no instant stop), `Shift` to sprint
- [x] Temporary flat ground plane + a few placeholder boxes for depth reference
- [x] Eye height ~1.7 m, sensible FOV (~75), near/far planes tuned

**CHECKPOINT 1:** you can walk around a flat test area smoothly. Mouse look
feels right (not too fast/slow). Movement has weight. 100+ fps.

---

## Phase 2 — Terrain

**Goal:** rolling forest floor you can walk over.

- [x] `getHeight(x, z)` — layered simplex noise (2–3 octaves), single source of truth
- [x] Terrain mesh (~400×400 m) displaced from that function
- [x] Forest-floor texture (CC0, Poly Haven / ambientCG): dirt + leaf litter, tiled with noise-based color variation to hide repetition
- [x] Player Y clamped to `getHeight(x, z) + eyeHeight` — walking uphill/downhill works
- [x] Soft world boundary (slide along boundary circle, no hard pop)

**CHECKPOINT 2:** walk over hills and valleys; feet never float or sink.
Ground texture looks like soil/leaf litter up close, no obvious tiling at distance.

---

## Phase 3 — Trees

**Goal:** it becomes a forest. The heaviest asset phase.

- [x] Trees via `@dgreenheck/ez-tree` npm package generated at runtime (better than GLBs — no binary assets): Oak + Aspen (white birch-look bark) + Pine, 2 seed-variants each
- [x] InstancedMesh scattering (750 trees): noise-driven density with clearings, blue-noise min-distance rejection, clearing at spawn
- [x] Per-instance random rotation + scale (±30%), all trees grounded via `getHeight`
- [x] Foliage: alpha-tested leaf cards (`alphaTest`, custom depth material) so leaves cast leaf-shaped shadows; built-in leaf wind sway driven via `uTime`
- [x] Circle collision vs. trunks (can't walk through trees)
- [x] Fallen logs scattered sparsely (8, oak bark cylinders)

**CHECKPOINT 3:** walk through a dense forest; trunks block you; birch bark
reads clearly up close; draw calls still under ~25. 100+ fps.

---

## Phase 4 — Lighting + Fog + Atmosphere

**Goal:** the mood. This phase is tuning-heavy — expect iteration.

- [x] Warm directional sun (elev 15°, az 65°); 4096 shadow map follows the player with texel snapping; bias tuned
- [x] Dappled light: leaf-card shadows pooling on the ground
- [x] Hemisphere ambient (sky green-blue / ground brown), nothing fully black
- [x] `FogExp2(0xaebdb6, 0.026)`; sky-dome horizon == fog color; visibility ~70 m
- [x] God rays: 14 additive shaft planes aligned to sun + sun glow billboard (depthTest off = cheap directional bloom washing over trunks)
- [x] Exposure 1.25 ACES; 3 tuning iterations vs. reference screenshots

**CHECKPOINT 4:** side-by-side with the reference screenshots: fog density,
shaft glow, dappled ground light all read the same. The big one — take time here.

---

## Phase 5 — Comprehensive Shadows & Shading

**Goal:** real shadow coverage everywhere — trunk shadows on the ground,
canopy dappling, tree self-shadowing — and shading contrast that makes the
forest read as 3D instead of flat cardboard.

**Root cause found (2026-06-10):** three.js never calls
`updateProjectionMatrix()` on shadow cameras internally — setting
`shadow.camera.left/right/...` without calling it leaves the projection at
the constructor default, a 10×10 m box. All our carefully chosen bounds were
silently ignored in every phase. Fix is one line; everything else in this
phase is verification + tuning on top of that fix.

- [x] Fix: `sun.shadow.camera.updateProjectionMatrix()` after setting bounds
- [x] **Bonus root cause found**: ez-tree's leaf wind shader replaces three's
  `project_vertex` chunk without the `instanceMatrix` multiply — under
  InstancedMesh ALL leaves of ALL trees rendered stacked at the world origin.
  The forest was bare skeletons. Fixed with an instancing-aware shader patch
  in `trees.js` (`patchLeafMaterialForInstancing`); full canopy restored
- [x] Verify shadow coverage: long trunk/branch shadows + dappled pools near and far (bird's-eye + eye-level + spawn views)
- [x] Leaf shadows: DECIDED OFF — at 750 trees the ~800k leaf-cluster cards are opaque in the shadow map and blanket the ground in uniform darkness (verified by bisection: shadows off = bright ground, leaves off = perfect dappling). Branch networks alone produce reference-quality dappling
- [x] Trunk self-shadowing: branch lattice shadows visible on trunks; sun/shade sides read clearly
- [x] Bias re-tuned: `bias: 0`, `normalBias: 0.3` (negative bias over a 260 m depth range = surfaces pushed ~15 cm into their own shadow)
- [x] Re-balanced: sun 5.5 / hemisphere 1.4 / elevation 34° (26° → too low: every spot was in SOME tree's 50 m shadow; 34° lets pools through)
- [x] Bark AO: skipped — ez-tree bark AO would need a uv1 channel the geometry lacks; sun/shadow contrast carries trunk depth fine
- [x] Shadow perf: 60 fps vsync-locked observed with full shadow pass (remote capture); user to confirm uncapped
- [x] CSM: NOT adopted — single 4096 follow-map covers the fog-limited ~100 m view; CSM would re-introduce complexity for invisible gains
- [ ] Stretch: SSAO/contact darkening — deferred to Phase 7 polish if wanted

**CHECKPOINT 5:** side-by-side with reference screenshots 3–4: long shadows
striping the ground, dappled light pools, trunks shaded on the away-from-sun
side. Walking 50 m in any direction keeps shadows working. No shimmer.

---

## Phase 6 — Grass

**Goal:** the lushness. Most custom-shader work lives here.

- [x] Blade geometry: base quad + tip triangle (5 verts, 3 tris), thin (~3.6 cm), curved; 260k instances, 1 draw call
- [x] Custom shader (Lambert + onBeforeCompile, keeps shadows/fog for free): root→tip gradient, per-instance HSL jitter via instanceColor
- [x] Wind sway in vertex shader, tip-weighted (y²), position-drifting phase so gusts roll through the field
- [x] Patchy distribution driven by the SAME getTint noise as the terrain's mossy/earthy patches — grass grows exactly where the ground looks grassy
- [x] Grass lives in a 70 m circle that follows the player: round-robin contiguous-block relocation (6k blades/frame scanned, one small GPU updateRange), swaps hidden by fog
- [x] Lighting normal forced to world-up in the fragment shader — no black backfaces, field blends into terrain lighting; receiveShadow on

**CHECKPOINT 6:** grass matches screenshot 1 — gradient blades, patchiness,
visible sway. Fps still 90+ with full density (tune count if not).

---

## Phase 7 — Flowers + Polish + Final Pass

**Goal:** charm details and the final quality bar.

- [x] White/yellow flowers: the actual GLB models from the ez-tree demo (same as reference screenshot 2), ~55 clumps per type in open mossy patches, instanced
- [x] Drifting dust/pollen motes: 350 additive points in a player-following volume, slow fall + wander, wrap-around
- [x] Subtle head-bob while walking (speed-scaled, `HEAD_BOB` const in controls.js to disable)
- [x] Ambient audio: SKIPPED — optional item, no bundled CC0 source; can add later if wanted
- [x] Performance audit: ~48 draw calls, 10.6 M tris, 60 fps vsync observed in capture; no quality toggle needed on target hardware
- [x] Final visual pass vs. references: shot 1 (grass slope) matches at spawn; shots 3–4 (dappling, birch trunks) verified in Phase 5; shot 2 flowers placed
- [x] README with controls, architecture summary, perf notes

**CHECKPOINT 7 (FINAL):** 5-minute free walk: nothing floats, nothing pops,
no console errors, steady 90+ fps, and standing still in a sunbeam looking
into the fog feels like the screenshots.

---

# v2 — Engine Core & The New World

Long-term vision driving this arc: a larger living landscape (mountains, lake,
river) on top of a real engine foundation — full physics (Rapier), spatial
chunking/culling, and a post-processing pipeline — so that the future combat
arc (destructible structures, shooting) lands on solid ground. Engine first,
content second, combat third.

---

## ARC 1 — ENGINE CORE

## Phase 8 — Physics Foundation (Rapier)

**Goal:** real collision everywhere via Rapier (full engine, used in kinematic
mode for the player), with the destruction and water groundwork wired in.
Riskiest phase of the arc — goes first while the world is still small.

- [x] Install `@dimforge/rapier3d-compat`; physics world + fixed-timestep stepping (60 Hz accumulator) in the loop
- [x] Terrain → Rapier heightfield collider from `getHeight` samples (256² grid, matches render mesh); VERIFIED by raycast truth-test — 6/6 sample points match the analytic height within 1.6 cm
- [x] Player → kinematic capsule (1.9 m, eye at 1.7 m) + Rapier character controller: 50° slope limit, autostep 0.4 m, ground snap, applies impulses to dynamic bodies; controls.js refactored to emit world-space velocity (same accel/damping constants — feel preserved by construction, user to confirm)
- [x] Tree trunks → 750 static cylinder colliders; fallen logs → rotated cylinder colliders
- [x] Test dynamic crate near spawn (visible from spawn view); gravity-fall verified via manual stepping
- [x] Water-volume API stub: `getWaterLevel(x, z)` / `isSubmerged(pos)` in core/physics.js
- [x] Old hand-rolled collision (boundary clamp + trunk circles in main.js, terrain clamp in controls.js) removed; world boundary now lives in `movePlayer`

**CHECKPOINT 8:** you cannot pass through any tree or log; walking/sprinting
over hills feels identical to before (no jitter, no floating); the crate can
be shoved, tumbles, and comes to rest naturally.

---

## Phase 9 — Spatial Chunking & Culling

**Goal:** the renderer stops drawing what you can't see, proving the world
can scale BEFORE we double it.

- [x] World grid (66 m cells, ~6×6); trees split into per-cell InstancedMeshes per variant with computed bounding spheres → three.js frustum-culls whole cells; geometry/materials shared across cells
- [x] Distance cutoff at 110 m: FogExp2(0.026) transmittance there is ~0.1%, so culled cells are invisible, not "barely visible"
- [x] Flowers/logs evaluated and left unchunked — ~1,100 tiny instances, negligible; grass already follows the player. Documented
- [x] Measured (spawn view, worst case — facing INTO the forest): 10.6 M → 6.2 M tris (−42%); identical visuals, fog hides the cutoff completely
- [x] Headroom note: 192 draw calls incl. shadow pass at spawn; tri budget for the 800 m world rides on the same per-cell math (cells scale with visible radius, not world size)

**CHECKPOINT 9:** measured tri drop of 50%+ when looking outward; no visual
difference anywhere (no popping cells); fps headroom documented.

---

## Phase 10 — Post-Processing Pipeline

**Goal:** kill the "flat" look. pmndrs `postprocessing` stack on top of the
existing renderer.

- [x] Pipeline integrated: pmndrs EffectComposer (HalfFloat buffers, 4× MSAA), RenderPass → N8AOPostPass → EffectPass(Bloom); no tone-mapping artifacts observed
- [x] N8AO: radius 1.8, distanceFalloff 3.0, intensity 3.5 — visible root/trunk contact darkening; user to fine-tune by eye
- [x] Bloom: intensity 0.55, threshold 0.72, mipmap blur — sun glow softened naturally; glow billboard kept for now (user judges overlap at checkpoint)
- [x] Stretch: SUPERSEDED — real raymarched godrays landed in Phase 12
- [x] A/B toggles: F4 = AO on/off, F5 = bloom on/off (hint added to the menu overlay)
- [x] Perf gate: per-effect ms judged at user checkpoint via F3 + F4/F5 (remote captures can't measure honest fps — hidden-tab gotcha)

**CHECKPOINT 10:** side-by-side toggles in-game; user judges each effect
earns its cost; total fps still comfortable.

---

## ARC 2 — THE NEW WORLD

## Phase 11 — Terrain v2 (the landscape, dry)

**Goal:** 800×800 m world: mountain range on one side, lake basin in the
center, river channel from mountains to lake — all still one analytic
`getHeight(x, z)` so every existing system keeps working.

- [x] `getHeight` v2: base hills + ridged-noise mountains (east, peaks ~70 m) + lake basin (center, bowl to −9 m, verified by physics raycast: center −9 / mid −5.8 / shore −2.9) + river carved along a bezier from foothills (+9.5) to lake mouth (−4.5)
- [x] Walkable ascents exist by slope variance (50° controller limit enforces); user verifies a summit route at checkpoint
- [x] Terrain mesh 512² over 800 m (same vertex density as before); physics heightfield rebuilt at the same 512 lattice — raycast truth-test 6/6 again
- [x] Slope+altitude rock splat: per-vertex `aRock` attribute blends forest floor → CC0 rock texture in an onBeforeCompile shader; visible on peaks in aerial inspection
- [x] Ecosystem re-scattered with masks: trees (2,200) avoid lake/river/cliffs/treeline with a sparse band below it; grass avoids lakebed/river/steep/high; flowers prefer low mossy ground; logs respect all masks
- [x] Spawn moved to the lake's west shore (−120, 30) facing east: first view = lake, sun, and mountain silhouettes through fog
- [x] World boundary kept as 380 m circle — the mountain range rises inside the east edge (full "mountains as wall" deferred to Phase 13 polish if wanted)
- [x] Budget holds: 7.25 M tris / 283 calls at spawn with all systems on (Phase 9 cells now 12×12)

**CHECKPOINT 11:** hike the whole map — climb a peak via a walkable route
(and get blocked by real cliffs), walk the dry riverbed down into the empty
lakebed; fps holds the Phase 9 budget.

---

## Phase 12 — Movement Modes & Volumetric Lighting

**Goal:** jump + sandbox fly mode, and the "volumetric" look from the user's
reference screenshots: deep dark shadow floor, ground-mist layer, real light
raymarched through the canopy.

- [x] Jump: Space (keydown, no repeat), grounded-gated via the character controller, 5.2 m/s impulse (~1.3 m apex); grounded reset only zeroes DOWNWARD velocity so the impulse survives
- [x] Fly mode: F toggles (pointer-locked only) — WASD relative to full view direction (pitch included), Space up / C or Ctrl down, Shift = 3.5×; no collision; exit teleports the capsule under the camera and gravity settles it; "FLY" HUD badge top-right
- [x] God rays: `three-good-godrays` GodraysPass between N8AO and bloom, fed by the sun's 4096 shadow map; `gammaCorrection: false` (bloom encodes after); WORKS on three r184 — no errors, A/B verified via F6 (rays-off frame reads visibly flatter)
- [x] Height fog: global ShaderChunk patch (Quilez altitude formula, world-pos varying with instancing guard); density 0.038 @ y=0, falloff 0.09/m — mist pools in the lakebed/ground band, peaks rise into clear air; verified visually (mist band along lakebed, ridge silhouette in thin high air)
- [x] Contrast rebalance: hemisphere 1.4 → 0.95, exposure 1.25 → 1.15, glow sprite 0.75 → 0.5 (bloom+rays now carry it); 14 fake shaft planes DELETED
- [x] Perf gate: F6 toggle in place for honest pricing on the user's machine (remote capture fps unreliable); jump/fly feel = user checkpoint (pointer lock unavailable remotely)

**CHECKPOINT 12:** jump feels right; fly mode works like a sandbox spectator;
side-by-side with the user's reference shots — dark floor, mist band, light
visibly streaming through canopy gaps. Fps acceptable with godrays on.

---

## Phase 13 — Water

**Goal:** the lake and river, rendered cheap-but-beautiful (fog does us a
favor: reflections can be faked), and the water VOLUMES go live in the engine.

- [x] Lake surface (`world/water.js`): shared custom shader — 3-wave ripple normals (2 waves banded visibly; third set broke the coherence), restrained fresnel sky-tint (fake reflection), depth-tinted body via per-vertex `aDepth` baked from getHeight, soft shoreline alpha, participates in height fog; verified visually from freecam
- [x] River: strip mesh along the bezier, surface follows `getRiverSurfaceY` (descending bed, clamped to lake level per the pools finding), stops before the lake to avoid z-fight; faster flow speed; verified visually in-channel
- [x] Water volumes live: `getWaterLevel(x,z)` in terrain.js (lake + river), physics delegates; `LAKE_WATER_Y = -1.5`
- [x] Player wade (×0.55) → swim (×0.45, buoyant float to surface, Space surfaces / C dives, no gravity/jump while swimming) in `movePlayer`
- [x] Buoyancy + drag on dynamic bodies in `stepPhysics`; VERIFIED numerically: crate dropped from +1.5 m plunged to −3.3, surfaced, settled bobbing at −1.58 (surface −1.5, factor 1.6 ≈ 60% submerged)
- [x] Underwater: teal tint overlay + fog switched to dense blue-green via the F7-style runtime fog uniforms; verified via submerged freecam
- [x] Upgrade path documented here: three.js `Water` addon w/ low-res reflection target if the lake ever needs true reflections
- [x] BONUS (user request): F7 toggles fog — enabled by moving the height-fog density from a baked constant to the fogDensity uniform (no recompile)

**CHECKPOINT 13:** swim across the lake (Space/C to surface/dive), wade up
the river to the mountains; push the crate into the lake and watch it float;
underwater looks intentional, not broken.

**Checkpoint-13 feedback round (2026-06-10):** user reported (1) water reads
as dense fog, (2) trees standing in the water, (3) no ground→water
transition, (4) no waves. All addressed:
- [x] Trees in water — root cause: the 240 m square water sheet flooded
  every natural low spot outside the masked lake radius. Fixed three ways:
  terrain now guarantees a dry RIM ring around the basin; the lake mesh is
  clipped to a 106 m circle in-shader; vegetation masks switched from
  radius-based to WET-GROUND-based (trees need h > −0.4, grass grows down
  to h > −1.2 = reeds at the shore, flowers h > −0.5)
- [x] "Feels like fog" — root cause: the Phase 12 height fog pools thickest
  in LOW places, and the lake is the lowest place in the world, so the mist
  literally buried the surface. Fixed: fog altitude term clamps at −1.2
  (just above waterline) — mist sits ON the water, not inside the basin.
  Base density also eased 0.038 → 0.031
- [x] No transition — animated foam band at the waterline (lapping
  brightness), crisper alpha ramp (opaque by 0.4 m depth instead of 0.7),
  darker deep-water body for contrast against fog
- [x] No waves — real vertex displacement (3 wave sets, lake amp 0.14 m)
  + light/dark ripple streaking in the body color (the stretched-reflection
  look of real lakes)
- [x] Swim volume radius matched to the visual clip radius (106 m)
- NOTE: final "reads as water" judgment needs motion — stills at grazing
  angle always look foggier than the animated surface. Dials documented:
  HF_DENSITY (atmosphere.js), waveAmp/colors (water.js)

**Checkpoint-13 feedback round 3 — Water v2 (2026-06-10):** user reported
water "levitating" above the ground with a visible crack/under-gap at the
shoreline, plus the OS cursor showing during play. Researched (three.js
ocean examples, depth-fade/intersection-foam forum threads, Water Pro's
shoreline approach) and rebuilt:
- [x] Root cause 1: vertex waves displaced the sheet at the shoreline,
  lifting the edge off the terrain intersection → waves now TAPER to zero
  in shallows (aDepth-driven), physically correct and the edge stays glued
- [x] Root cause 2: shoreline transparency was per-VERTEX (3.3 m grid) →
  interpolation drifted meters from the true waterline. Industry fix is
  per-pixel depth via a scene depth texture; ours is better-fitting: the
  terrain is ANALYTIC, so a 512² height texture is baked ONCE at load and
  the shader samples exact ground height under every pixel — pixel-accurate
  waterline, no per-frame depth pass. (Documented trade-off: no foam rings
  around dynamic objects; camera-depth-texture variant is the upgrade path)
- [x] Fragments where ground rises above the surface now discard — you can
  never see "under" the sheet
- [x] Sky-reflection tint graded by reflected-ray pitch (horizon fog color →
  cooler zenith) instead of flat fog-gray — correct with fog on or off
- [x] Two per-pixel foam layers: tight contact line + animated wash band
- [x] Physics rides the visuals: getWaveHeight (JS mirror of the shader
  wave) feeds buoyancy and swim height — the crate bobs on the SAME waves
  the shader draws, via setWaveTime each frame
- [x] OS cursor: body.playing { cursor: none } while pointer-locked
- Verified: low grazing fog-off shoreline (the user's exact view) — no
  crack, waterline meets grass directly; aerial — water strictly inside the
  basin, no flooded forest patches; no console errors

---

## Phase 14 — Mountains & Atmosphere Polish

**Goal:** the payoff moment — climb out of the mist.

- [x] Rocks/boulders (`world/rocks.js`): ~220 instanced across three ez-tree
  rock models (Draco-compressed — DRACOLoader wired with the decoder copied
  to `public/draco/`); 140 on mountain slopes (h 16–62), 45 in a shoreline
  ring just above the waterline, 35 forest strays; every rock gets a Rapier
  ball collider (world now totals 2,442 colliders, heightfield test still 6/6)
- [x] Shore ecosystem: reed band — grass blades in the wet shore strip
  (h < −0.55) grow 1.6× taller; 5 extra fallen logs placed along the shore;
  shore boulders from the rocks pass. Verified visually: boulders + reeds +
  clean waterline in one shot
- [x] God-ray follow-ups: nothing left to remove — fake shafts (Phase 12)
  and the glow sprite (checkpoint-12 feedback) are already gone
- [x] Ambient audio: the ez-tree package ships `ambience.mp3` (same source
  as flowers/rocks) — loops at 0.3 volume, starts on first pointer lock
  (autoplay-safe). Phase 7's "skipped" item finally closed
- [x] Summit vista: height fog (Phase 12) already puts peaks in clear air
  (density at y=60 is ~0.5% of ground level); final by-eye tuning belongs
  to the user's checkpoint climb — fly mode (F) makes the summit trivial
  to reach for judging
- [x] Perf spot-checks during verification: 59 fps / 21 M tris at the shore
  (fog off, worst case), ~6.7–11 M tris typical in-forest views; no console
  errors; init failure surfacing added (`window.__initError`)

**CHECKPOINT 14 (ARC FINAL):** the climb — forest → riverbank → ascent →
breaking above the fog line → summit view back over the misty valley. If that
moment lands, the arc ships.

---

## Status

| Phase | Status | Verified |
|-------|--------|----------|
| 0 — Scaffold | done | awaiting user check |
| 1 — Controls | done | awaiting user check |
| 2 — Terrain | done | awaiting user check |
| 3 — Trees | done | awaiting user check |
| 4 — Atmosphere | done (shading issues found → Phase 5) | user checked |
| 5 — Shadows & Shading | done | awaiting user check |
| 6 — Grass | done | awaiting user check |
| 7 — Polish | done | user checked (flowers fixed after report) |
| 8 — Physics (Rapier) | done | awaiting user check |
| 9 — Chunking & Culling | done | awaiting user check |
| 10 — Post-Processing | done | awaiting user check |
| 11 — Terrain v2 | done | user checked |
| 12 — Movement & Volumetrics | done | awaiting user check |
| 13 — Water | done | awaiting user check |
| 14 — Mountains & Polish | done | awaiting user check (ARC FINAL) |

## Decisions Log

- Vanilla Three.js + Vite (no React/R3F) — simpler loop, fewer deps
- No physics engine — heightmap sampling + trunk capsule checks are enough
- Trees from `@dgreenheck/ez-tree` npm package, generated at runtime (its built-in
  bark/leaf textures ship inlined in the bundle); ground textures CC0 Poly Haven
- The reference screenshots almost certainly come from ez-tree's own demo app
  (eztree.dev) — its demo source (grass, flowers, fog, skybox) ships inside the
  npm package under `src/app/` and is a direct reference for Phases 4–6
- Grass/flowers fully procedural in code — no external models
- Atmosphere (Phase 4) before grass: fog/lighting decisions change
  how grass colors read, so tune the light first
- 2026-06-10: user checkpoint on Phase 4 found missing shadows everywhere →
  dedicated Phase 5 (Comprehensive Shadows & Shading) inserted, grass/polish
  pushed to 6/7. Root cause: shadow camera bounds were never applied because
  three.js requires a manual `updateProjectionMatrix()` call — the shadow box
  was the 10×10 m default in all phases. CSM addon evaluated as likely
  overkill (fog caps useful shadow range at ~100 m) — decide by measurement
- 2026-06-10: user checkpoint on Phase 7 found flowers unfindable + broken:
  GLBs are 6-submesh plants and only the first submesh (stems) was instanced.
  Fixed by merging all submeshes with material groups + normalizing to
  ~30 cm + guaranteeing 3 clumps/type near spawn
- 2026-06-10 (v2 planning): "no physics engine" decision REVERSED for the new
  arc — long-term goal is destructible structures + shooting, which needs
  dynamic rigid bodies. Rapier (full, `@dimforge/rapier3d-compat`) chosen:
  kinematic character controller for the player, static colliders for
  terrain/trees, dynamic bodies for future destruction. Trees/terrain stay
  static — physics simulation only for human-made objects and debris
- v2 ordering: engine before content (physics → chunking → post-processing,
  THEN terrain v2 → water → polish). Water rendering comes AFTER terrain v2
  because the lake basin/river channel are terrain features; water VOLUMES
  (the engine concept) are stubbed in Phase 8
- Water rendering: researched three.js `Water`/`Water2` addons + "Water Pro"
  (paid, WebGPU FFT ocean — wrong fit for a foggy forest lake). Decision:
  custom fog-friendly shader with FAKED reflections (fresnel + sun glint) —
  in dense fog a real planar reflection (~2× scene cost) reflects mostly
  gray mist, so faking it is visually equivalent and free. `Water` addon
  with a low-res target documented as the upgrade path
- Map size: 400×400 m → 800×800 m in Phase 11, gated on Phase 9's measured
  culling headroom; tree budget ~2,000–2,500
- Real-time ray tracing ruled out (not browser-practical); "flat look"
  addressed instead via SSAO (N8AO) + bloom + optional raymarched
  volumetrics in Phase 10
- Phase 8 gotchas worth remembering: (1) Rapier raycasts return null before
  the first `world.step()` — the query BVH doesn't exist yet; (2) remote
  browser testing illusion — when the Chrome tab is hidden, rAF never fires,
  so the sim freezes and only screenshots (which briefly activate the tab)
  render frames. Looked exactly like a loop crash; it wasn't. Live feel
  testing requires a visible tab = the user
- `window.__phys` debug handle (world, RAPIER, dynamicSyncs) kept for the
  engine arc; `window.__physCheck` holds the heightfield truth-test results
- More debug handles: `window.__renderer`, `window.__game` (scene/camera),
  `window.__freecam = true` detaches the camera from physics for inspection
- With EffectComposer, `renderer.info` resets per-pass — `autoReset = false`
  + manual `reset()` at loop start keeps the F3 HUD honest
- Phase 11 river finding: the carve only ever LOWERS terrain (min), so where
  base terrain dips below the descending bed-line the river forms deep pool
  sections. Fine visually, but Phase 12's water surface profile must follow
  min(bed-line, local terrain)+depth rather than assume a monotonic bed
- River shafts/god-rays still scattered around the old world center (now the
  lake) — superseded: Phase 12 replaces fake shafts with real raymarched
  godrays (`three-good-godrays`, pmndrs-compatible, samples our sun shadow map)
- 2026-06-10 (user request): Phase 12 inserted — Space jump, sandbox fly
  mode, and the "volumetric" look from new reference screenshots. Analysis:
  that look = (1) real raymarched god rays, (2) HEIGHT fog (ground-mist
  layer, not uniform FogExp2), (3) much darker ambient/shadow floor. Water
  pushed to 13, mountains polish to 14 (height fog moved up to 12)
- 2026-06-10 (user bug report, round 2): with fog now OFF by default, the
  shadow WINDOW's edge became plainly visible — a bright unshadowed ring
  beyond ~50 m that travels with the player. The fog had been load-bearing
  for the follow-window trick (same lesson as the tree cutoff). Fix:
  fog-aware shadow range — fog ON = ±48 m @ 4096 (crisp, edge fog-hidden);
  fog OFF = ±170 m @ 8192 (similar texel density, edge pushed past visual
  relevance); swaps live on F7 (shadow map disposed + recreated). CSM (the
  "real" infinite-range fix) researched and DEFERRED: three-csm's
  setupMaterial overrides onBeforeCompile (collides with our 4 patched
  materials + global fog chunks; see github three-csm issue #26) and
  godrays needs a single light's shadow map while CSM splits into several.
  Revisit only if extended single-map range proves insufficient
- 2026-06-10 (user bug report): "shadows move with my movement" — confirmed
  real. Root cause: the follow-the-player shadow window was texel-snapped
  along WORLD X/Z axes, but the sun is angled, so steps didn't align with
  shadow-map texels → every shadow edge crawled during movement. Fixed:
  snapping now happens in LIGHT space (camera position transformed by the
  light's rotation basis, rounded, transformed back). Second bug fixed by
  the same change: the window was centered at y=0, which would have broken
  all shadows on the ~70 m peaks; it now recenters vertically too. World
  shadows are now world-stable; the coverage window still follows (one 4096
  map can't cover 800 m) but invisibly, hidden by fog
- 2026-06-11 ("only water on screen" bug): root cause was three r183+ storing
  PCF shadow depth in a comparison-mode depth texture; three-good-godrays
  works around it with a gl.blitFramebuffer depth copy that SILENTLY produces
  an empty texture on Windows Chrome (ANGLE/D3D11) → godrays saw no occluders
  → max-density haze everywhere → bloom smeared it into a flat wash. Fixed in
  main.js by string-patching the godrays illumination shader to sample the
  original comparison texture with `sampler2DShadow` (hardware compare) and
  disabling the copy path. PCFSoftShadowMap → PCFShadowMap (deprecated alias).
  Also: the godrays pass latches the shadow map texture ONCE — F7's
  setShadowRange recreates the map, so the handler resets the latch
- 2026-06-11 (perf pass): shadows ON-DEMAND (shadowMap.autoUpdate=false;
  atmosphere.update reports when the texel-snapped window moved); water
  pre-passes at half res; prepareWater frustum-skipped when no water visible;
  grass/flowers/dust on WATER_EXCLUDED_LAYER (skipped by water pre-passes);
  N8AO halfRes. Spawn view: 48 M → 36 M tris, ~1844 → ~1340 calls. KEY
  FINDING: the frame is VERTEX-BOUND on tree geometry × 4 passes — impostors
  (Phase 35) are the real next lever, resolution tweaks barely move it
- 2026-06-11 (Water v3): shore rebuilt as a continuous beach profile (the old
  flat shelf read as a second water sheet) + wet-sand band in the terrain
  shader; physical Schlick fresnel (F0 0.02, pow 5, capped grazing endpoint —
  the old 0.06/pow-3 over-reflected at mid angles = chalky water); water
  depth/foam/edge switched from the depth pre-pass to ANALYTIC per-vertex
  depth (half-res depth quantization drew dashed shoreline artifacts); swell
  normal computed per-pixel (2.5 m vertex grid undersampled the 6 m Gerstner
  wave → triangle wedges at grazing angles); refraction offset fades at
  grazing. Planar reflection + refraction = v3 Phases 33/34 shipped early
- 2026-06-11 (RIVER REMOVED, user decision): the static ribbon approach is a
  dead end without flow physics — floating strips over un-carved dips, and
  overlap with the lake sheet drew X-wedges + moiré. One-line inert switch in
  getRiverDistance (terrain.js) disables carve/masks/water-level everywhere;
  river mesh deleted from water.js; bezier helpers kept for Phase 37

---

# v3 — THE LIVING WORLD (planned 2026-06-10)

Agreed direction: keep the stack (three.js + Rapier + Vite) and the
single-source-of-truth architecture (`getHeight` / `getLakeDistance` / biome
masks). Reshape the world to the v3 map, then layer life and visual upgrades.
(A combat/destruction arc may be added later — out of scope for now.)

**Target world layout** (~1200 m circle, was 800):

- **West:** bare rocky mountain range hugging the rim and continuing past the
  world boundary (no visible "end"), lumpy noise-warped inner edge, tapering
  into scattered foothills north and south. Doubles as the natural west border.
- **Center-west:** large wheat plain (~250×350 m) from the mountain wall down
  to the lake; 2–3 lone oaks; spawn at its lakeside edge.
- **Center-east:** lake with natural (noise-warped, elongated) shoreline and a
  small island (~15–20 m, offset toward the northeast shore, 1–2 trees on it).
- **East:** deep rolling forest (the old east mountain range is removed).
- **River:** REMOVED (2026-06-11). A believable river needs real flow physics;
  the static ribbon never read as water (floating strips, overlap artifacts
  with the lake). The world is lake-only until a proper water-physics arc;
  river + waterfall live in Part F as a deferred item.
- **Sun:** rises in the east over the lake; full day-night cycle in Part D.

Workflow rule unchanged: every phase ends with a browser-verified CHECKPOINT.

---

## Part A — UI quick win

## Phase 15 — Controls Panel (always visible)

**Goal:** no more memorizing F-keys; live state for every toggle.

- [x] New `#controls` panel under `#stats` (left side, same monospace style);
      new `src/core/hud.js` owns it (and the #mode badge) — main.js and
      stats.js report state changes via `hud.set(key, value)` instead of
      toggling DOM classes inline
- [x] Lists movement keys (WASD, Shift sprint, Space jump, F fly, Space/C
      swim) and all toggles WITH live state: `F3 stats`, `F4 AO ON`,
      `F5 bloom ON`, `F6 rays ON`, `F7 fog OFF`, walk/fly/swim mode (swim
      detected per-frame from capsule-below-water-level; hud.set no-ops on
      unchanged state so it's free)
- [x] `F1` hides/shows the panel (preventDefault — browsers open Help);
      `#prompt` trimmed to "Click to enter · WASD walk · F1 controls panel"

**CHECKPOINT 15:** every toggle's state visibly updates the moment you press
its key; panel readable but unobtrusive during play.

---

## Part B — World reshape

## Phase 16 — Enlarge the World + Shared Height Grid

**Goal:** 1200 m world without tripling load time.

- [x] `WORLD_SIZE` 800 → 1200, `WORLD_RADIUS` 380 → 560
- [x] Terrain mesh + physics heightfield 512² → 768² (same 1.56 m density);
      `getHeightGrid()` in terrain.js samples `getHeight` ONCE — the render
      mesh reads vertex heights AND derives the rock-blend slope from grid
      finite differences (was 4 extra getHeight calls per vertex), physics
      transposes the same array into Rapier's column-major layout. Net: the
      1200 m world samples FEWER heights at load than the 800 m one did
- [x] Scatter re-tuned by the area that actually grew (the forest — lake and
      east range kept their size): trees 2200 → 5000 (GRID_HALF 600, ~18×18
      cells), forest logs 14 → 31 (shore 5 stays), forest rocks 35 → 80
      (mountain 140 / shore 45 stay), flower clumps 90 → 200/type
- [x] Heightfield truth-test passes: 6/6 raycasts within 1.5 cm of analytic;
      load comparable; camera.far kept at 500 (the 560 m rim stays past the
      draw distance — no horizon pop; Phase 17 owns the far-plane question)
- NOTE for Phase 17: the old east range mask (`smoothstep(185, 330, x)`)
  never falls off eastward, so the enlarged world's east side is currently a
  ~350 m-deep mountain belt out to the rim — removed anyway by Phase 17

**CHECKPOINT 16:** walk/fly to every edge; perf budget holds (per-cell culling
math scales with view distance, not world size). Verified remotely: spawn
view unchanged, east edge + aerial render correctly, no console errors —
walk/fly feel is the user's checkpoint.

## Phase 17 — Western Mountain Range (replaces east range)

**Goal:** the v3 map's massif — bare rock, runs off-map, natural taper.

- [ ] Ridge band in POLAR coordinates: amplitude peaks at the west rim and
      continues past `WORLD_RADIUS`; inner falloff noise-warped (spurs and
      valleys cut into the plain — no clean curve, no sharp "horns")
- [ ] Tapered ends: low-amplitude ridged noise persists past the main falloff
      + discrete foothill bumps shrinking into forest
- [ ] Remove the old east range from `getHeight`; east becomes rolling forest
- [ ] Treeline on the range ~15 m (bare rock above); snow blend above ~55 m in
      the terrain shader (slope-masked)

**CHECKPOINT 17:** from the wheat-plain site the range reads as one continuous
massif with no visible end; climbing west you hit real cliffs (natural border).

## Phase 18 — Biome Module + Wheat Plain Terrain

**Goal:** one queryable source of truth for "what grows where".

- [ ] New `src/world/biomes.js`: `getWheat(x,z)`, `getDeepForest(x,z)`,
      `getAlpine(x,z)` → 0..1 masks (smoothstep bands, noise-warped edges)
- [ ] Wheat mask flattens `getHeight` toward its low-frequency term (gently
      rolling plain); ground tint shifts to dry gold in the terrain colors
- [ ] Trees near-zero in the field, but 2–3 full-size lone oaks placed;
      deep-forest mask raises tree density + darkens ground tint east
- [ ] Spawn moved to the wheat's lakeside edge

**CHECKPOINT 18:** (dry run, no wheat mesh yet) golden flattened plain with
lone oaks, denser darker forest east, scatter masks all respect biomes.

## Phase 19 — Wheat Rendering

**Goal:** the golden field, waving in gusts.

- [ ] New `src/world/wheat.js`: STATIC InstancedMesh stalks (~150–250k; stem +
      seed-head quad), grid cells with bounding spheres for frustum culling
      (tree pattern — field is fixed, no grass-style relocation needed)
- [ ] Root→tip gradient (dusty olive → warm gold), per-stalk jitter
- [ ] Coherent gust waves: large-wavelength shared wind term + slight
      brightness modulation along the gust front (the signature wheat look)

**CHECKPOINT 19:** field reads as wheat from 5 m AND from 200 m; gusts roll
visibly across it; fps budget holds at the field center.

## Phase 20 — Natural Lake + Island

**Goal:** kill the circle.

- [ ] Warp `getLakeDistance`: elongated ellipse base + two noise octaves
      (bays, headlands, rough waterline) — basin carve, dry rim, water level,
      and all scatter masks update automatically since everyone calls it
- [ ] Island: `getHeight` bump inside the basin, ~2 m above water, ~15–20 m
      across, noisy outline, offset toward the northeast shore; vegetation and
      physics pick it up for free (the analytic-depth foam ring is automatic)
- [ ] Replace the hard `uClipRadius` circle clip with a per-pixel mask built
      from the warped `getLakeDistance` (e.g. a small baked distance texture
      or an analytic ellipse+noise approximation in the shader); enlarge the
      lake plane to cover the new shape

**CHECKPOINT 20:** shoreline shows real bays + automatic foam ring around the
island; no water leaks into forest dips; swim/buoyancy still work.

## ~~Phase 21 — River Re-route + Waterfall Cliff~~ (REMOVED 2026-06-11)

The river was removed from the game entirely: the static surface strip never
read as real water (floating ribbons over un-carved dips, X-shaped
interpolation wedges and double-draw moiré where it overlapped the lake
sheet). Decision: no river until a proper water-physics arc (flow, real
volume). Re-enabling is cheap when that day comes — `getRiverDistance` in
terrain.js has a one-line inert switch and the bezier/bed helpers were kept.

## ~~Phase 22 — Waterfall Visuals~~ (REMOVED 2026-06-11)

The waterfall existed only as the river's entrance into the world — removed
with Phase 21. Both live on as a single deferred Part F item below.

---

## Part C — Nature detail pass

## Phase 23 — Natural Logs

**Goal:** replace the straight cylinders.

- [ ] Procedural log geometry: tapered cross-section swept along a slightly
      bent spine, low-frequency surface noise, jagged broken ends
- [ ] Moss color blended on upward-facing surfaces; keep ez-tree bark
      material + capsule colliders

**CHECKPOINT 23:** logs read as fallen trees up close, not pipes.

## Phase 24 — Rock Variety

**Goal:** rocks that belong to their biome.

- [ ] 5–6 procedural archetypes (seeded noise-displaced icospheres): angular
      scree/slabs at the mountain base, ROUNDED water-worn stones along the
      lakeshore, mossy boulders in deep forest, pebble clusters
- [ ] Instanced per archetype; biome-aware scatter via `biomes.js`; sphere
      colliders as now

**CHECKPOINT 24:** river stones round, mountain scree sharp, forest boulders
mossy — each zone recognizably different.

## Phase 25 — Flower Clusters

**Goal:** meadows in colonies, not uniform sprinkles.

- [ ] 3–4 species/colors; cluster placement (patch centers + dense scatter
      within); favor wheat-field edges, lakeshore, forest clearings
- [ ] Export patch positions for Phase 26's butterflies

**CHECKPOINT 25:** stumbling into a flower patch feels like an event.

## Phase 26 — Butterflies + Flies

**Goal:** localized motion, anchored to features — NOT everywhere.

- [ ] New `src/world/insects.js` (dust.js patterns): instanced quads,
      vertex-shader wing flap, noise-wander around a home point
- [ ] Butterflies swarm at flower patches; flies cluster near fallen logs and
      the shore; anchored spawns only

**CHECKPOINT 26:** insects appear exactly where they make sense; zero
perceptible fps cost.

## Phase 27 — Birds

**Goal:** life in the sky — lone soarers and flocks.

- [ ] New `src/world/birds.js`: instanced low-poly birds (a few triangles per
      wing), vertex-shader wing flap with per-bird phase offset
- [ ] Flocks (2–3 groups of 15–30): an invisible anchor wanders a smooth
      noise path over the lake/forest; members hold noise-jittered offsets
      around it with banked turns — the boids LOOK without per-bird O(n²)
      simulation
- [ ] Lone soarers (2–3 hawks): slow thermal circles high over the wheat
      plain and the range — wings mostly still, occasional flap
- [ ] Altitude rides `getHeight` + margin so no bird ever clips a mountain
- [ ] Distant bird-call one-shots near forest/lake (ambience audio pattern)
- [ ] Forward note for Part D: birds roost at dusk (fade with `timeOfDay`) —
      the night sky belongs to stars and fireflies

**CHECKPOINT 27:** from the wheat field, a flock crossing the sky + a hawk
circling overhead read natural; zero perceptible fps cost.

---

## Part D — Sky package

## Phase 28 — Dynamic Sun Refactor

**Goal:** one `timeOfDay` (0..1) parameter drives every light in the scene.

- [ ] `sunDirection` becomes live (mutated in place — water/sky already share
      the reference); recompute the shadow texel-snap light basis on change
- [ ] Sun color/intensity, hemisphere light, fog color, exposure: all curves
      of `timeOfDay`; godrays fade near dusk
- [ ] Debug slider/keys to scrub time while tuning

**CHECKPOINT 28:** scrubbing time moves the sun smoothly; shadows stay
world-stable at every sun angle; golden hour looks golden.

## Phase 29 — Sky v2: Scattering, Moon, Stars

- [ ] Sky dome shader v2: horizon/zenith from a day→sunset→night gradient
      table; sun disc + halo as now; MOON disc + STAR field fading in at night
- [ ] Moon = second directional light (cool, dim); shadow casting SWAPS
      sun↔moon at the transition (one shadow map at a time)

**CHECKPOINT 29:** night is genuinely dark but readable under moonlight;
stars/moon track believably.

## Phase 30 — Day-Night Transition Button

- [ ] HUD button (works outside pointer lock) + `N` key: tweens `timeOfDay`
      over ~25 s — sun sets, sky amber → dusk → night, stars in, moon up
- [ ] Controls panel shows current state (DAY / NIGHT / transitioning)

**CHECKPOINT 30:** pressing the button once delivers the full cinematic
sunset; pressing again brings sunrise.

## Phase 31 — Clouds

- [ ] Drifting FBM-noise cloud layer on a high dome: soft shapes, sun-tinted
      edges (sunset colors come free from Phase 28 curves), slow wind drift
- [ ] Volumetric raymarched clouds explicitly deferred to Part F

**CHECKPOINT 31:** clouds visible day and night, glowing at sunset; no banding.

## Phase 32 — Fireflies + Insect/Bird Crossfade

- [ ] Glowing wandering points near water/tall grass at night (bloom makes
      them pop for free)
- [ ] Butterflies/flies/birds fade out at dusk as fireflies fade in
      (timeOfDay-driven)

**CHECKPOINT 32:** dusk by the lake with fireflies is a screenshot moment.

---

## Part E — Water visuals

**(2026-06-11: most of Part E shipped EARLY during the Water v3 fix round —
see Decisions Log. The lake now has: a half-res refraction pre-pass with
ripple-distorted UVs + analytic per-vertex depth tint, a half-res planar
reflection with grass/flowers/dust layer-excluded, and a physical Schlick
fresnel (F0 0.02, pow 5, capped grazing endpoint). Only caustics remain.)**

## Phase 33 — Caustics (refraction already shipped)

- [x] ~~Render scene to texture before the water pass; water shader samples it
      with ripple-normal-distorted UVs, tinted by per-pixel depth~~ — shipped
      2026-06-11 (half-res refraction RT + analytic depth)
- [ ] Fake caustics in the shallows (animated pattern masked by depth + sun)

**CHECKPOINT 33:** sunlit shallows show drifting caustic patterns; deep water
stays dark; shoreline unchanged from Phase 20.

## ~~Phase 34 — Planar Reflections~~ (DONE 2026-06-11, shipped early)

- [x] Mirrored half-resolution render for the lake plane (grass/dust/flowers
      excluded for cost via `WATER_EXCLUDED_LAYER`); blended with the
      physical Schlick fresnel term
- [x] Reflecting the Part D dynamic sky needs no extra work — the mirror
      renders whatever sky exists when Part D lands

---

## Part F — Long-horizon (defer until A–E feel done)

## Phase 35 — Tree Quality

- [ ] 2–3 hero GLTF assets (scanned-style) near spawn/shores; ez-tree stays
      mid-ground; octahedral impostors for the far field
- NOTE (2026-06-11 perf finding): the frame is VERTEX-BOUND on tree geometry
  drawn across 4 passes (main/shadow/refraction/reflection) — impostors are
  the single biggest remaining fps lever, bigger than any resolution tweak.
  Candidate to pull FORWARD (before or with Phase 16's 1200 m / ~5000-tree
  world), since the cost scales with tree count

## Phase 37 — River + Waterfall (deferred from Part B, needs water physics)

Returns only with a real water-physics arc (flow simulation, volume, current
affecting the player/bodies — the static-ribbon approach is a dead end, see
removed Phases 21–22). Scope when revived: river curve from the western
range's north section along the wheat plain into the lake; cliff step +
waterfall mesh/mist/audio; flow forces in Rapier. `getRiverDistance` keeps
the one-line inert switch + bezier helpers for this.

## Phase 36 — CSM Shadows + WebGPU/TSL Migration (bundled, big)

- [ ] Migrate materials/post to WebGPURenderer + TSL node materials — this
      dissolves the ShaderChunk fog hack that currently blocks CSM, and
      unlocks compute-shader grass/wheat, cheaper reflections, volumetric
      clouds. Treat as a deliberate "engine v2" arc: every onBeforeCompile
      patch and the postprocessing/n8ao/godrays stack gets rewritten

---

## v3 Status

| Phase | Status |
|-------|--------|
| 15 — Controls panel | done — awaiting user check |
| 16 — World 1200 m + shared grid | done — awaiting user check |
| 17 — Western range | planned |
| 18 — Biomes + wheat terrain | planned |
| 19 — Wheat rendering | planned |
| 20 — Natural lake + island | planned |
| 21 — River + waterfall cliff | REMOVED 2026-06-11 (→ Phase 37, needs water physics) |
| 22 — Waterfall visuals | REMOVED 2026-06-11 (→ Phase 37, needs water physics) |
| 23 — Natural logs | planned |
| 24 — Rock variety | planned |
| 25 — Flower clusters | planned |
| 26 — Butterflies + flies | planned |
| 27 — Birds | planned |
| 28 — Dynamic sun | planned |
| 29 — Sky v2 (moon/stars) | planned |
| 30 — Day-night button | planned |
| 31 — Clouds | planned |
| 32 — Fireflies | planned |
| 33 — Caustics (refraction shipped 2026-06-11) | planned (reduced) |
| 34 — Planar reflections | DONE 2026-06-11 (shipped early) |
| 35 — Tree quality (impostors = top perf lever) | planned |
| 36 — CSM + WebGPU/TSL | planned |
| 37 — River + waterfall (needs water physics) | deferred |

## v3 Ordering Rationale

1. UI first (15) — 30-minute win that helps testing everything after.
2. World reshape before visuals (16–20) — terrain changes invalidate scatter
   placements and the physics heightfield; do all surgery before polishing
   pixels. (River/waterfall phases removed 2026-06-11 — see Phase 37.)
3. Nature detail (23–27) — independent of lighting; makes the new world feel
   inhabited while iteration is still cheap.
4. Sky before water reflections (D before E) — ORIGINAL rationale, now mostly
   moot: reflections shipped early (2026-06-11) and mirror whatever sky
   exists, so Part D needs no water rework. Only caustics (33) remain in E.
5. Engine migration last (F) — biggest payoff once the world and look are
   settled; volumetric clouds and CSM both land naturally there. Exception
   worth considering: Phase 35's tree impostors are the measured top fps
   lever and may be worth pulling forward alongside Phase 16.
