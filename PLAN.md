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
- 2026-06-11 (post-Phase-16 perf batch, after user hit ~20 fps aloft): the
  1200 m world fills the entire 500 m far plane in every direction, so
  worst-case views (flying high, long sightlines) got much heavier. Three
  quality-free fixes shipped: (1) LEAF LOD — leaves are 77% of a tree's
  tris; cells beyond 140 m swap to a sparse leaf geometry (every 3rd card,
  scaled 1.75x, built by slicing the indexed quads) — a reference-only
  geometry swap per cell; (2) water pre-passes cull tree cells beyond 200 m
  (beginWaterPrePass/endWaterPrePass brackets in prepareWater); (3) terrain
  chunked 8x8 with seam-free GRID normals (central differences — identical
  for border verts of adjacent chunks; computeVertexNormals would crease).
  Measured at the same aerial view: 113M → 52M tris, 19 → 41 fps. Remaining
  levers: finite fog-off cutoff (~360 m, visible pop tradeoff) and Phase 35
  impostors (the endgame)
- 2026-06-11 (perf batch 3 — "fps jumping" fix + 3x wheat density): user
  reported fps oscillating. Diagnosis: frame cost was MULTI-MODAL — 1 to 4
  scene renders depending on state (standing/moving x lake on/off screen).
  ROOT CAUSE found in the shadow snap: light-space Z (along the light axis)
  was never quantized, so ANY camera movement leaked into the light position
  and `moved` fired EVERY frame — the on-demand 8k shadow map re-rendered
  per frame while walking, free while standing (the oscillation). Shipped,
  all scheduling/no quality loss:
  (1) SHADOW THROTTLE (atmosphere.js): snap on a 16-TEXEL quantum in x, y,
      AND Z (z is depth-uniform = image-identical) — measured 60 → 10
      shadow re-renders per 60 walking frames, 0 standing; plus the shadow
      rig follows a tweening sun in ~0.35 deg STEPS (map+matrices always
      move together — no stale-map swim) — 60 → 22 re-renders during the
      25 s day-night tween, and main.js dropped its unconditional
      needsUpdate in the tween block.
  (2) ALTERNATING WATER PRE-PASSES (water.js): refraction even frames,
      reflection odd (each ~30 Hz, invisible on a rippling surface); both
      render on the frame the lake re-enters the frustum. Halves the
      lake-on-screen cliff.
  (3) PRE-PASS IMPOSTORS (trees.js): water pre-passes render full tree
      geometry only within 80 m; all other visible cells show their
      impostor quad — removes tree vertices from 2 of 4 passes AND the far
      shore now actually reflects past the old 200 m pre-pass cutoff.
  (4) LOD HYSTERESIS (trees.js): geo<->impostor 170/155 m, leaf
      full<->sparse 140/128 m — no per-frame flip-flop at boundaries.
  (5) antialias: false on the WebGLRenderer (composer + SMAA own AA; the
      canvas MSAA backbuffer was allocated+resolved per frame for a
      fullscreen quad). Grass scan Matrix4 hoisted (GC).
  (6) WHEAT DENSIFIER (wheat.js, user request "3-4x denser"): flat 3x =
      +7M tris in field views — rejected. Instead a player-following pool
      (grass.js relocation pattern): 190k EXTRA stalks placed within 55 m
      by the same mask/clearing rules = 3x density everywhere density is
      perceptible (stalks are sub-pixel past ~60 m), zero cost outside the
      field (1 mask sample/frame), parked stalks live 1 km underground at
      zero scale. DENSE_LAYERS=2 const → set 3 for 4x. Verified live:
      pool fully placed 0.1-55 m around spawn, glError 0, mask probes 1.0.
  NOTE (verification): preview tab hidden = rAF never fires; frame counter
  stuck at exactly 192 = 6 variants x 32 impostor bake renders. Drove the
  loop manually via module imports (vite ?t URLs — the clean URL is a
  SECOND instance; read the real ?t from the transformed main.js).
- 2026-06-11 (wheat zone shrink, user feedback "wheat climbs the hills"):
  the 300x380 mask's warped fade band reached the western foothill skirts
  (26 m bump at -280,120 / 22 m at -255,-160) where partial flattening left
  golden wheat on real slopes. Fixed three layers deep: (1) mask shrunk to
  ~240x300 around the world tree, steeper edge (smoothstep 0.8-1.0), warp
  0.18 → 0.12 (biomes.js); (2) HEIGHT BACKSTOP in the scatter — stalks
  reject h > 3.8-5.0 ramped (flattened field tops out ~3.7 m; the densifier
  uses the same rule); (3) terrain gold tint fades over h 4-7 m so no rise
  ever reads as field. Verified: all 620k stalks place, highest stalk
  y = 4.95 m, spawn mask 0.98, tree center 1.0. Same COUNT in ~0.63x the
  area = base field reads ~1.6x denser for free.

Agreed direction: keep the stack (three.js + Rapier + Vite) and the
single-source-of-truth architecture (`getHeight` / `getLakeDistance` / biome
masks). Reshape the world to the v3 map, then layer life and visual upgrades.
(A combat/destruction arc may be added later — out of scope for now.)

**Target world layout** (v7, revised 2026-06-11: compacted to ~900 m for
perf — was 1200; every biome retained, repacked; see Part B2):

- **West:** bare rocky mountain range hugging the rim and continuing past the
  world boundary (no visible "end"), lumpy noise-warped inner edge, tapering
  into scattered foothills north and south. Doubles as the natural west border.
- **Center-west:** EXPANDED wheat plain (~300×380 m) from the mountain skirt
  down to the lake's west beach, with the WORLD TREE — a giant hero oak, the
  largest tree in the world — standing alone at its center; 2 smaller lone
  oaks near the field edges; spawn at the field's lakeside edge.
- **Center-east:** lake SHIFTED EAST (~+90 m, no longer dead-center) so its
  far shore presses straight against the deep forest; natural (noise-warped,
  elongated) shoreline + small island (~15–20 m) near the northeast shore.
- **East:** deep rolling forest rising directly from the lake's east beach.
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

- [x] Ridge band in POLAR coordinates (theta from due west): amplitude rises
      from a noise-warped inner edge (rIn = 395±55 per angle -> spurs and
      valleys, no clean curve) and keeps rising past `WORLD_RADIUS` to the
      mesh edge, so the massif never visibly ends; peaks ~80-105 m; ragged
      noise-warped angular taper (full ±50 deg, fading to ±80 deg)
- [x] Tapered ends: low ridged skirt spills inward of the main wall +
      4 discrete gaussian foothills (FOOTHILLS table) shrinking into forest
- [x] Old east range removed — east is rolling forest to the rim (verified
      h(520,0) = -2.2)
- [x] Treeline 15 m (trees thin from 11 m; grass capped at 14 m); snow via a
      per-vertex `aSnow` attribute from the shared grid (h 52-64 ramp,
      slope-masked so cliffs shed it), blended in the terrain shader
- [x] camera.far 500 -> 700 + sky dome 440 -> 650 so the massif is visible
      from mid-map (affordable post leaf-LOD/chunking)
- NOTE: crest silhouettes show some sawtooth serration up close (ridged
  noise creases on the 1.56 m grid) — acceptable at gameplay distances,
  candidate polish for a later pass
- GOTCHA hit during build: getHeight already had `const r` (river block) —
  the new range code's `const r` was a SyntaxError that silently killed the
  whole app (blank no-__renderer state). Named `dist` instead

**CHECKPOINT 17:** from the wheat-plain site the range reads as one continuous
massif with no visible end; climbing west you hit real cliffs (natural border).
Verified remotely (wide + crest views, snow caps, east forest check, truth
test 6/6); the climb feel is the user's checkpoint.

## Phase 18 — Biome Module + Wheat Plain Terrain

**Goal:** one queryable source of truth for "what grows where".

- [x] New `src/world/biomes.js`: `getWheat(x,z)`, `getDeepForest(x,z)`,
      `getAlpine(x,z)` → 0..1 masks. Standalone module (own noise, no
      terrain import) so terrain.js itself can consume it. Wheat = rounded
      superellipse ~250×350 m at (-240, 15), noise-warped edges, faded out
      before the lake's beach band (dl 92-112)
- [x] Wheat mask flattens `getHeight` toward 0.3× its low-frequency term
      (+1.4 m baseline — farmland roll, not a billiard table); terrain
      vertex colors blend to dry gold in the field (muted by the brown
      forest-floor texture underneath — Phase 19's wheat mesh provides the
      real volume gold), deep-forest east darkened 22%
- [x] Trees: in-field scatter fully rejected (soft mask edge blends the
      forest boundary); 3 full-size lone oaks (scale 1.45, with colliders)
      at (-230,-35) (-278,95) (-172,70) — verified placed by reading back
      instance matrices; grass skips the field
- [x] Deep-forest density (FIXED at user verification round): closing
      clearings alone did nothing — the blue-noise MIN_DIST is what caps
      density, and the forest was saturated. East now shrinks MIN_DIST by
      up to 38% + budget 5000 → 5600. Measured per 150 m box: field 2
      (the oaks), mid forest 137, deep east 151-166, plus the 22% darker
      floor. Ground tint measured in rendered pixels: field RGB(169,120,51)
      golden vs forest RGB(52,64,17)
- [x] Spawn already sat at the wheat's lakeside edge (-120, 30, mask 0.59)
      — unchanged

**CHECKPOINT 18:** (dry run, no wheat mesh yet) golden flattened plain with
lone oaks, denser darker forest east, scatter masks all respect biomes.
Verified remotely (mask probes, instance read-back, top-down + ground
views); by-eye color judgment is the user's checkpoint.

## Phase 19 — Wheat Rendering

**Goal:** the golden field, waving in gusts.

- [x] New `src/world/wheat.js`: 500k STATIC stalks (stem quad + two crossed
      seed-head quads, 6 tris each; chest-height 1.0-1.5 m with narrow ~5 cm
      heads — tuned twice against the user's reference photo: wide head
      quads read as flags up close, and warm bright gold beats olive),
      instanced per 55 m grid cell with real bounding spheres (tree
      pattern, frustum-culled); scattered by the Phase 18 mask (density
      follows mask^1.3 — full core, thinned warped edges); on
      WATER_EXCLUDED_LAYER like grass; receiveShadow (the lone oaks throw
      shadows across the field). Field-heavy view: 7.8 ms (~128 fps) warm
- [x] Root→tip gradient (dusty olive → warm gold) in the patched Lambert
      shader + per-stalk HSL jitter via instanceColor; world-up lighting
      normal (grass pattern, no black backfaces)
- [x] Coherent gusts: one shared traveling wave (26 m wavelength + two
      harmonics) leans tips along the gust direction with per-stalk flutter
      on top; the gust front brightens the heads by ±8% (the rolling
      shimmer). uTime driven from the main loop (updateWheat)
- NOTE: stalks read slightly flat/planky within ~3 m (bare quads) —
  acceptable; candidate polish is a tiny texture or awn fringe later

**CHECKPOINT 19:** field reads as wheat from 5 m AND from 200 m; gusts roll
visibly across it; fps budget holds at the field center. Verified remotely:
eye-level + distance views read as a golden field, full-frame cost at a
field-heavy view 14.1 ms (~70 fps); gust MOTION is the user's checkpoint.

## Phase 20 — Natural Lake + Island

**Goal:** kill the circle.

- NOTE (2026-06-11): the implementation landed BEFORE the B2 reorder was
  seen — but it was built parametrically around the lake-center constants
  and getLakeDistance, so the Phase 38 move to (+90, 0) re-derived
  everything (mask rebake, mesh position, island) with zero rework. The
  "shoreline work once, on final geography" intent was satisfied by
  construction.

- [x] Warp `getLakeDistance`: rotated (~27°) elongated ellipse (1.27/0.82
      axes) + two noise octaves (13 m + 5 m) — returns circle-equivalent
      meters, so basin carve, dry rim, water level, and all scatter masks
      updated automatically with no threshold retuning
- [x] Island: flat-topped noise-wobbled bump (~22 m across, crest ~+2.9 m
      over water) NE of the lake center, placed AFTER the basin block in
      getHeight (the beach min() would flatten it); vegetation put trees on
      it unprompted; physics/foam automatic
- [x] Per-pixel mask: warped distance baked into a 256² texture (±150 m
      around the lake center, R = d/300), sampled in the fragment shader;
      lake plane 240 → 280 m; pre-pass frustum sphere follows the center

**CHECKPOINT 20:** shoreline shows real bays + automatic foam ring around the
island; no water leaks into forest dips; swim/buoyancy still work. Verified
remotely (top-down shape, island + trees, leak scan, getWaterLevel/clip
consistency); swim feel is the user's checkpoint.

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

## Part B2 — World compaction & landmarks (added 2026-06-11, v7 map)

Perf-driven layout revision: the 1200 m world fills the far plane in every
direction and the frame is VERTEX-BOUND on tree geometry across 4 passes
(see the 2026-06-11 perf notes). Compact the world, keep every biome, and
plant the world tree. Phases numbered 38/39 (20–37 already allocated);
EXECUTION ORDER: 38 → 20 (lake reshaped at its new center) → 39 →
Phase 35's impostors (pulled forward) → Part C.

## Phase 38 — World Compaction (1200 m → 900 m)

**Goal:** roughly half the worst-case vertex load; nothing lost but empty
distance.

- [x] `WORLD_SIZE` 1200 → 900, `WORLD_RADIUS` 560 → 420, TERRAIN_SEGMENTS
      768 → 576 (same 1.5625 m pitch; 8×72 chunks; truth-test 6/6 after
      fixing a TEST artifact — sample point (150, 9) sat EXACTLY on a
      lattice column at the new pitch and Rapier's ray-through-edge case
      misses degenerately; points nudged off-lattice)
- [x] Lake moved east to (+90, 0). GOTCHA found by verification: the wheat
      mask's lake-fade used Math.hypot(x, z) — distance from the ORIGIN
      (the lake's old home, an approximation from before the move) — which
      killed wheat in a circle through the field's east half. Fix: lake
      center constants now live in biomes.js (the import root), terrain.js
      re-exports them as LAKE_X/LAKE_Z; water mesh/mask/frustum-sphere all
      follow the constants
- [x] Wheat expanded: superellipse (-130, 10), 300×380 m, fade 108–126 m
      from the lake center; flatten/gold/scatter re-derive; wheat 500k →
      620k stalks (keeps Phase 19 density on the 1.3× field)
- [x] Deep forest meets the lake's east beach (mask ramp 120→240 + warp);
      western range rescaled (rIn 300±45, rise band 95 m, guard 210) —
      still rising past the rim, peaks/snow preserved; foothills moved in
- [x] Scatter: trees 3200 (GRID_HALF 450, ~14×14 cells), forest logs 18 +
      5 shore (ring follows the lake), forest rocks 45, flower clumps 120;
      lone oaks repositioned into the new field
- [x] Spawn (-45, 15) at the wheat's lakeside edge (full wheat, flattened,
      dry); camera.far 700 → 900 — the whole world fits inside the far
      plane from anywhere, so horizon/rim pop is impossible by construction;
      v7 vista fix: trees cleared from the beach ring (lake dist < 102,
      island exempted — it keeps its 4 trees) so the lake reads from the
      field edge
- [x] Perf at the SAME aerial view: 48 M tris / 21.8 ms vs baseline 52 M /
      ~24 ms — only ~10% better, NOT the hoped halving: far 900 now draws
      the entire world from that view, eating most of the compaction win.
      The real lever is the next step in the B2 order (impostors)

**CHECKPOINT 38:** every biome present and proportioned like the v7 map;
edge-to-edge walk feels right; aerial fps measurably above the 1200 m
baseline. Verified remotely (probes + views); walk-feel and proportions
are the user's checkpoint.

## Phase 39 — The World Tree

**Goal:** the landmark — a giant lone oak in the middle of the wheat field.

- [x] Hero oak at the wheat center (-130, 10): ONE non-instanced 'Oak Large'
      generation (seed 31415, children 11/6/4, beefed sections/segments,
      leaves.size 6.5 — preset-size 4.5 leaf cards read as a sparse brown
      bramble from the field) scaled by MEASURED bbox to 50 m tall; canopy
      span ~50 m. branches 28.5k tris + leaves 21.8k tris ≈ 50k total —
      trivially cheap even ×4 passes, no reduced representation needed
- [x] Clearing: `getWorldTreeClearing` mask in biomes.js (1 at trunk → 0 at
      ~24 m dripline, noise-warped) — consumed by wheat scatter (fade-out),
      terrain tint (bare packed-earth ring, AFTER the gold so it overrides),
      and tree scatter. Deliberately NOT folded into getWheat: the wheat
      mask drives the terrain FLATTEN, and a hole there would crater the
      ground under the tree. Grass stays excluded by the unchanged wheat
      mask → ground under the canopy is genuinely bare
- [x] Physics: trunk cylinder r≈1.3 halfH 14 (treeColliders gained optional
      halfH; physics honors it) + 7 half-buried root-flare balls riding the
      rock ball-collider path (worldTreeFlares → rocks concat in main.js).
      Verified by Rapier raycasts: trunk hit at 1.27 m from center, flare
      ring surface 0.35–0.9 m proud of the flat field
- [x] Always visible: plain scene-level Mesh, never in cellMeshes → exempt
      from distance cutoff, leaf LOD, and water pre-pass culling by
      construction. Verified from spawn (85 m: towers over the forest
      line) and the lake's far shore (~330 m, fog off). Unlike forest
      leaves, the hero canopy DOES cast shadows — the cathedral shade is
      the point, and it's one mesh
- [x] Lone oaks 3 → 2, relocated to the field edges: (-205, 130), (-78, -118)
- [x] Cost check: ~50k tris on a 19-30M tri frame — noise. fps unchanged

**CHECKPOINT 39:** verified remotely — spawn vista, under-canopy (god rays
filter through the canopy, trunk soars off-frame), bare-earth ring, far-shore
skyline. NOTE the brown domes visible from spawn are the western range's
bare-rock peaks (fog off), not the tree. Cathedral-feel in motion is the
user's checkpoint.

**v8 GIANT REBUILD (2026-06-11, user reference image):** the 50 m oak was
re-spec'd to a true World Tree after the user supplied a reference (colossal
tower-trunk oak dwarfing mountains). Calculated against the live world
(raycast sweep: terrain max 108.4 m at (-380,170), snow line 52-64, forest
canopy tops ~20-30 m): **~112 m tall** — crown above every peak — with a
**7.5 m radius tower trunk** (reference proportion: trunk diameter ≈ 13% of
height), bare to ~55% of the 60 m trunk path, limbs at 82° + upward force
0.04 forming the mushroom dome (~115 m span). Custom ez-tree options replace
the preset tweak (child radius values are MULTIPLIERS of the parent radius
at attachment; level-0 is absolute). ~92k tris total — still noise.
Clearing mask widened to the new dripline (1 at 14 m → 0 at ~52 m, warp ±6),
bare-earth tint tightened to the root zone (clearing > 0.6), trunk collider
r≈5.6 halfH 26, 9 giant root flares. GOTCHA: leaves cast+receive shadow made
the dome shade ITSELF pitch black (sunlit side read as a black mass — a dome
this dense is opaque to the shadow map); fixed with cast-without-receive =
bright dome above a real ground-shadow disc. GOTCHA 2 (verification): raw
kinematic teleports bypass teleportPlayer's verticalVelocity reset — at
terminal velocity the capsule punches through the heightfield and the camera
films the world from underneath (reads as "upside down" shots).

**v9 COLOSSUS REBUILD (2026-06-11, "triple it + visible branch system"):**
3x re-spec to the user's reference (massive buttress-rooted oak). Measured
live: **336 m tall**, crown span ~255 m (capped below reference proportion —
full proportion would be ~430 m and swallow the whole 300 m wheat field),
trunk ~37 m dia (11%), bare gnarled trunk to ~96 m (29%), 8 monster limbs
(angle 34°, start 0.42, gnarliness 0.09 + twist 0.12). NEW: (1)
buildShellLeaves — ellipsoid-shell filter over the leaf-card quads (keep
outer shell + sparse 12% interior) so the interior limb skeleton is visible,
per the user's explicit ask; leaves.start 0.65 + branch start {3: 0.5} push
foliage to the periphery before the filter. (2) createWorldTreeRoots — 12
swept buttress roots (elliptical tall cross-section, noise lumps, ~55%
fork once, tips buried), one merged mesh on the tree's bark material; ball
colliders along each spine via the existing worldTreeFlares path
(climbable). (3) Terrain knoll: +7.5 m Gaussian dome (sigma 55) in getHeight
AFTER the wheat flatten — physics/scatter inherit it. (4) Clearing mask
rescaled (1 at 40 m → 0 at ~135 m, early-out 160). (5) Boulder ring (14)
at the root tips in rocks.js. (6) Hawk orbit r 170 alt 210 speed halved.
(7) Shadow rig rescaled for a 336 m caster: light offset 130 → 400 m,
far 260/520 → 760/1000, normalBias 0.3 → 0.45 (XY box unchanged).
GOTCHA (the big one): the crown is now seen mostly from BELOW — no direct
sun + deliberately-low ambient measured the canopy ~BLACK (1,3,0) from the
field; receiveShadow on/off made NO difference (the v8 black-dome cause was
a red herring at v9 scale). Fix: fake bounce light — emissive (0.6,0.66,0.42)
through the leaf atlas as emissiveMap, emissiveIntensity driven per-frame by
setWorldTreeCanopyGlow(sun.intensity/5.5) from main.js so it dies at night.
Verified by pixel readback: crown from field (74,109,26) 8% dark, look-up
through the shell 43% sky (skeleton visible), roots bark-toned; scene render
6.5 ms facing the tree (~5.9M tris). Hero cost ~74k tris total. Walk-feel,
under-canopy cathedral, and root-climbing are the user's checkpoint.

**v10 (2026-06-11, user-verified fix list + 2x crown):** four user
observations, all confirmed by measurement, all fixed:
(1) LEANING TRUNK — centerline measured ~20 m off axis at 100 m up
(gnarliness 0.09 + twist 0.12 random-walk over the 60-unit path). Fix:
trunk gnarl 0.02 / twist 0; limbs keep their gnarl (though dialed to
0.08/0.12/0.1 — at 0.14/0.18 whole limb chains went near-vertical and
drooped foliage to ~5 m off the ground). Re-measured: 0.2-1.8 m off axis.
(2) FLOATING BASE — flat base disc at getHeight(center)-0.25 hovered ≤1.5 m
over the knoll's downslope rim. Fix: sink 3 m.
(3) ROOT/TRUNK COLOR MISMATCH — same material object, but root UVs tiled
bark 3-5x finer than the trunk (38x9.4 m/tile vs 12.6x7) = measured ~35%
darker + browner. Fix: root tiling matched to trunk world density
(tilesU from r0, v per 9.4 m); per-root constant around-count avoids shear.
(4) CROWN 2x WIDER, WIDE TOP — structurally impossible inside ez-tree:
PROBED (levels-1 param sweep in-page) that every level grows a LEADER child
continuing the parent's direction, so pre-scale height is locked to the sum
of path lengths and span can never exceed height. Two-part fix: NON-UNIFORM
world scale (scaleY for the 336 m height, scaleXZ for the 500 m span — the
roots are world-space so untouched; trunk collider uses scaleXZ) + a radial
post-warp (+45% max, ramping above 35% height, applied pre-bbox so the
normalization refits) to move the widest band UP. Also: limbs start 0.75,
angle 80, leaf-shell yFloor 40 (pre-units) culls gnarl-drooped low cards.
Measured final: 336 m tall, span 455x500, crown band 60-336 m, top-decile
radius profile 191/200/206/184/77 (widest at ~200 m = parasol), trunk 32 m
dia, hawk orbit r 280. GOTCHA: tod drifts ~3 s per page load before the
hidden preview tab freezes rAF — color comparisons across evals need
setTimeOfDay() pinned first (sun azimuth at tod 0.4 ≈ high-east).

**v10.1 (2026-06-11, user screenshot: big sky gaps through the crown):**
the holes are wedges BETWEEN limb fans — no twigs there, so no card-count/
spread/shell parameter closes them (proved by A/B: count 16→26 and
leaves.start 0.65→0.35 left look-up sky ~0.4-0.5; start 0.35 even THINNED
the underside because spread cards landed in the interior cull zone). What
worked: (a) children {0: 11} — more limbs narrows the wedges (crown-from-
field sky 0.28→0.08); (b) SYNTHETIC GAP FILL in buildShellLeaves — ~4.6k
extra cards scattered directly on the shell ellipsoid (72-95% radius,
bottom-biased cos-polar in [-1, 0.85]), merged into the same geometry,
leaf-atlas UV 0-1, random tangent orientation. 16x16 hole-cell heat map:
bottom bowl fully closed; the residual ~15 'hole' cells are rays grazing
past the tapering apex (identical count across 3 fill densities =
structural, not foliage). Leaf mesh ~77k tris — still noise. Final params:
leaves count 26 size 7.5 start 0.5, shellStart 0.4, keepInterior 0.16.

**v11 (2026-06-11, user decision: "the giant tree is not fitting well"):**
COLOSSUS RETIRED. The field center is now ONE standard oak — stock
'Oak Large' preset (seed 31415), measured-scaled to 30 m, span ~31 m,
~22.6k tris — plus a WEED PATCH underneath (user ask): 700 instanced
3-blade tufts, 0.45-1.1 m, dry olive/straw palette, grass.js-style sway +
root-tip gradient (patchWeedMaterial; uTime via leafMaterials/updateTrees).
The wheat mask keeps lawn grass out of the field, hence dedicated weeds.
Removed: buildShellLeaves + gap fill, createWorldTreeRoots, knoll
(terrain), canopy glow rig (trees+main), boulder ring (rocks), non-uniform
scale; worldTreeFlares export stays (empty) for main.js's concat. Reverted:
shadow rig (offset 130, far 260/520, normalBias 0.3), hawk orbit (r 48,
alt 45, rev/s 0.04 ≈ 12 m/s), clearing mask (1 at 3 m → 0 at ~17 m,
early-out 26). Leaves cast-no-receive (cast+receive measured 50% near-black
blotch even at this size); verified vs forest canopy under identical
staging: forest reads 79% dark vs lone oak 47% — the oak is BRIGHTER than
the house style, fits. Weed zone reads (165,152,88) gold-green. The
user's walk-by check: oak proportions, weed feel, wheat closing to ~17 m.

**v12 (2026-06-11, "current one looks ugly — find a good oak"):** the lone
oak is now a PHOTOSCAN — Poly Haven "Island Tree 01" (CC0, Rob Tuytel/Rico
Cilliers), picked by downloading + visually comparing the 5 Poly Haven
broadleaf candidates (island_tree_01/02/03, jacaranda, tree_small_02);
01 is the most oak-like (gnarled trunk, exposed roots, dense crown). Files
in public/models/island_tree_01/ (2k texture set + 60 MB LOD0 bin, ~80 MB
total — NOTE for git). Loaded async via GLTFLoader in createWorldTree;
collider (r 1.3) pushed SYNC so initPhysics never waits. Measured-bbox
scaled to 16 m tall / ~15 m crown, bbox bottom sunk 0.25 m so the root
flare grips. GOTCHA: glTF leaves ship alphaMode BLEND — converted at load
to alpha-test 0.45 + depthWrite (BLEND breaks canopy sorting AND skips the
depth the AO/godrays/water passes read). 1.6M tris (file has LOD0 only
despite lods:true). Perf: 7.92 ms facing it at ~8.9M tris/frame vs 6.54 ms
before — +1.4 ms main pass; if it bites, next lever is excluding the hero
from the 2 water pre-passes (needs shadow-camera layers tweak — the
WATER_EXCLUDED_LAYER trick alone would kill its shadow). Weeds unchanged.
Forest stays ez-tree (instancing/impostor pipeline depends on it).

---

## Part C — Nature detail pass

## Phase 23 — Natural Logs

**Goal:** replace the straight cylinders.

- [x] Procedural log geometry (buildLogGeometry in trees.js): 4 seeded
      variants — tapered radius along a bent spine (arch + sideways drift),
      low-frequency thickness swells (knots), per-vertex bark lumpiness,
      jagged X-jitter on the end rings + end caps fanned to an INSET center
      point (broken-grain look). GOTCHA: first build was wound inside-out
      (black top, lit interior through the DoubleSide bark) — winding flipped
      so computeVertexNormals points outward
- [x] Moss via vertex colors on the shared ez-tree oak bark material
      (vertexColors=true; white=bark, >1-green=moss patches on up-facing
      verts, pale=end grain); colliders use per-variant halfLen/r through
      the same logColliders path

**CHECKPOINT 23:** verified up close in browser — bark texture, mossy top,
taper + bend; reads as a fallen tree. User checks in motion.

## Phase 24 — Rock Variety

**Goal:** rocks that belong to their biome.

- [x] 5 procedural archetypes (rocks.js rewritten, GLB models dropped):
      seeded noise-displaced icospheres — angular `scree` + flattened `slab`
      (non-indexed = faceted for free), rounded `worn` (weld via
      mergeVertices FIRST — Icosahedron is non-indexed, so
      computeVertexNormals alone gives flat shading; drop the normal
      attribute pre-weld or differing normals block ALL welding), mossy
      `boulder` (vertex-color moss on up-facing), `pebbles` (6-9 small worn
      stones merged per cluster, no colliders). Shared MeshStandardMaterial
      with the terrain's rock_diff texture (set SRGBColorSpace — a fresh
      TextureLoader copy doesn't inherit the terrain's). GOTCHA: blobs are
      built CENTERED — rebase to rest on y=0 or half the rock is buried at
      placement (the old GLBs came pre-rebased)
- [x] One InstancedMesh per archetype (per-instance yaw + non-uniform
      squash + grey tint via instanceColor); biome scatter: scree/slabs at
      h 16-62 on the range, worn stones on the lakeshore ring, boulders
      where getDeepForest > 0.45, strays + pebbles on open forest floor
      (world-tree clearing excluded); ball colliders as before

**CHECKPOINT 24:** verified per-biome placement (instance positions) +
visual spot-checks (worn shore stones round and resting on the surface,
scree on the slopes). Mossy boulders + full-biome look: user check.

## Phase 25 — Flower Clusters

**Goal:** meadows in colonies, not uniform sprinkles.

- [x] 4 species from the 2 GLBs x 2 petal palettes (white, violet-tinted
      white, yellow, poppy-tinted yellow — petal materials found by HSL
      lightness > 0.45, stems stay green); 78 single-species PATCHES
      (2.5-6 m radius, 12-26 flowers, center-biased scatter = dense heart,
      ragged edge), one InstancedMesh per species (~1400 flowers).
      Placement favors the wheat-field edge band (0.04 < mask < 0.5),
      the lakeshore band (58-100 m from lake center, h < 3), and forest
      clearings (tint > 0.55); rivers/steep/world-tree clearing excluded.
      GOTCHA: spawn-guaranteed patches must use the same qualifying rules —
      naive spawn-radius placement put them INSIDE the wheat field where
      1.25 m stalks bury 0.32 m flowers (expanding-ring search instead;
      they land 31-59 m out on the field's fade band)
- [x] `flowerPatches` ({x, z, r}) exported for Phase 26

**CHECKPOINT 25:** colonies verified in browser. "Feels like an event" is
the user's walk-test.

## Phase 26 — Butterflies + Flies

**Goal:** localized motion, anchored to features — NOT everywhere.

- [x] New `src/world/insects.js`: ALL animation GPU-side via one shared
      onBeforeCompile patch (uTime + per-instance aFlight vec4 = phase /
      flapSpeed / wanderRadius / flightHeight; home point lives in the
      instance matrix translation). Butterflies: two trapezoid wings hinged
      at the body, flap = rotate about the hinge (x*cos, y += |x|*sin),
      slow figure-eight wander + altitude bob, 5-color palette via
      instanceColor (unlit Basic — colors scaled 0.75 so they don't glow).
      Flies: 2-3 cm dark diamonds, fast erratic buzz-ball orbit. Per-frame
      CPU cost: two uniform writes
- [x] Anchored spawns ONLY: 240 butterflies at ~60% of flower patches
      (5 each), 154 flies at ~55% of fallen logs + 7 waterline spots.
      Both on WATER_EXCLUDED_LAYER, no shadows

**CHECKPOINT 26:** verified anchors + motion in browser (t-jump test:
positions/wing poses change with uTime). Flutter feel in motion: user check.

## Phase 27 — Birds

**Goal:** life in the sky — lone soarers and flocks.

- [x] New `src/world/birds.js`: 8-tri birds (diamond body + 2-tri wings,
      +Z forward), one MERGED mesh per flock (not InstancedMesh — per-bird
      data rides per-vertex attributes, ~600 verts/flock, frustumCulled
      false since the anchor lives in uniforms); wing flap rotates wing
      verts about the shoulder line, per-bird phase
- [x] 3 flocks (26 lake / 18 deep forest / 22 north woods): invisible
      anchor on a sum-of-sines wander path — CPU per frame is 3 anchor
      updates (heading from motion, shortest-angle smoothed, bank from turn
      rate) + uniform writes; members hold jittered formation offsets
      rotated by the heading. Boids look, zero per-bird simulation
- [x] 3 hawks, fully GPU (per-vertex circle attrs): thermal circles with
      constant inward bank, wings in glide + occasional flap bouts
      (pow-6 sine gate), slow altitude breathing. One circles the WORLD
      TREE at crown height (alt 96 — GOTCHA: getHeight only knows terrain,
      not the 112 m tree; the margin must carry it); others over the range
      foothills and the lake
- [x] Flock altitude: getHeight(anchor) + 30 every frame, climbs fast /
      descends lazily; hawk altitude: max getHeight over 16 circle samples
      + margin at creation
- [x] Bird calls: PROCEDURAL WebAudio (no asset exists) — 3 chirp recipes
      (descending whistle / double chip / trill), soft random pan, 7-18 s
      apart, suppressed over the bare range (x < -240); enabled by the same
      pointer-lock gesture as the ambience loop
- [x] Birds deliberately NOT water-excluded: a flock crossing the lake
      reflects, and at 8 tris/bird the pre-pass cost is noise
- Part D forward note: birds roost at dusk (fade with `timeOfDay`) — the
  night sky belongs to stars and fireflies

**CHECKPOINT 27:** verified in browser — flock of banked silhouettes
crossing the sky over the wheat field beside the world tree, drift + flap
confirmed across frames. Hawk-overhead feel + calls: user check (calls only
play after click-to-enter).

**VISIBILITY FIX (2026-06-11, user couldn't find the flocks):** three real
causes verified live — (1) flocks cruised at +30 m, BELOW the treeline
silhouette from the ground (dark birds against dark forest = invisible);
now +55 m / floor 42 so they ride against the sky. (2) Hawk speed constant
was effectively rev/s-scale: 41-49 m/s fighter-jet circles; now ~10 m/s
glides (full circle 36-45 s). (3) Wingspans bumped 0.9-1.25 → 1.3-1.75 m —
smaller vanished into single pixels at the 100-300 m flock distances.
Chirp volume also doubled (was inaudible under the ambience loop).

---

## Part D — Sky package

## Phase 28 — Dynamic Sun Refactor

**Goal:** one `timeOfDay` (0..1) parameter drives every light in the scene.

- [x] `timeOfDay` (0.25 sunrise / 0.5 noon / 0.75 sunset) in atmosphere.js;
      sun path CALIBRATED so the default 0.35 reproduces the old static
      morning exactly (az 65, el 34 — maxEl 58, az 28→215 over the day).
      All exported color/direction objects are now LIVE (mutated in place):
      sunDirection, SUN_COLOR, FOG_COLOR, ZENITH_COLOR — the sky dome
      shares refs already; water.js switched its 3 COPIED uniforms to the
      shared refs (one-line each)
- [x] Texel-snap light basis recomputed when the active light's direction
      changes (epsilon-gated); shadows re-render on move/swap only
- [x] Curves keyed on sun height (sin el): dayMix/goldenMix/nightMix drive
      sun+hemi color/intensity, fog color, exposure (1.0 night → 1.15 day,
      +0.07 golden), star fade. GOTCHA: scene.fog COLOR stays main.js's job
      (it owns the underwater-murk override) — the loop copies the live
      FOG_COLOR only while above water. Godrays gated `raysUserOn && sunUp`
      (F6 now sets intent; the pass samples the SUN's shadow map which the
      moon owns at night)
- [x] Impostors (day-baked atlases) follow via a SHARED live `impostorTint`
      color (white day / warm golden / moonlit-dim night) multiplied in
      their fragment stage
- [x] Debug: [ / ] keys scrub time (hold to ride), HUD `[ ] time HH:MM`
      row; window.__game.setTimeOfDay/getTimeOfDay/atmosphere

**CHECKPOINT 28:** verified in browser — default morning pixel-faithful to
the pre-refactor look; golden hour (t 0.71) goes warm amber with a pink
western sky. Smooth-scrub feel + shadow stability in motion: user check.

## Phase 29 — Sky v2: Scattering, Moon, Stars

- [x] Sky dome shader v2: gradient uniforms are the live colors (day →
      sunset → night for free); sun disc/halo fade via uSunVis; MOON disc +
      cool halo (uMoonDir live, anti-phase path at maxEl 48); STAR field —
      hashed cells in azimuth/height space, per-star brightness variety,
      faded by uStarMix and horizon haze
- [x] Moon = second DirectionalLight (0xa9bedd, 0.55 at night); shadow
      casting SWAPS at sun height -0.04: old light's map DISPOSED (one 8k
      map at a time — two would be ~half a GB), new light gets the shadow
      camera config, snap state force-reset, main.js resets the godrays
      shadow-map latch when the sun returns

**CHECKPOINT 29:** verified in browser — night is genuinely dark but the
wheat field stays readable under moonlight, stars across the sky, moon
casting confirmed (sun 0 / moon 0.55, castShadow swapped). Believable
moon/star tracking over a full cycle: user check.

## Phase 30 — Day-Night Transition Button

- [x] `N` key + the HUD cycle row as a CLICKABLE button (delegated listener
      on #controls — render() rebuilds innerHTML, killing direct listeners;
      works outside pointer lock): tweens timeOfDay with a smoothstep ease
      over 25 s, always FORWARD through the cycle (day 0.35 → night 0.97
      via sunset; night → next-day 0.35 via dawn). [/] scrubbing cancels a
      running transition (manual wins)
- [x] HUD cycle row shows DAY / NIGHT / → NIGHT / → DAY (driven from the
      loop's sky.sunUp when idle, by the transition when running)

**CHECKPOINT 30:** verified in browser — full round trip: N at day reached
t 0.97 (moon casting) in ~25 s, second N rode through dawn and landed at
EXACTLY t 0.35 with the sun casting at 5.5 and the godrays latch rebound;
zero GL errors through both shadow swaps. Cinematic feel: user check.

## Phase 31 — Clouds

- [x] Cloud dome (radius 635, just inside the sky sphere, transparent so it
      renders after the opaque sky): planar-projected 4-octave FBM
      (dir.xz / (dir.y + 0.22) — flat layer converging at the horizon),
      slow wind drift, screen-space dither vs banding. Body color rides the
      timeOfDay curves (white day / amber golden / dark night); silver
      lining rims toward the ACTIVE light (sun by day, moon at night).
      GOTCHA: at uv scale 0.9 the whole sky spanned ~2 noise cells — one
      continent blob or one empty gap (verified live: clear sky); 3.8 gives
      cumulus-scale puffs. Internal lum contrast (bright tops / grey bases)
      is what makes them read as clouds instead of haze
- [x] Volumetric raymarched clouds explicitly deferred to Part F

**CHECKPOINT 31:** verified in browser day + night; sunset glow rides the
Phase 28 curves. In-motion drift: user check.

## Phase 32 — Fireflies + Insect/Bird Crossfade

- [x] New src/world/fireflies.js: 210 additive POINTS (150 lakeshore band +
      60 grassy clearings), GPU wander + blink gate (smoothstep of sin —
      real off-time), >1 color channels feed the bloom. Faded by the SHARED
      live `nightGlowFade` scalar from atmosphere.js. Deliberately on the
      default layer: fireflies reflect in the night lake
- [x] Crossfade via uniform-shaped live scalars exported by atmosphere.js:
      `dayCreatureFade` scales insect/bird GEOMETRY to zero at dusk (no
      transparency sorting — zero-size tris rasterize to nothing), shared
      as a uniform object by all 6 creature materials; bird CALLS also gate
      on it (birds roost; night silence until an audio arc)

**CHECKPOINT 32:** verified in browser — moonlit beach with moon-cast tree
shadows, stars, blinking shore fireflies at 60 fps (16.7 ms). The dusk
"screenshot moment" in motion (blink + bloom): user check.

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

- [x] IMPOSTORS SHIPPED (2026-06-11, pulled forward): far-field trees render
      as ONE camera-facing quad each past 170 m. NEW src/world/impostors.js:
      each of the 6 ez-tree variants bakes a 16-azimuth x 2-elevation-ring
      (8°/45°) view atlas at startup (128px tiles, 32 bake renders/variant)
      lit with the game's exact static sun + hemisphere — baked shading
      matches live trees, and tone mapping stays single-pass because three
      skips tone mapping for render-target renders and the composer's final
      pass maps the whole frame once. Lit values exceed 1.0 (sun 5.5) but
      the atlas is 8-bit (half-float mip generation is driver roulette), so
      lights bake at 1/3 intensity and the shader multiplies back. Bake
      tiles go through the TARGET's viewport/scissor (renderer.setViewport
      would dpr-scale and corrupt canvas state). Per-cell impostor
      InstancedMesh shares the tree instance matrices; the vertex shader
      does spherical billboarding about the canopy center and nearest-frame
      selection from the view direction. Instance yaw deliberately IGNORED
      in frame selection: honoring it would rotate the BAKED sun with each
      tree (inconsistent lighting across the forest); all impostors show
      the unrotated tree instead — silhouette variety lost at distance,
      lighting consistent. updateTrees is now 3-state (full geo < 170 m /
      impostor / hidden past the fog cutoff); water pre-passes hide both
      kinds past 200 m and restore exact prior state. Impostors don't cast
      or receive shadows (the extended shadow window ends at ±170 m anyway).
      MEASURED (spawn, A/B single renders): east deep-forest sightline
      32.3M → 5.6M tris (5.8x), calls 767 → 535; west wheat view 10.9M →
      7.0M (wheat dominates there). Live loop at spawn: ~28-30 fps → 60 fps
      (16.7 ms incl. water pre-passes). Far-shore treeline across the lake
      (250-350 m, fog off) reads as natural forest in stills; transition
      popping in MOTION is the user's checkpoint.
- [ ] 2–3 hero GLTF assets (scanned-style) near spawn/shores; ez-tree stays
      mid-ground (stays in Part F)
- NOTE (2026-06-11 perf finding): the frame is VERTEX-BOUND on tree geometry
  drawn across 4 passes (main/shadow/refraction/reflection) — impostors are
  the single biggest remaining fps lever, bigger than any resolution tweak.
- DECISION (2026-06-11): impostors PULLED FORWARD — they run right after
  Phase 39 (world tree), before any Part C content. The hero-asset half of
  this phase stays in Part F.

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
| 17 — Western range | done — awaiting user check |
| 18 — Biomes + wheat terrain | done — awaiting user check |
| 19 — Wheat rendering | done — awaiting user check |
| 38 — World compaction 900 m (Part B2) | done — awaiting user check |
| 20 — Natural lake + island (at the new center, after 38) | done — awaiting user check |
| 39 — World tree (Part B2) | done — v11 standard lone oak + weeds (colossus retired) |
| 35a — Far-field impostors (pulled forward) | done — awaiting user check |
| 21 — River + waterfall cliff | REMOVED 2026-06-11 (→ Phase 37, needs water physics) |
| 22 — Waterfall visuals | REMOVED 2026-06-11 (→ Phase 37, needs water physics) |
| 23 — Natural logs | done — awaiting user check |
| 24 — Rock variety | done — awaiting user check |
| 25 — Flower clusters | done — awaiting user check |
| 26 — Butterflies + flies | done — awaiting user check |
| 27 — Birds | done — awaiting user check |
| 28 — Dynamic sun refactor | done — awaiting user check |
| 29 — Sky v2: moon + stars | done — awaiting user check |
| 30 — Day-night transition button | done — awaiting user check |
| 31 — Clouds | done — awaiting user check |
| 32 — Fireflies + dusk crossfade | done — awaiting user check (PART D COMPLETE) |
| 28 — Dynamic sun | planned |
| 29 — Sky v2 (moon/stars) | planned |
| 30 — Day-night button | planned |
| 31 — Clouds | planned |
| 32 — Fireflies | planned |
| 33 — Caustics (refraction shipped 2026-06-11) | planned (reduced) |
| 34 — Planar reflections | DONE 2026-06-11 (shipped early) |
| 35 — Tree quality (impostors PULLED FORWARD: run after 39; hero assets stay Part F) | planned |
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
6. (2026-06-11, v7 revision) Compaction before everything else remaining:
   38 → 20 → 39 → impostors (from 35) → Part C. Shrinking to 900 m first
   means the lake reshape, the world tree, and all Part C scatter happen
   ONCE, on final geography — and impostors run before Part C because
   trees-drawn-in-4-passes is the documented top fps lever (point 5's
   exception, now decided).

---

# v4 — COMBAT ARC (planned 2026-06-11)

FPS weapons on top of the living world: knife, pistol, M16-style rifle.
First-person hands + weapons, fire/reload/slash animations, muzzle flash,
ballistic projectiles that hit trunks/logs/rocks/ground via the existing
Rapier colliders, surface-aware impact FX, water splashes, impulses to
dynamic bodies.

Key decisions (researched 2026-06-11):
- PROCEDURAL viewmodels, not downloaded GLBs. Everything in the scene is
  procedural; free rigged FPS-arm assets are licence-murky and retargeting
  is the most painful path. Primitives + code-driven animation (springs,
  timelines) match the art style and give crisper game feel. The system
  loads through one rig interface, so GLBs can replace meshes later.
- Viewmodel = SEPARATE overlay scene/camera rendered after composer.render()
  with a depth clear. Never clips into world geometry, never touches the
  fragile N8AO/godrays depth path (see D3D11 saga). Muzzle glow is faked
  with additive sprites (bloom does not see the overlay).
- Ballistics = SWEPT RAYCASTS, not dynamic bodies. Point + velocity +
  gravity drop, world.castRayAndGetNormal along each frame segment.
  Exact hits at any speed; tracers/travel time/arc still visible.
  Hits apply real impulses to dynamic bodies (the crate reacts).
- Audio synthesized with WebAudio (noise bursts + filters) — zero assets.

## Phase 40 — Weapon framework + input + HUD
- src/weapons/weapons.js: WeaponSystem orchestrator; defs (interval, mag,
  speed, spread, recoil, impulse); states idle/fire/reload/switch/attack.
- Input: LMB fire (semi=pistol, auto=rifle, melee=knife), R reload,
  1/2/3 + wheel switch. Only while pointer-locked (+_testMode hook).
- physics.js: colliderKinds map (dirt/wood/rock), raycastBullet()
  excluding the player capsule, applyHitImpulse().
- HUD: #ammo readout; controls panel gains weapon rows.

## Phase 41 — Procedural viewmodels
- src/weapons/models.js: stylized arms (forearm+hand) and three weapons
  from primitives; per-weapon grip poses + muzzle anchors.
- src/weapons/viewmodel.js: overlay scene, 55° camera, hemi+dir light.

## Phase 42 — Procedural animation
- Springs + timelines in viewmodel.js: look sway, walk/sprint bob
  (synced to player bobPhase), fire recoil kick, reload dip,
  draw/holster on switch, knife slash arc. Camera pitch kick on fire.

## Phase 43 — Firing + ballistics
- src/weapons/projectiles.js: swept-ray bullets w/ gravity, tracer pool,
  shell casings (manual sim, instanced), water-crossing detection.
- Muzzle flash sprite (viewmodel) + 1-frame PointLight (world, added once).

## Phase 44 — Impacts
- src/weapons/impacts.js: bullet-hole decal pool, particle bursts per
  surface (bark/dirt/rock), water splash ring + spray, impulse transfer.

## Phase 45 — Audio + polish
- src/weapons/audio.js: WebAudio synth — shots, dry click, reload ticks,
  whoosh, surface impacts w/ distance attenuation.
- Spread bloom on auto fire; ADS deferred.

## v4 Status

| Phase | Status |
|-------|--------|
| 40 — Framework + input + HUD | done — awaiting user check |
| 41 — Procedural viewmodels | done — awaiting user check |
| 42 — Procedural animation | done — awaiting user check |
| 43 — Firing + ballistics | done — awaiting user check |
| 44 — Impacts | done — awaiting user check |
| 45 — Audio + polish | done — awaiting user check (ADS deferred) |

---

# v5 — WILDLIFE & FISHING ARC (planned 2026-06-11)

Living creatures from downloaded CC0 models — the project's first external
character assets: deer/rabbits/hedgehogs on land, fish in the lake — plus
GLB weapon viewmodels and a complete fishing system: rod weapon slot,
cast → bobber → nibble → hook → tension fight → catch presentation.

Key decisions (researched 2026-06-11):
- Assets: Quaternius CC0 packs (poly.pizza / quaternius.com) — low-poly
  style matches the procedural world, glTF, public domain, no attribution
  required. Every downloaded file logged in `public/models/LICENSES.md`.
- Hands: Sketchfab FPS-arm assets RULED OUT (login-walled downloads, CC-BY,
  rig retargeting = the pain the v4 decision log predicted). The existing
  procedural mitten arms stay and grip the new GLB weapons/rod. GLB arms
  remain a documented upgrade path.
- Deer: animated GLB clips via AnimationMixer (first skinned asset in the
  project). Rabbits/hedgehogs: static GLBs + procedural motion (hop arc
  with squash/stretch, shuffle) — sells behavior without rig work.
- Fishing minigame: reaction-test hook + tension tug-of-war fight.
  Researched the minigame taxonomy: balance-bar (Stardew) rejected as a
  2D-UI overlay that fights first-person immersion; pure-waiting
  (Minecraft) rejected as boring. Bobber physics rides the existing
  ballistic projectile + getWaveHeight infrastructure.
- Perf: the frame is vertex-bound (Phase 35 finding) — animal/fish budgets
  are small (≤20 total), no shadow casting, mixers throttled by distance,
  everything frozen past the fog cutoff.

## Phase 46 — Asset Pipeline
- [x] Downloaded → `public/models/` via poly.pizza static CDN (the /m/ page
      embeds a `static.poly.pizza/<uuid>.glb` URL — fully scriptable):
      deer + stag (2.1k/3.7k tris, 13 clips each: Idle/Idle_2/Idle_Headlow/
      Eating/Walk/Gallop/…), hedgehog (1.5k, Idle/Attack/Death),
      fish_a/b/c (0.5-0.7k, Swim), fishing_rod (522), pistol (1k),
      rifle (1.3k) — all Quaternius CC0. GOTCHA: Quaternius's "Bunny" is an
      anthropomorphic CHARACTER (8k tris, Punch/Wave clips) — replaced with
      Poly-by-Google Cottontail + Jackrabbit (~1k tris, static, CC-BY 3.0 =
      attribution required)
- [x] `loadGLB` in core/assets.js: promise-cached GLTFLoader (no DRACO —
      poly.pizza GLBs are uncompressed); `scripts/inspect-glb.mjs` for
      offline GLB sniffing
- [x] Smoke-tested in the live page: all 11 load, clips/skinning verified;
      raw sizes are wild (rabbit 7 m tall, fish 8-10 m long, rod 6.3 m) —
      every consumer normalizes scale from its measured bbox
- [x] `public/models/LICENSES.md` with required CC-BY attribution lines

## Phase 47 — Pond Fish
- [x] `src/world/fish.js`: 10 fish (4+3+3 across the three species, lengths
      0.34-0.58 m normalized from bbox), SkeletonUtils-cloned rigs, one
      AnimationMixer each (timeScale rides swim speed); steering: lazy
      sinusoid wander, steer-home past lake-dist 78 or depth < 0.9 m, depth
      band floor+0.3 .. surface-0.35 with slow drift; surface-rise moments
      every 20-70 s spawn a fading ripple ring (4-slot InstancedMesh pool).
      GOTCHA: SkeletonUtils.js exports `clone`, NOT a SkeletonUtils
      namespace — the bad named import killed the whole module graph
      silently (the Phase 17 blank-app signature; found via dynamic
      import of fish.js from the console, which surfaces the real error)
- [x] Verified remotely (hidden-tab rAF freeze worked around by driving
      updateFish manually through the PAGE's module instance — fetch the
      transformed main.js, import fish.js by its exact ?t URL): all 10
      placed in-lake (lakeD 19-71, depth 0.76-3.4 m, floor clearance
      1.3-5.7 m), 3 s sim moved a fish 1.63 m with bones animating and
      everyone still submerged; fish-vs-hidden pixel diff confirms it
      renders; glError 0. In-motion look is the user's checkpoint
- [ ] Culling: mixers skipped beyond ~70 m; fish live on the default layer
      (visible in refraction/reflection pre-passes — they're IN the water)
- [ ] Occasional surface rise: ripple ring reuse from impacts water splash

## Phase 48 — Land Animals
- [x] `src/world/animals.js`: 2 deer + 1 stag (Idle/Eating/Walk/Gallop with
      0.25 s crossfades), 6 rabbits (3 cottontail + 3 jackrabbit, procedural
      parabolic hop w/ squash-stretch + pitch), 2 hedgehogs (Idle clip,
      shuffle, FREEZE when player < 4 m). States idle/graze/walk/flee;
      habitatOk mask (dry, slope < 0.55, wheat < 0.25, off the world-tree
      clearing, h 0.4-13); 16 m-bucket trunk grid for avoidance; expanding
      qualified-spot search for spawn AND wander targets (flower-patch
      lesson applied)
- [x] No shadows; mixers < 90 m; hidden+frozen past 150 m
- [x] **GOTCHA (the big one): `Box3.setFromObject` on a SkinnedMesh measures
      SKINNED vertex positions, which depend on render-time skeleton state —
      at createAnimals time it returned a ~388 m box for the 4.3 m deer, so
      the normalize scaled deer to 17 MILLIMETERS (rendered fine… at
      sub-pixel size; every skinned vert "collapsed" to one point). Fix:
      `measureRestBox` in core/assets.js unions GEOMETRY bounding boxes
      (the raw position attribute IS the bind pose) — deterministic at any
      time. fish.js switched too (it had measured correctly by luck).**
      Debug trail worth remembering: bare-vs-prefixed duplicate clips were
      a red herring; isolated probes contradicted the page because evals
      that import `/node_modules/.vite/deps/three.js` WITHOUT the `?v=hash`
      get a SECOND three instance (extension of the known ?t trap — always
      parse the exact import URL out of the page's transformed main.js)
- [x] Bug fixed during verification: rabbit hop offset ACCUMULATED (+6 m
      altitude) on walk→idle decay frames — ground snap now happens every
      frame before presentation offsets, not only inside tryMove
- [x] Verified remotely: 11 placed (deer 173-264 m from spawn, rabbits
      41-129 m, all grounded to 0.000, lake clear); manually-driven sim:
      deer idle→graze→walk wander 12.4 m w/ matching clips, flee = gallop
      9.3 m directly away + grounded, rabbit wander 34.7 m with hop arc
      capped at design 0.22 m, hedgehog speed 0 near player; deer
      pixel-diff renders post-fix; glError 0. NOTE: a far-away "player"
      position freezes everyone by design — remote sims must pass a watcher
      within 150 m. Walk-up encounters (flee feel, clip blending) are the
      user's checkpoint

## Phase 49 — Weapon GLB Swap
- [x] `swapInGLB` in models.js: builders stay synchronous (primitive bodies
      render as placeholders; the GLB — wrapped in a Group named
      'weaponGLB' — replaces them when loaded; failed fetch keeps the
      placeholder). Pack guns are modeled along +X → yawFix PI/2 puts the
      muzzle at -Z; fitted by rest bbox (pistol 0.21 m rear z 0.045,
      rifle 0.95 m rear z 0.33); muzzle anchor re-derived from the fitted
      bbox front. Arms/knife stay procedural per the v5 decision
- [x] Verified through the REAL render path (`_testMode` + pumped
      `weapons.update`, then `vm.render` + default-framebuffer readPixels):
      rifle 15.2k lit samples / pistol 1.7k / 0 when hidden, glError 0,
      ASCII framing shows the classic lower-right hip pose with the barrel
      toward screen center; rifle side-probe confirms thin-end (muzzle)
      at -Z. In-hand feel/recoil look is the user's checkpoint
- NOTE (debug lesson, ~1 h spent): forensic probes that render a
      never-yet-rendered geometry in hand-rolled temp scenes can produce
      FALSE invisibility (stale GL buffer/VAO state from manual RT
      renders) — symptoms vanish once the geometry re-uploads. Verify
      through the real pipeline FIRST (the deer/Box3 bug was real; this
      one wasn't). Smooth-vs-flat / override-material / clone-geometry
      bisection is still the right toolkit — just run it AFTER the
      real-path check, not before

## Phase 50 — Fishing Rod + Cast (DONE — built with 51/52 as one module)
- [x] Slot 4 `ROD` (`rod: true` def — input bypasses tryFire into
      FishingSystem press/release); Digit4 + wheel; switching away stows
      the line (fishing.cancel); HUD ammo row shows "hold LMB to cast";
      reload no-ops on the rod (NaN guard)
- [x] Rod rig (buildRod in models.js): Quaternius rod GLB via swapInGLB
      with preRot (-90° X — the rod is modeled along +Y, unlike the +X
      guns); the rig's `muzzle` anchor IS the rod tip, so the line starts
      at getMuzzleWorld exactly like tracers leave barrels. Viewmodel
      gained an `extraPose` layer (per-frame external pose: charge tilt,
      cast flick, fight shake) — no new timeline plumbing
- [x] Cast: hold-to-charge (1.3 s, smoothstepped 7→21 m/s), bobber =
      manual ballistic (shell pattern); water landing via
      physics.getWaterLevel (includes live Gerstner height — the bobber
      rides the SAME waves as the shader); dirt landing auto-reels.
      Red/white procedural bobber; line = 24-pt bezier polyline with
      state-dependent sag (taut fighting / droop floating)

## Phase 51 — Bite + Fight Minigame (DONE)
- [x] Floating: nibble fakeouts (0.05 m dip + plip) on a 1-3.4 s cadence;
      real bite after 3-10 s (0.16 m plunge + bloop + splash ring); hook
      window 0.85 s — early press = empty retrieve, late = fish loses
      interest and the wait restarts
- [x] Fight: weighted species roll (PERCH 45% / RUDD 35% / PIKE 20%) ×
      size roll (sq-rand — small fish common), fightK scales the run
      bursts (0.7-1.8 s, random strength/lateral direction). Hold = reel
      4.2 m/s + tension rises; release = tension falls + fish takes line;
      tension ≥ 1 SNAPS the line (twang + "LINE SNAPPED" card), slack
      > 3.2 s slips the hook ("IT GOT AWAY"); reel ratchet ticks while
      cranking; bobber drags under (tension-scaled), thrash splashes
- [x] HUD: #tension bar (green→amber→red fill), hidden outside fights

## Phase 52 — Catch Presentation (DONE)
- [x] lineLen ≤ 2.3 m → catch: splash, fish prop (species GLB clone,
      scaled to the rolled cm via measureRestBox) arcs from the water to
      0.95 m in front of the camera (parabolic apex +1.7 m, spinning),
      then dangles wiggling for 1.7 s; line follows the FISH during
      presentation; catch jingle + "CAUGHT — PERCH · 26 cm" card; tally in
      the controls panel ("fish caught N" row appears after the first)
- [x] All three endings verified by manually-pumped sim through the REAL
      WeaponSystem.update path: catch (+1 tally), snap (hold-forever),
      slip (no-hold) + full reel-back to idle; tension bar hides after;
      rod viewmodel ASCII = thin diagonal blank toward screen center;
      bobber+line pixel-diff confirms world rendering; glError 0.
      GOTCHA for future sims: _catch() is async (awaits the cached GLB
      promise) — synchronous frame-pump loops never flush microtasks, so
      the presentation appears stuck unless the pump yields (setTimeout 0
      every ~20 frames). Cast/fight FEEL (charge curve, fight pacing) is
      the user's checkpoint

## Phase 53 — Audio + Polish (DONE)
- [x] WebAudio synths in weapons/audio.js (noiseBurst/thump toolkit):
      playPlip (nibble), playBite (deep bloop + splash), playReelTick
      (ratchet, repeated while cranking), playLineSnap (sawtooth twang),
      playCatchJingle (two-note triangle E5→A5); splash/whoosh reused from
      the combat arc. All distance-attenuated where it matters
- [x] Perf gate MEASURED (everything active, watcher in range): fish
      0.052 ms + animals 0.074 ms + fishing 0.0002 ms = 0.127 ms/frame
      worst-case CPU — ~13% of the 1 ms target. Tuning dials: SPECIES
      counts (fish.js), animal counts (createAnimals), MIXER_DIST/
      HIDE_DIST in both
- [x] README: fishing how-to, wildlife/weapons sections, asset credits
      incl. the REQUIRED Poly-by-Google CC-BY attribution; LICENSES.md
      complete; final boot clean (10 fish, 11 animals, 4 rigs, no
      console/GL errors)

**Population 5x (2026-06-11, user request "add more life / easily find
them"):** animals 11 → 54 (deer 10 + stags 4, rabbits 30, hedgehogs 10),
flower patches 78 → 390 (PATCHES_NEAR_SPAWN 4 → 8); butterflies ride the
patch count automatically (~1,200), flies bumped via FLIES_PER_ANCHOR
7 → 12 + anchor fractions. FINDABILITY: the first 3 deer and 3 hedgehogs
get a guaranteed close ring (40-130 m / 25-100 m, wide fallback — random
rings alone rolled the nearest deer at 138 m). Verified: nearest deer
46 m / rabbit 26 m / hedgehog 35 m from spawn; 54 animals worst-case CPU
0.46 ms/frame (far ones still freeze); no errors.

**CRASH FIX (2026-06-11, user report "game stuck after some time"):**
`updateGrounded` walk case — `tryMove` NULLS `a.target` when the step is
blocked at a habitat edge, and the arrival check right after read
`a.target.x` → uncaught TypeError killed the rAF loop. Surfaced quickly at
5x population (more walkers hitting more edges). Re-check target after
tryMove. Verified: 10 simulated minutes / 36k frames cycling watchers
across all 54 animals (everyone wanders into edges) — zero exceptions,
healthy state mix, no walk-state animal left with a null target.

## v5 Status

| Phase | Status |
|-------|--------|
| 46 — Asset pipeline | done — awaiting user check |
| 47 — Pond fish | done — awaiting user check |
| 48 — Land animals | done — awaiting user check |
| 49 — Weapon GLB swap | done — awaiting user check |
| 50 — Rod + cast | done — awaiting user check |
| 51 — Bite + fight | done — awaiting user check |
| 52 — Catch presentation | done — awaiting user check |
| 53 — Audio + polish | done — awaiting user check (ARC COMPLETE) |
