# Voxelcraft — Minecraft Clone

A browser-based Minecraft clone built on the repo's existing stack (Three.js +
Rapier + Vite). Lives under `src/minecraft/` with its own `minecraft.html`
entry, isolated from the forest (`src/main.js`), highlands, packbrawl, and
spike subprojects. No forest modules are imported — the voxel engine is
architecturally incompatible with the heightmap world.

**Scope (locked):** full 384-height Overworld · ~80 blocks · Creative + Survival
+ Crafting/Inventory · day/night + hostile mobs · classic Minecraft look
(solid-color sky, flat-shaded blue water, pixel-art block textures).

**Workflow rule:** every phase ends with a browser-verified CHECKPOINT. The
next phase does not start until the user says "approved". Same rule as every
other arc in this repo.

---

## Architecture decisions (locked up front)

| Decision | Choice | Why |
|---|---|---|
| World storage | 16×16×16 **sub-chunks** w/ **palette + bit-packed indices**; 24 sub-chunks per column (384 tall, Y=−64..320) | Matches real MC; palette keeps a render-distance-8 world at ~8 MB vs ~27 MB raw |
| Meshing | **Greedy meshing** per sub-chunk + baked **per-vertex ambient occlusion** | 5–50× fewer verts than naive face-culling; AO gives the classic MC depth read for free |
| Textures | **Procedural pixel-art atlas** generated to a canvas at load (16×16 per tile) | Classic MC look, zero asset licensing, swappable for a real texture pack later |
| Player collision | **Custom swept-AABB vs voxel grid** (Amanatides-style), NOT Rapier trimeshes | Deterministic, cheap, editable per-block without collider rebuilds. Rapier reserved for dynamic mobs/items |
| Block targeting | **DDA voxel raycast** (Amanatides & Woo) → targeted block + adjacent face | Standard, exact, ~O(distance) |
| Lighting | v1: per-vertex AO + height-based sky light. v2: flood-fill block light for torches | Full flood-fill is expensive; AO alone already looks right; torch light deferred to when survival needs it |
| Render distance | **8 chunks** default (configurable 4–12) | ~8 MB voxel data, fits browser budget with headroom for meshes |
| Chunk gen | **Web Worker** per column (noise → palette) off the main thread | Keeps frame rate stable while flying/teleporting |
| Save | **IndexedDB** per chunk column | Survives reload; async; generous size limit |
| UI | HTML/CSS overlay (consistent with the repo's hud.js pattern) | Cheap, no IMGUI dep |

---

## Block set (v1, ~80) — grouped

- **Terrain (topsoil & dirt):** Grass Block, Dirt, Coarse Dirt, Podzol, Sand,
  Red Sand, Gravel, Clay, Snow Block, Snow Layer, Ice, Packed Ice, Moss Block,
  Mycelium
- **Stone variants:** Stone, Cobblestone, Smooth Stone, Granite, Diorite,
  Andesite, Deepslate, Cobbled Deepslate, Tuff, Sandstone, Red Sandstone,
  Terracotta, Bedrock, Calcite, Dripstone Block
- **Ores (8 + deepslate variants):** Coal, Iron, Copper, Gold, Redstone, Lapis,
  Diamond, Emerald
- **Woods (6 types × log/planks/leaves):** Oak, Spruce, Birch, Jungle, Acacia,
  Dark Oak (+ Cherry/Mangrove stretch)
- **Plants:** Grass, Tall Grass, Fern, Dandelion, Poppy, Sunflower, Cactus,
  Sugar Cane, Wheat, Vines, Lily Pad, Mushroom (red/brown), Sapling
- **Fluids:** Water, Lava
- **Crafted/Building:** Glass, Glass Pane, Torch, Crafting Table, Furnace,
  Chest, Bookshelf, Ladder, White Wool, Carpet, Glowstone, Jack o'Lantern,
  Hay Bale, Stone Bricks, Cobblestone Wall, Slab & Stairs (oak/stone), Bricks,
  Iron/Gold/Diamond Block, Obsidian, Bed

---

## Reference data (locked facts, sourced from minecraft.wiki)

### Ore distribution by Y (Java 1.18+)
| Ore | Y range | Peak Y | Min pickaxe |
|---|---|---|---|
| Coal | 0 to 320 | 45 | Wood |
| Copper | −16 to 112 | 43 | Stone |
| Lapis | −64 to 64 | −2 | Stone |
| Iron | −64 to 72 (band 80–320 peak ~85) | 14 | Stone |
| Gold | −64 to 32 (Badlands 32–79) | −18 | Iron |
| Redstone | −64 to 16 | −59 | Iron |
| Diamond | −64 to 16 | −59 | Iron |
| Emerald | −16 to 320 | 85 | Iron |

Deepslate ore variants below Y=8. Pickaxe tiers: Wood < Stone < Iron < Diamond < Netherite.

### Daylight cycle
Full day = 24,000 ticks = **20 real minutes** (72× real time).
- Daytime 0–12,000 ticks (06:00–18:00) = 10 min, sky light 15
- Dusk 12,000–13,000 = 50 s
- Night 13,000–23,000 = 8 min 20 s, sky light falls to 4
- Dawn 23,000–24,000 = 50 s
Hostile mobs spawn outdoors while sky light < 7 (~ticks 12,969–22,812 clear,
12,858 rainy). Undead (zombie, skeleton) burn in direct sunlight.

### Mob spawning
- Generic hostile rule: **light level ≤ 7**, solid opaque top surface, ≥2 air
  above, within 128-block sphere of player; despawn >128 blocks
- Mob caps (Java): monster 70, creature 10, ambient 15
- Passive mobs spawn on chunk gen on grass blocks in daylight, light ≥ 9
- Hostile: zombie (burns), skeleton (ranged, burns), creeper (explodes, no
  burn), spider (climbs, neutral by day), enderman (teleports), witch (swamps),
  husk (deserts, no burn), stray (snowy, replaces skeleton), slime (slime
  chunks Y<40 regardless of light)
- Passive: sheep, cow, pig, chicken, horse, wolf, fox, rabbit, bat

### Crafting
- 2×2 grid in inventory; 3×3 grid via Crafting Table
- Recipe types: shaped (mirrorable horizontally), shapeless, fixed
- Essential recipes (~25): planks, sticks, crafting table, chest, furnace,
  torch, pickaxe/axe/sword/shovel/hoe × wood/stone/iron/diamond, bow, arrow,
  bucket, flint-and-steel, bread, ladder, fence, bed, glass (smelt), bricks

### Inventory slots
- 9 hotbar (1–9 / wheel), 27 main inventory (3×9), 4 armor, 1 off-hand
- Stack to 64 (most), 16 (projectiles, ender pearls), 1 (tools/armor)

### Chunk & storage facts
- Chunk column = 16×16×384 = 98,304 blocks
- Sub-chunk = 16³ = 4,096 blocks; 24 sub-chunks per column
- Raw Uint8Array column = 96 KB; palette-packed ~30 KB typical, ~10–20 KB
  best case (homogeneous air/stone)
- Index formula: `(y<<8) | (z<<4) | x` within a sub-chunk

---

## ARC 1 — Voxel Engine Core

### Phase 0 — Scaffold

**Goal:** empty but running voxel project, isolated from the forest.

- [x] New `src/minecraft/` folder with subfolders `engine/`, `world/`,
      `player/`, `ui/`, `assets/`
- [x] `minecraft.html` at repo root (matches the `highlands.html` /
      `packbrawl.html` pattern) loading `/src/minecraft/main.js`
- [x] `main.js` boots Three.js renderer (ACES filmic, no shadows for v1 — AO
      carries depth), PointerLockControls, fps HUD (F3 toggle), "click to play"
      prompt
- [x] Empty colored void (sky-blue clear color) + crosshair + fps counter

**CHECKPOINT 0:** open `minecraft.html`, see a sky-blue screen with a crosshair
and fps counter; click to lock the mouse; no console errors.
Verified remotely: `minecraft.html` → 200 (2680 B), `main.js` → 200 (22938 B,
transformed, zero error tokens), forest root `/` → 200 (unchanged). Three.js +
PointerLockControls imports resolve; `renderer.info.reset()` present for honest
F3 HUD. User to confirm live: click-to-lock + fps counter visible.

---

### Phase 1 — Block & Chunk Data Model

**Goal:** the in-memory world, before any rendering.

- [x] `engine/blocks.js`: `BlockType` registry — id → { name, textures[6],
      transparent, solid, liquid, light, hardness, tool, drops }. 21 block
      types registered (air, stone, grass, dirt, cobblestone, sand, water,
      wood log, leaves, glass, bedrock, sandstone, snow, ice, planks, ores,
      gravel, clay). Append-only registry; `isTransparent`/`isSolid` helpers.
- [x] `engine/chunk.js`: `SubChunk` = palette array + bit-packed
      `Uint32Array` indices; index = `(y<<8)|(z<<4)|x`; auto-resize palette
      when a new block type appears; single-value collapse (bits=0, empty
      data) for homogeneous sub-chunks
- [x] `engine/world.js`: `World` = `Map<"cx,cz", ChunkColumn>` where each
      column holds 24 SubChunks; `getBlock(x,y,z)` / `setBlock(x,y,z,id)` with
      cross-chunk neighbor reads (returns air for unloaded chunks). Constants:
      CHUNK_SIZE=16, Y range −64..319 (384 tall), SEA_LEVEL=62
- [x] `world/debugWorld.js`: spawns a 3×3 platform of chunk columns with
      bedrock floor, stone body, dirt sub-surface, grass top (SURFACE_Y=70)
- [x] Debug handles: `window.__world`, `window.__BLOCK`; console probe logs
      surface/dirt/bedrock/above-surface block names on boot

**CHECKPOINT 1:** in the browser console, `__world.getBlock(0,70,0)` returns
grass, `__world.setBlock(0,70,0,STONE)` then re-reads as stone; no errors.
Verified headless: 16/16 palette/resize/cross-chunk/overwrite tests pass via
node. All modules serve 200 from the dev server. User to confirm live: open
`minecraft.html`, check the console log for the spawn summary + probe line,
then run `__world.getBlock(0,70,0)` (expect `2` = GRASS) and
`__world.setBlock(0,70,0, __BLOCK.STONE); __world.getBlock(0,70,0)` (expect `1`).

---

### Phase 2 — Chunk Meshing + Texture Atlas

**Goal:** voxel data becomes visible geometry.

- [x] `assets/atlas.js`: procedural pixel-art atlas generator — draws 16×16
      tiles to a 256×256 canvas → `THREE.CanvasTexture` (NearestFilter for
      crisp pixels). 24 unique tiles for the v1 block set (grass top/side,
      dirt, stone, cobblestone, sand, water, wood log top/side, leaves, glass,
      bedrock, sandstone top/bottom/side, snow, ice, planks, 4 ores, gravel,
      clay). Per-tile draw functions with seeded noise + spot patterns. UV
      lookup map with half-pixel inset to prevent bleeding.
- [x] `engine/mesher.js`: greedy mesher per sub-chunk — 3 axes × 2 directions
      sweep, 2D mask of visible faces, merge coplanar runs of same block type
      into rectangles; emits positions, normals, UVs (atlas-mapped), and AO
      vertex colors. AO computed per quad corner from the 3 outside-neighbors
      (vertexAO formula); brightness levels 0.4/0.65/0.85/1.0.
- [x] Separate transparent pass (water/leaves/glass) — rendered after opaque,
      double-sided, depthWrite off, opacity 0.85; same-type transparent blocks
      don't draw internal faces against each other.
- [x] `world/chunkmesh.js`: builds `THREE.BufferGeometry` from mesher output,
      attaches atlas material (MeshLambert + vertexColors), one mesh per
      non-empty sub-chunk pass; frustum-culled.
- [x] `main.js` wired: builds atlas, creates opaque + transparent materials,
      adds sun + ambient + hemisphere light, meshes all loaded columns on boot,
      logs mesh/triangle counts. Camera repositioned to (2, 80, 2) above the
      grass surface.

**CHECKPOINT 2:** a stone column with a grass top renders; AO darkening
visible in corners; one draw call per sub-chunk; F3 shows reasonable tri count.
Verified headless: 9/9 mesher tests pass (single block 6 faces, internal-face
culling, greedy merge of coplanar quads, all-solid 0 faces, AO/UV/index
validity, world-bounds positions). All modules serve 200 from dev server.
User to confirm live: open `minecraft.html`, see a grass-topped stone platform
(3×3 chunks = 48×48 blocks) with pixel-art textures and AO shading in the
edges; F3 shows ~meshes/tris.

---

### Phase 3 — Chunk Streaming

**Goal:** the world is bigger than the loaded area.

- [x] `engine/streamer.js`: `Streamer` class — player-following chunk loader.
      Maintains a circular ring of loaded columns within `renderDistance`
      (default 8) around the camera's chunk; unloads columns beyond
      `unloadDistance` (R+2 hysteresis). Each frame: (1) unload far columns
      (dispose geometry + evict from world), (2) generate missing columns
      nearest-first (spiral), (3) re-mesh dirty columns nearest-first. Per-
      frame limits (`maxLoadsPerFrame`, `maxMeshesPerFrame`) prevent stalls.
      `meshCount()` for HUD; `remeshAll()` for debug.
- [x] `world/generator.js`: per-column generator replacing the fixed
      `debugWorld.js`. Uses `SubChunk.fill()` for homogeneous sub-chunks (1–7
      all stone, 9–23 all air → near-zero cost), per-block writes only for the
      bedrock floor + surface sub-chunk. 25 columns = ~40 KB voxel memory.
      Interface `generateColumn(world, cx, cz)` is stable — Phase 6 swaps the
      body for terrain noise, the streamer call site doesn't change.
- [x] `player/flyControls.js`: minimal fly controller (WASD + mouse look +
      Space/C vertical, Shift sprint, accel/damping). No collision — Phase 4
      replaces with the full player controller (swept-AABB, walk + fly, gravity,
      jump). Active only while pointer locked.
- [x] `engine/chunk.js`: added `SubChunk.fill(id)` for efficient bulk fills
- [x] `world/chunkmesh.js`: added `computeBoundingSphere()` for frustum culling
- [x] `main.js` rewritten: uses `World` + `Streamer` instead of fixed
      `spawnDebugWorld`; fly controller for movement; render loop calls
      `streamer.update(camera.x, camera.z)` each frame; `[` `]` keys adjust
      render distance; HUD shows chunk coords + render distance + mesh count

**CHECKPOINT 3:** walk/fly in a straight line; chunks stream in ahead and
unload behind; no stalls >100 ms; F3 stays in target fps range.
Verified headless: 18/18 generator tests pass (structure, negative coords,
regen no-op, homogeneous sub-chunk memory, 5×5 batch, byte budget). All
modules serve 200. User to confirm live: open `minecraft.html`, click to lock,
fly with WASD+Space; watch chunks stream in ahead and unload behind (F3 shows
column/mesh counts changing); `[` `]` adjust render distance.

---

### Phase 4 — Player Controller + Voxel Collision

**Goal:** it feels like a game before it has content.

- [x] `engine/collision.js`: swept-AABB collision with substepping (≤0.4
      blocks per sub-step) to prevent tunneling at high speed / low fps.
      `collidesAt(world, x, y, z)` checks player AABB (0.6×1.8×0.6) against
      the voxel grid. `moveAndCollide(world, pos, delta)` resolves X, Y, Z
      independently (slide along walls), snaps flush to block faces after
      collision (no gaps), returns `{ hitX, hitY, hitZ, onGround }`.
- [x] `player/playerController.js`: full player controller replacing the
      Phase 3 fly controller. Two modes:
      - **WALK** (default): gravity (24 m/s²), jump (8.4 m/s → ~1.25 block),
        swept-AABB collision, sprint (Shift), accel/damping for weight
      - **FLY** (toggle `F`): no gravity, no collision, full 6DOF, sprint
      - Eye height 1.62 m; `spawnAt(x,y,z)` snaps to ground; respawn if fall
        below Y=−70; mode badge HUD updates
- [x] `main.js` updated: imports `PlayerController`, pre-generates spawn
      column, calls `player.spawnAt(2, SURFACE_Y+5, 2)`, render loop calls
      `player.update(dt)`; HUD shows mode + onGround state

**CHECKPOINT 4:** walk over hills, jump 1 block, can't walk through walls;
fly mode works; no clipping; movement has weight (accel/damping).
Verified headless: 13/13 collision tests pass (surface/ground/air detection,
wall stop flush at 4.70, fall lands at 71.01, 1-block step blocks, diagonal
slide along wall, jump clearance). All modules serve 200. User to confirm
live: open `minecraft.html`, click to enter — you should fall onto the grass
surface, walk with WASD, jump with Space, toggle fly with `F`.

---

### Phase 5 — Block Interaction

**Goal:** the core Minecraft verb — mine and place.

- [x] `engine/raycast.js`: DDA voxel raycast (Amanatides & Woo) from camera
      along look direction, max 6 blocks. Returns `{ x, y, z, nx, ny, nz }`
      (hit block coords + face normal for placement) or null. Handles
      negative directions, diagonal rays, ray-starting-inside-block.
- [x] `ui/highlight.js`:
      - `BlockHighlight`: wireframe `LineSegments` (EdgesGeometry of a 1.002
        cube) that snaps to the targeted block each frame; hidden when no
        target; semi-transparent black, depth-tested.
      - `Hotbar`: 9-slot bottom-center bar (creative block palette: grass,
        dirt, stone, cobblestone, planks, wood log, leaves, sand, glass).
        Number keys 1–9 select; mouse wheel cycles; selected slot
        highlighted. `selectedBlock` getter exposes the active block id.
- [x] `main.js` wired: per-frame raycast from camera → `currentTarget`;
      highlight follows target; LMB = break (instant, creative), RMB = place
      (selected hotbar block against the hit face, with player-overlap
      rejection so you can't trap yourself). `markDirty(x, z)` flags the
      affected column + border neighbors (no full remesh — the streamer's
      per-frame mesh queue picks it up). Context menu suppressed on right-
      click. HUD shows target coords + selected block id.

**CHECKPOINT 5:** break and place blocks; highlight follows the cursor;
can't place inside self; placed blocks immediately re-mesh their sub-chunk.
Verified headless: 10/10 raycast tests pass (down-ray hits grass +Y normal,
horizontal air-ray misses, wall hits with -X face normal, -Z ray with +Z
normal, maxDist respected, diagonal ray, ray-from-inside-block). All modules
serve 200. User to confirm live: open `minecraft.html`, click to enter,
look at a block (black wireframe appears), LMB to break it, RMB to place
the selected hotbar block; 1–9 / wheel to switch blocks.

**CHECKPOINT ARC 1:** a fully walkable, editable voxel world. This is the
"it's a game" moment — the engine works.

---

## ARC 2 — World Generation

### Phase 6 — Terrain Noise + Biome Map

**Goal:** varied, believable terrain instead of a flat plain.

- [x] `engine/noise.js`: `Noise2D` + `Noise3D` — hashed value-gradient noise
      with fractal (octave) summation. Seeded permutation table (mulberry32
      PRNG) for reproducible worlds. 2D for terrain/biomes, 3D reserved for
      Phase 8 caves.
- [x] `world/biomes.js`: `BiomeMap` with 4 noise channels (temperature,
      humidity, continentalness, mountain). 11 biomes: Ocean, Beach, Plains,
      Forest, Desert, Mountains, Snowy, Taiga, Jungle, Savanna, Swamp.
      `getBiome(x,z)` + `getBaseHeight(x,z)` drive generation. Tuned:
      ocean < 0.30, beach < 0.36, mountains via separate mask > 0.58.
      Height range: 39 (ocean floor) to 105+ (mountain peaks), sea level 62.
- [x] `world/generator.js` rewritten: per-column terrain generation using
      biome map. Bulk-fills all sub-chunks to stone (fast path), then
      overwrites the top portion with biome-specific top/sub blocks (grass,
      sand, snow, dirt), water up to sea level in oceans/beaches/swamps, air
      above. Bedrock floor (random pattern, bottom 5 layers). Snow layer on
      snowy biomes.
- [x] `main.js` updated: searches outward from origin for a land (non-ocean)
      spawn point; pre-generates the spawn column; logs spawn biome.

**CHECKPOINT 6:** fly around; biomes vary, oceans and hills appear, no
flat-everywhere, no Swiss-cheese terrain.
Verified headless: 11/12 tests pass (terrain varies 39..105, ocean below sea
level, mountains above 80, biome diversity, column structure, bedrock floor,
stone underground, air/water above surface, ocean water at sea level,
determinism, neighbor generation; the one "spawn is land" failure is fixed
by the spawn-search in main.js). All modules serve 200. User to confirm live:
open `minecraft.html`, fly around — see oceans, beaches, plains, forests,
mountains, snowy/taiga/desert/jungle/savanna/swamp biomes with correct
surface blocks.

---

### Phase 7 — Surface Rules + Bedrock

**Goal:** the top block reads as the right biome; bedrock is deterministic.

- [x] `world/surface.js`: `surfaceRules(biome, height, isShoreline)` — returns
      `{ top, sub, subDepth, transition?, transDepth? }` per biome context.
      Rules:
      - Desert: deep sand (4) + sandstone transition (3)
      - Snowy: snow top + dirt sub (3)
      - Mountains above Y=80: stone top (rock breaks through)
      - Mountains below 80: grass + thin dirt (2)
      - Swamp: dirt top + dirt (4)
      - Plains/forest near shore: auto-beach (sand) when shoreline-adjacent
      - Ocean: sand floor (4)
- [x] `isBedrock(x, y, z)` — deterministic position-hash bedrock pattern.
      Bottom layer (Y=−64) always solid; 4 layers above with decreasing
      probability (75%, 50%, 25%, 5%). No bedrock above Y=−60. Fixes the
      Phase 6 `Math.random()` bug that made chunks non-reproducible.
- [x] `world/generator.js` rewritten to use surface rules + deterministic
      bedrock. Added `isOceanAdjacent()` for auto-beach detection. Gravel
      patches (10% chance) on deep ocean floors. Snow layer on snowy biomes.
- [x] Bug fix: Phase 6 used `Math.random()` for bedrock — chunk regeneration
      produced different patterns. Now uses a position hash.

**CHECKPOINT 7:** cross-section shows correct layering; beaches ring oceans;
snowy biomes are white; deserts have sandstone under sand; mountains show
stone at peaks.
Verified headless: 18/18 tests pass (bedrock determinism + always-solid at
Y=−64 + none above −60, desert sand+sandstone, snowy snow+dirt, mountain
stone above 80 + grass below, auto-beach on plains shorelines, land surface
correct, ocean water at sea level, full column determinism across regen).
All modules serve 200. User to confirm live.

---

### Phase 8 — Caves

**Goal:** the underworld is real.

- [x] 3D noise caves (cheese + spaghetti style): where cave noise > threshold,
      carve to air
- [ ] Ravines (tunnel carvers along a noise-driven path) — deferred
- [x] Lava pools below Y=−55 (replace air with lava)
- [ ] Aquifers (water in caves below sea level, optional for v1) — deferred

**CHECKPOINT 8:** caves are explorable, connected, not Swiss-cheese
everywhere; lava at depth; ravines exist.
Verified headless: 7/7 cave tests pass (cheese carve, spaghetti carve, lava at
Y<−55, no carve above Y=120, no carve of non-stone, no carve below bedrock,
determinism). Fixed a latent Phase 8 bug as part of Phase 9: `BLOCK.LAVA` was
referenced in caves.js but never registered in blocks.js — now registered as
block id 21 (liquid, light 15, transparent, non-solid). All modules serve 200.

---

### Phase 9 — Ores

**Goal:** reason to dig.

- [x] `world/ores.js`: ore distribution by Y per the table above; triangular
      density (peak at `peak` Y, tapers to 0 at yMin/yMax edges); deepslate
      variants below Y=8
- [x] Ore blocks placed during chunk gen (after caves, before compaction)
- [x] Coal near surface, iron mid, diamond deep, emerald in mountain biomes
- [x] STONE → DEEPSLATE conversion below Y=8 (fast-path bulk fill for uniform
      sub-chunks; per-cell for mixed sub-chunks crossing the Y=8 boundary)
- [x] 15 new blocks: LAVA, DEEPSLATE, COBBLED_DEEPSLATE, 4 new ores
      (copper/redstone/lapis/emerald), 8 deepslate ore variants
- [x] 17 new atlas tiles (lava, deepslate, cobbled_deepslate, 4 normal ores,
      8 deepslate ores) — deepslate ores use a darker base + same spot color

**CHECKPOINT 9:** dig down; coal near surface, diamond deep, deepslate ores
below Y=8; emerald only in mountains.
Verified headless: 24/24 tests pass (block registry, ore presence for all 8
types, rarity ordering coal>iron>diamond, deepslate layer below Y=8 with no
raw stone, deepslate ore variants only below Y=8, diamond Y range −64..16,
emerald biome restriction to mountains, lava placement, determinism). A
targeted mountains-column probe confirmed emerald generates (1 ore in a
mountains column at −6,2). All modules serve 200 with no transform errors.
Sample 7×7 census: coal=1222 iron=1380 copper=438 lapis=962 gold=174
redstone=1058 diamond=73.

---

### Phase 10 — Features (trees, plants)

**Goal:** the world is alive.

- [x] `world/features/trees.js`: tree features per biome — oak (forest/
      plains), birch (forest), spruce (taiga/snowy, conical), jungle (tall),
      acacia (savanna, flat canopy), cactus (desert). Cherry deferred (no
      cherry grove biome yet).
- [x] `world/features/plants.js`: tall grass, fern, dandelion, poppy, dead
      bush — placed per biome rules. Mushrooms/sugar cane/lily pads/saplings
      deferred to a later phase (need more block shapes / water interaction).
- [x] Features placed in deterministic order (position-hash RNG, reproducible)
- [x] Cross-plant meshing: new `shape: 'cross'` block property; mesher emits
      2 diagonal quads per cross block (X model, double-sided, transparent).
      `faceVisible` updated to skip cross blocks (no cube faces).
- [x] 14 new blocks: 5 wood log types + 5 leaf types + cactus + 5 cross plants
- [x] 19 new atlas tiles (wood top/side variants, leaf variants, cactus
      top/side, 5 plant sprites with transparent backgrounds)

**CHECKPOINT 10:** forests have trees, deserts have cacti, jungles dense &
tall; flowers in plains; lily pads on water.
Verified headless: 18/18 tests pass (block registry, feature presence, tree
trunk+canopy structure, cross plants on valid surface, cactus desert-only,
no underwater trees, determinism). Census across 9 land biome sites:
logs=1914 leaves=14586 cross_plants=3158. Targeted desert probe confirmed
cactus generates (197 cacti in a 5×5 desert area at −335,−429). All modules
serve 200 with no transform errors. (Lily pads/mushrooms/sugar cane deferred
— they need water-interaction or additional block shapes beyond v1 cross
plants.)

---

### Phase 11 — Structures (light)

**Goal:** occasional landmarks.

- [x] `world/structures/village.js`: village skeletons — 1-3 simple houses
      per village chunk (5×5 footprint, planks/cobble walls, wood-log corner
      posts, peaked stepped roof, glass windows, 1×2 door gap). Placed in
      Plains/Forest/Savanna on flat terrain (height variance ≤ 2). ~2% of
      land chunks.
- [x] `world/structures/dungeon.js`: small 5×5×4 underground rooms made of
      mossy cobblestone or stone bricks, hollow interior, 1×2 doorway. Placed
      in solid stone at Y -20..30. ~1.5% of chunks. Mob spawner + chest
      deferred to survival phases.
- [x] 2 new blocks: STONE_BRICKS, MOSSY_COBBLESTONE (+ atlas tiles)

**CHECKPOINT 11:** occasional structures break up the landscape; not too
dense.
Verified headless: 13/13 tests pass (block registry, structure presence,
village house found with glass+planks+wood-log corners, dungeon found
underground with air interior, dungeons not on surface, village chunks have
valid center biome, determinism). Census across 6561 chunks: planks=10007
glass=253 stone_bricks=1680 mossy=2560. All modules serve 200.

**CHECKPOINT ARC 2:** a believable, varied Overworld you can mine and
explore. Caves, ores, biomes, trees, structures.

---

## ARC 3 — Survival & Gameplay

### Phase 12 — Day/Night Cycle + Sky

**Goal:** time passes.

- [x] `world/sky.js`: 20-min day (24,000 ticks at 20 tps); sun rises east
      (+X) at tick 0 (06:00), arcs to zenith at tick 6000 (noon), sets west
      (-X) at tick 12000 (18:00). Moon follows opposite arc. Sky color
      keyframe-interpolated (day blue → dusk orange → dusk purple → night
      dark blue → dawn). Stars (800-point field) fade in at night.
- [x] Sun directional light follows the arc; intensity scales with sun
      height. Ambient + hemisphere lights darken at night.
- [x] Visible sun/moon meshes (unlit spheres) follow camera at distance 500.
- [x] Clock in F3 HUD (HH:MM + phase name). Debug time scrub: `,` `.` =
      ±500 ticks, `P` = pause. Starts at tick 2000 (07:00) so first session
      isn't dark.

**CHECKPOINT 12:** watch a full cycle; sun rises east, sets west; night is
dark; sky color transitions smoothly.
Verified headless: 27/27 tests pass (clock conversion, phase labels, daylight
factor at noon/midnight/dawn/dusk, sky color at noon=blue/night=dark/dusk=
orange, color interpolation smoothness, time advance + wraparound, pause,
scrub wraparound). All modules serve 200.

---

### Phase 13 — Lighting (block light flood-fill)

**Goal:** torches light caves; sunlight reaches through overhangs.

- [x] Sky light: height-based — blocks above highest opaque = 15, decreasing
      into overhangs (skylight propagates straight down, blocked by opaque).
      No horizontal BFS for v1 (overhangs are dark; deferred to polish).
- [x] Block light: BFS flood-fill from light sources (torches=14, lava=15,
      redstone ore=4); propagates through transparent blocks, attenuating 1
      per step; recompute on block change (full column recompute — fast enough
      for edits)
- [x] Baked into vertex colors alongside AO + face-direction shading.
      Switched material from MeshLambertMaterial → MeshBasicMaterial (vertex
      colors = full brightness). Day/night modulation via toneMappingExposure.
- [x] New TORCH block (id 52, cross-shape, light 14). Added to hotbar slot 6.

**CHECKPOINT 13:** place a torch in a dark cave; light spreads in a warm
radius; breaking it darkens; sunlight pools under overhangs at midday.
Verified headless: 17/17 tests pass (TORCH registry, skylight above surface=
15 / underground=0, torch placement lights adjacent blocks=14, breaking torch
removes light, skylight preserved after recompute, opaque blocks have sky=0,
determinism). Lava probe confirmed all lava blocks have block light 15. All
modules serve 200 with no transform errors.

---

### Phase 14 — Inventory + Hotbar UI

**Goal:** you carry stuff.

- [x] `ui/inventory.js`: HTML overlay — 9-slot hotbar (1–9 / wheel), 27-slot
      main inventory (3×9). Armor/off-hand deferred (no armor items exist
      yet). Creative palette grid of all ~50 blocks with atlas-sprite icons.
- [x] `E` opens inventory screen (releases pointer lock); click palette block
      to add to selected hotbar slot; click inventory slots to pick up / swap.
- [x] Hotbar (from Phase 5) refactored to read from Inventory data model.
      Pre-filled with creative palette (grass/stone/planks/wood/glass/torch/
      cobble/sand/leaves, all infinite count).
- [x] Item icons use the texture atlas as CSS background sprites
      (data URL + background-position per tile).

**CHECKPOINT 14:** items collect into hotbar; inventory opens/closes;
stacks work; selected slot highlighted.
Verified: all modules serve 200. Inventory data model (36 slots, addItem/
removeSelected/swapWithHeld), creative palette, E to toggle, pointer lock
release on open. Block icons render via atlas CSS sprites. Hotbar highlights
selected slot.

---

### Phase 15 — Block Drops + Pickup

**Goal:** mining yields resources.

- [x] `world/items.js`: block break → spawn item entity (spinning 0.3³ cube
      using the block's drop texture); gravity + ground rest + bob/spin;
      attracted toward player within 1.5 m; added to inventory on contact
      (< 0.6 m); 0.5 s pickup cooldown; 5-min despawn.
- [x] Correct drops via registry `drops` field: stone→cobblestone, grass→dirt,
      glass→null, ice→null, ores→self (smelt later), wood→self. Leaves drop
      nothing (null). Bedrock → self but unbreakable.
- [x] Item geometry cached per block type (shared BoxGeometry + material);
      UVs remapped to atlas tile. `B` toggles drops on/off for creative mode.

**CHECKPOINT 15:** mine stone, pick up cobblestone; mine wood, pick up logs;
item entities visible on the ground.
Verified: all modules serve 200. Items spawn on block break (respecting drops
field), fall with gravity, spin/bob on the ground, attract toward player,
collect into inventory. Press `B` to toggle drops. Item count shown in F3 HUD.

---

### Phase 16 — Crafting

**Goal:** make tools and building blocks.

- [x] `engine/items.js`: **NEW** — separate ITEM registry (stick, coal,
      charcoal, iron/copper/gold ingots, diamond, emerald, lapis, redstone,
      flint). String ids keep them in a distinct namespace from numeric block
      ids. Tools deferred to Phase 17 (need durability + mining tiers).
- [x] Inventory slot shape migrated to `{ kind:'block'|'item', id, count }` so
      blocks and items coexist without id collision. `sameItem()` is the
      canonical equality check. `Inventory.addItem` now takes a `{kind,id}`
      payload; `selectedBlock` returns AIR for non-placeable items. All call
      sites updated (inventory.js, highlight.js hotbar render, main.js pickup).
- [x] `engine/recipes.js`: recipe matcher — shaped (with horizontal mirror) +
      shapeless; grid normalization (trims empty rows/cols) so recipes match in
      any corner. 12 recipes: 5 planks (one per wood log), stick, crafting
      table, chest, furnace (placeholder result until FURNACE block, Phase 21),
      torch (coal OR charcoal), stone bricks, mossy cobblestone (shapeless
      demo). Verified by 10 functional tests (all pass).
- [x] `ui/crafting.js`: 2×2 grid (inventory) + 3×3 grid (crafting table) with a
      live output preview. Reuses the inventory's held-item mechanic. Creative
      mode = free crafting (consumes nothing); survival consumption is wired
      and engages automatically once finite stacks exist.
- [x] CRAFTING_TABLE + CHEST blocks registered (ids 53, 54) with atlas tiles.
      Right-clicking a CRAFTING_TABLE opens the 3×3 grid (useOrPlaceBlock in
      main.js). CHEST places/breaks but its storage UI is Phase 22.
- [x] `assets/atlas.js` extended: scans the ITEM registry so item textures get
      atlas slots; new procedural tiles for crafting table top/side, chest, and
      all 11 items (stick, coal, ingots, gems, flint). 76 tiles total, fits the
      256-tile atlas.
- [ ] DEFERRED (with phase refs): tools/bow/sword (Phase 17 durability),
      smelting recipes (Phase 21 furnace — furnace recipe currently yields
      stone as a placeholder), ladder/fence/door (need more block shapes),
      flint-and-steel/bucket (need item-use actions). Ore→item drops (coal ore
      → coal item) ship with Phase 21; for now ores drop the ore block and coal
      is reachable via the creative palette for the torch recipe.

**CHECKPOINT 16:** craft planks→sticks→torch; place a crafting table for 3×3;
craft a chest. (Pickaxe deferred to Phase 17.) Verified headless: all 10 recipe
tests pass, item registry + slot-shape migration integration-tested, all modules
serve 200. User to confirm live: open inventory (E), see the 2×2 grid + output;
craft planks from a log; place a crafting table and right-click it for 3×3.


---

### Phase 17 — Tools + Mining Tiers

**Goal:** tools matter.

- [ ] `engine/tools.js`: pickaxe/axe/shovel/sword × wood/stone/iron/diamond
      tiers; durability tracked per use (decrement on block break or mob hit)
- [ ] Mining speed scaled by tool tier; ore gating (stone needs wood+,
      diamond needs iron+); correct drops only with the right tool
- [ ] Tool break → empty slot, sound feedback

**CHECKPOINT 17:** wood pickaxe mines stone but not diamond; diamond
pickaxe is fast and mines everything; sword does more damage than fist.

---

### Phase 18 — Health, Hunger, Damage, Respawn

**Goal:** survival has stakes.

- [ ] `engine/player.js`: 20 HP (10 hearts), 20 hunger; hunger drains over
      time/sprint/jump; starving drains HP below 3 hearts
- [ ] Fall damage (≥4 blocks), drowning (air meter, ~15 s), lava instant
      damage + fire, mob attack damage
- [ ] Death → respawn at world spawn (or bed if set); items drop on death
      (5-minute despawn stretch)
- [ ] HUD: hearts + hunger bars above hotbar

**CHECKPOINT 18:** fall from height → take damage; starve → lose HP; die →
respawn at spawn point; hearts/hunger visible.

---

### Phase 19 — Passive Mobs

**Goal:** life in the world.

- [x] `world/mobs/mobs.js`: cube-built models (Minecraft-style) for **sheep,
      cow, pig, chicken** — each a THREE.Group of textured boxes (body + head +
      4 legs, animated). Simple **wander + gravity** AI: pick random direction
      every 2-5s, walk at type speed, gravity + swept-AABB collision, turn on
      wall hits, idle pauses, stay within ~14 blocks of home. Legs animate
      proportional to speed.
- [x] **Mob HP** (mob-only, scoped — player health/hunger still Phase 18):
      sheep 8, cow 10, pig 10, chicken 4. `Mob.damage(amount, knockDir)` → red
      hurt flash + knockback; at 0 HP dies and emits a death event.
- [x] **LMB attack**: `attackOrBreak()` in main.js ray-tests all mobs first
      (rayHit AABB slab test, reach 4 blocks); hit takes precedence over block
      break (Minecraft model). Fist = 1 dmg; sword multiplier comes Phase 17.
- [x] **Spawn on chunk gen on grass in daylight; despawn if far; mob cap ~12**.
      Streamer gains an `onColumnGenerated(cx,cz,world)` hook; main.js wires it
      to `MobManager.onColumnGenerated` which mirrors the placePlants pattern:
      deterministic position-hash RNG, biome gate (Plains→all four, Forest→
      sheep/pig/chicken, Savanna→cow/pig), GRASS surface + AIR above + height >
      sea level, daylight > 0.5, ~0.4% spawn rate, mob cap. Despawn beyond 80
      blocks of the player. ~0.76 mobs/chunk measured on Plains.
- [x] **Drops**: sheep→wool+mutton, cow→leather×2+beef, pig→porkchop×2,
      chicken→feather+chicken. 8 new items registered (wool/mutton/leather/beef/
      porkchop/chicken/feather/egg) + atlas tiles. Death drops go through the
      extended `ItemDrops.spawn` (now accepts {kind,id} item payloads, not just
      block ids) so mob drops reuse the proven physics + pickup flow.
- [x] **Collision parametrized**: `engine/collision.js` `collidesAt`/`moveAndCollide`
      now take a `{half,height}` dims arg (defaults to player 0.6×1.8 — back-
      compat). Reusable by Phase 20 hostiles. Verified: mob AABB collides with
      stone correctly, player path unchanged.
- [ ] DEFERRED: breeding (needs wheat item + AI states — later), mob sounds
      (Phase 24 audio), full MC variety (horse/wolf/fox — extend the registry),
      graze/look-at-player behaviors (current AI is wander-only).

**CHECKPOINT 19:** animals wander plains/forest; LMB them to kill → drops
appear + get picked up; they don't spawn in ocean/desert/caves/night. Verified
headless: collision parametrization (mob-on-floor vs embedded), 8 mob-drop
items registered, rayHit AABB math (4.55 hit vs Infinity miss), Plains spawn
eligibility (191 cells → ~0.76 mobs/chunk), all 7 modules serve 200. User to
confirm live.

---

### Phase 20 — Hostile Mobs + Combat

**Goal:** the night is dangerous.

- [ ] `world/mobs/hostile.js`: zombie (walks toward player, melee, burns in
      sun), skeleton (ranged bow, burns in sun), creeper (explodes when
      close, no burn), spider (climbs, neutral by day)
- [ ] Spawn at night or in dark caves (light ≤ 7), within 128-block radius,
      despawn beyond; mob cap ~70
- [ ] `engine/combat.js`: LMB or sword attacks; knockback; mob attack
      damage; creeper fuse + explosion (destroys blocks in radius)
- [ ] Death drops: rotten flesh, bone, arrow, gunpowder, string, spider eye

**CHECKPOINT 20:** night falls → zombies/skeletons spawn; survive till
dawn; they burn at sunrise (except creepers/spiders); creeper explosions
leave craters.

---

### Phase 21 — Furnace + Smelting

**Goal:** process raw resources.

- [ ] `ui/furnace.js`: furnace block UI — input + fuel + output slots; fuel
      burns on time (coal 8 items, wood 1.5, lava bucket 100, blaze rod stretch)
- [ ] `engine/recipes.js` smelt recipes: iron ore→ingot, copper ore→ingot,
      sand→glass, cobblestone→stone, raw meat→cooked, logs→charcoal,
      cactus→green dye
- [ ] Furnace tick logic (in world tick loop, not per-frame)

**CHECKPOINT 21:** smelt iron ore → ingot; sand → glass; furnace UI shows
fuel burn progress.

---

### Phase 22 — Chests + Storage

**Goal:** keep your stuff.

- [ ] `ui/chest.js`: chest block (27 slots), large chest (54 via two chests
      adjacent); opens UI on use; persists contents in chunk NBT
- [ ] Barrel (optional), shulker box (out of scope for v1)

**CHECKPOINT 22:** store items in a chest; they survive reload; large
chest works when two chests adjacent.

**CHECKPOINT ARC 3:** full survival loop — mine, craft, build, eat, fight,
survive the night. The Minecraft core loop is complete.

---

## ARC 4 — Polish & Persistence

### Phase 23 — Save/Load (IndexedDB)

**Goal:** the world persists.

- [ ] `engine/save.js`: serialize dirty chunk columns to IndexedDB on unload
      + periodic save (every 30 s); load on chunk-enter
- [ ] Player state (inventory, health, position, time, spawn) saved
      separately under a `player` key
- [ ] World seed in the save key so multiple worlds are possible

**CHECKPOINT 23:** close tab, reopen → world + inventory restored; chunks
load from save before regenerating.

---

### Phase 24 — Audio

**Goal:** the world sounds alive.

- [ ] `assets/audio.js`: block break/place (per-material), footsteps (per-
      surface), mob sounds (per mob), hurt, ambient music loops — CC0
      sources (freesound)
- [ ] Spatial audio for mob sounds (positioned); music non-spatial

**CHECKPOINT 24:** mining has audible feedback per material; mobs make
sounds; ambient music loops at low volume.

---

### Phase 25 — Particles + Weather

**Goal:** charm and atmosphere.

- [ ] `engine/particles.js`: block-break particles (cubelets of the block's
      texture, gravity, short life); rain (particle sheet + sky darkening);
      optional snow in snowy biomes
- [ ] Weather state (clear / rain / snow) per biome; lightning (stretch)

**CHECKPOINT 25:** mining puffs particles; rain falls and darkens the sky;
snow accumulates as snow layers (stretch).

---

### Phase 26 — Creative Mode Polish

**Goal:** both modes are first-class.

- [ ] `engine/gamemode.js`: toggle `T` — creative = fly always, infinite
      blocks in hotbar (any block pickable), instant break, no damage, mob
      spawning optional
- [ ] Block picker: middle-click copies targeted block to hotbar (creative)
- [ ] `E` inventory in creative = full block palette grid (all 80 blocks)

**CHECKPOINT 26:** creative and survival both fully playable; switch
freely; creative inventory has all blocks.

---

### Phase 27 — Performance Pass

**Goal:** holds 60 fps on mid hardware at render distance 8.

- [ ] Chunk meshing moved fully into Web Worker (transfer geometry buffers;
      SharedArrayBuffer if available, copy otherwise)
- [ ] Sub-chunk LOD: skip transparent passes far away; lower mesh frequency
      for distant chunks
- [ ] Greedy meshing tuning; atlas packing; instanced dropped-item meshes
- [ ] Profile + fix any frame spikes (chunk gen, meshing, light recompute)

**CHECKPOINT 27:** 60 fps sustained while flying over varied terrain at
render distance 8; F3 shows stable ms/frame.

**CHECKPOINT ARC 4 (FINAL):** a complete, saveable, performant Minecraft
clone with creative + survival, day/night, mobs, crafting, ~80 blocks,
caves, ores, biomes, and structures. Ship it.

---

## Risk register (things most likely to bite)

1. **Greedy meshing + AO interaction** — AO needs per-vertex data that greedy
   merging can blur. Mitigation: compute AO per emitted vertex from the
   8-neighborhood at mesh time; accept that merged quads get 4 corner AO
   values interpolated across the quad.
2. **384-height memory** — palette compression is mandatory, not optional.
   Render distance 8 keeps voxel data ~8 MB; do not ship v1 at RD 16.
3. **Block-light flood-fill perf** — full recompute on every block edit is
   too slow. Must be incremental (queue only affected light nodes). Deferred
   to Phase 13 only after the engine is stable.
4. **Chunk borders in meshing** — greedy meshing must read neighbor chunks;
   handle unloaded neighbors as "solid" or "air" consistently to avoid
   seams. Document the choice.
5. **Web Worker transfer cost** — palette ArrayBuffer transfer is cheap;
   geometry transfer needs care (SharedArrayBuffer or copy). Profile
   before optimizing.
6. **Mob pathing in voxel world** — A* over the block grid is expensive at
   scale. Use simple greedy step-up/step-down + jump for v1; real pathing
   deferred.
7. **Save format drift** — every block-add or new field breaks old saves.
   Version the save schema from day one.

---

## Status

| Phase | Status | Verified |
|-------|--------|----------|
| 0 — Scaffold | done | awaiting user check |
| 1 — Block & Chunk Data Model | done | awaiting user check |
| 2 — Chunk Meshing + Atlas | done | awaiting user check |
| 3 — Chunk Streaming | done | awaiting user check |
| 4 — Player Controller + Collision | done | awaiting user check |
| 5 — Block Interaction | done | awaiting user check |
| 6 — Terrain Noise + Biomes | done | awaiting user check |
| 7 — Surface Rules + Bedrock | done | awaiting user check |
| 8 — Caves | done | awaiting user check |
| 9 — Ores | done | awaiting user check |
| 10 — Features (trees, plants) | done | awaiting user check |
| 11 — Structures (light) | done | awaiting user check |
| 12 — Day/Night + Sky | done | awaiting user check |
| 13 — Lighting (block light) | done | awaiting user check |
| 14 — Inventory + Hotbar UI | done | awaiting user check |
| 15 — Block Drops + Pickup | done | awaiting user check |
| 16 — Crafting | done | awaiting user check |
| 17 — Tools + Mining Tiers | pending | — |
| 18 — Health, Hunger, Damage, Respawn | pending | — |
| 19 — Passive Mobs | done | awaiting user check |
| 20 — Hostile Mobs + Combat | pending | — |
| 21 — Furnace + Smelting | pending | — |
| 22 — Chests + Storage | pending | — |
| 23 — Save/Load (IndexedDB) | pending | — |
| 24 — Audio | pending | — |
| 25 — Particles + Weather | pending | — |
| 26 — Creative Mode Polish | pending | — |
| 27 — Performance Pass | pending | — |

---

## Decisions log

- **Phase 13 (Lighting):** switched voxel materials from MeshLambertMaterial
  to MeshBasicMaterial so vertex colors directly control brightness (the MC
  model: vertex color IS the light, not modulated by scene lights). Vertex
  brightness = `AO × faceShade × max(skyLight, blockLight) / 15`. Face-
  direction shading baked in (top=1.0, X=0.6, Z=0.8, bottom=0.5) replacing
  the Lambert directional response. Day/night modulation via
  `renderer.toneMappingExposure = 0.25 + 0.75 × daylight` — a global tint
  that darkens everything at night (minor inaccuracy: torch caves are
  slightly darker at night too, acceptable for v1). Light stored as 1
  byte/cell (`sky<<4 | block`) in SubChunk.light — 96 KB/column, ~24 MB at
  render distance 8. Skylight is height-based (no horizontal BFS) —
  overhangs are dark; full BFS skylight deferred to Phase 27 polish. Block
  light BFS propagates through transparent blocks only (opaque blocks block
  light); doesn't cross chunk borders in the BFS (border light slightly off,
  corrected on neighbor gen via dirty flag). TORCH block reuses the cross-
  plant meshing from Phase 10. On block edit: full column light recompute
  (~6144 skylight scan + BFS) — fast enough for creative-mode edits.

- **Phase 12 (Day/Night):** daylight modulation (sun/ambient/hemi intensity)
  lives in `world/sky.js` alongside the time system — it's tightly coupled to
  the sun angle, so a separate `engine/lighting.js` would just forward calls.
  Phase 13 (block light flood-fill) is the real "lighting" system and will
  get its own module. Sky color uses 9 keyframe stops linearly interpolated;
  max per-50-tick color jump is <80 RGB units (smooth). Sun/moon are unlit
  MeshBasicMaterial spheres at distance 500 — they render above terrain but
  below nothing (renderOrder -1). Stars are a 800-point THREE.Points field
  on a radius-800 sphere, opacity controlled by night factor. The daylight
  curve `clamp(sin(angle)*1.5 + 0.25, 0, 1)` gives a brighter dawn/dusk than
  raw sin (0.25 baseline instead of 0 at horizon). Time scrub uses `,` `.`
  (±500 ticks) + `P` pause, since `[` `]` are taken by render distance.

- **Phase 11 (Structures — light):** villages + dungeons placed via the same
  deterministic position-hash RNG as features. Village placement is gated by
  the chunk CENTER biome (biomes can vary within a chunk, so per-block checks
  would reject valid villages near borders). Houses require terrain flatness
  (height variance ≤ 2 across footprint) to avoid floating/tilted houses on
  slopes. Dungeons verify the surrounding is solid stone before carving (so
  they don't break the surface or float in caves); if the solid check fails,
  no dungeon is placed (graceful skip). Chests/mob spawners/doors deferred —
  they need interactive block systems from survival phases (Phase 16+ /
  Phase 20). 2 new blocks (STONE_BRICKS, MOSSY_COBBLESTONE) + 2 atlas tiles.

- **Phase 10 (Features):** trees + plants placed via deterministic position-
  hash RNG (no Math.random). Trees require canopy margin (lx/lz in [2,13]) to
  avoid half-tree clipping at chunk borders — creates a subtle 2-block
  treeless margin but is far less ugly than clipped canopies. Cross-border
  canopy writes were considered but rejected (would require multi-chunk
  feature passes or neighbor-dirty propagation on gen). Plant placement runs
  after trees so it can skip cells occupied by trunks. Cross-plant meshing:
  new `shape: 'cross'` block property; the mesher's `faceVisible` returns
  false for cross blocks (they emit no cube faces), and a separate
  `emitCrossPlants` pass scans each sub-chunk for cross blocks, emitting 2
  diagonal quads per block into the transparent geometry (double-sided, full
  brightness, no AO). The uniform fast path handles uniform cross sub-chunks
  (rare but correct). Cactus is a solid transparent cube (not cross) —
  simplified from MC's thinner collision but visually right. 14 new blocks +
  19 atlas tiles. Lily pads/mushrooms/sugar cane deferred: they need water-
  surface interaction or slab shapes beyond v1's cross-plant model.

- **Phase 9 (Ores):** ore placement uses per-ore seeded `Noise3D` with a
  triangular Y density (1.0 at peak, 0 at yMin/yMax edges). Threshold rises
  by `margin` away from peak so ores concentrate near their real-MC peak Y.
  Deepslate conversion is a separate first pass: uniform STONE sub-chunks
  entirely below Y=8 get a bulk `fill(DEEPSLATE)`; the one mixed sub-chunk
  crossing Y=8 (s=4, Y=0..15) walks cells per-block. Ore variant selection
  (`worldY < 8 ? deepslate : normal`) happens at placement time, so the same
  ore config drives both variants. Emerald uses a `biome: BIOME.MOUNTAINS`
  restriction checked per-column via `bm.getBiome(wx, wz)`. Performance:
  ~6–8 ms/col for the full ore pass (8 ores × Y-filtered sub-chunk range),
  dominated by the 8 noise generators. The Phase 8 `BLOCK.LAVA` undefined
  bug was fixed here — LAVA is now block id 21 (liquid, light 15,
  transparent, non-solid); caves below Y=−55 now correctly produce lava
  instead of throwing.

- **Perf fix pass (after Phase 7):** user reported two issues — (1) missing
  block faces + falling through at chunk borders, (2) severe stuttering/
  freezing when new chunks generate. Root causes found and fixed:
  - **Meshing was 34.5 ms/col** — the mesher scanned all 24 sub-chunks per
    column even though ~16 are all-air and 5 are all-stone (0 faces but full
    scan cost). Fixed three ways: (A) `SubChunk.compact()` after generation
    collapses homogeneous sub-chunks to single-value (palette size 1, bits=0);
    (B) mesher uniform fast path — only checks the 6 boundary slices instead
    of all 51 for uniform sub-chunks, all-air sub-chunks skip entirely; (C)
    `chunkmesh.js` skips all-air sub-chunks before even calling the mesher.
    Result: **6.4× speedup** (34.5 → 5.4 ms/col). After compaction 21/24
    sub-chunks are uniform (16 all-air + 5 all-stone), only 3 need full meshing
  - **Streamer dumped 20 meshes/frame** (690 ms freeze). Fixed with a TIME
    BUDGET: meshing stops when elapsed frame time exceeds 8 ms. Generation
    rate lowered to 6 cols/frame. Generate radius (10) is wider than mesh
    radius (8) so collision always works ahead of the player. Unload radius
    (12) for hysteresis
  - **Stale border faces** — when chunk A was meshed before neighbor B existed,
    A's border faces were drawn (correct, B was air/unloaded). But if B's DATA
    existed (generated) while B's MESH didn't, the mesher read B as solid and
    culled A's face → visual hole. Fixed: when a column finishes generating,
    the streamer marks its 4 neighbors dirty (`_markNeighborDirty`) so they
    re-mesh against correct neighbor data. Verified: border faces appear when
    neighbor unloaded, cull correctly when neighbor loads

- Folder: `src/minecraft/` (matches the `highlands/` / `packbrawl/` / `spike/`
  pattern). Isolated entry `minecraft.html` at repo root. No forest imports.
- Stack reuse: Three.js + Vite already installed; Rapier installed but
  reserved for dynamic mobs/items in later phases (player uses custom
  swept-AABB).
- Texture style: procedural pixel-art atlas generated at load (zero asset
  licensing, swappable later).
- Mob models: cube-built in code (classic MC look).
- Initial scope locked: 384-height Overworld, ~80 blocks, creative +
  survival + crafting, day/night + hostile mobs, classic MC look.

- **Vegetation & structure distribution pass (post-Phase 15, user feedback):**
  user reported trees were too dense, canopies too low to walk under (player
  head collided with leaf blocks), and trees clipping into houses. Three root
  causes fixed across `features/trees.js`, `structures/village.js`,
  `generator.js`, `features/plants.js`:
  (1) **Trunks raised +1-2 blocks** (oak 5-7, birch 7-9, spruce 8-12, jungle
      10-13, acacia 5-7). v1 canopies started at surfaceY+2 — inside the 1.8 m
      player head — and leaves are `solid:true` so the swept-AABB blocked
      walking under them. Spruce's `canopyConical` rewritten to occupy only
      the UPPER ~40% of the trunk (was anchored 1 block off the ground).
  (2) **Densities recalibrated to real MC per-chunk counts** (verified by
      generating 8 pure-chunk samples per biome): plains 0.005 (~1/chunk),
      forest 0.050 (~7), taiga 0.024 (~6), snowy 0.024 (~5), jungle 0.190
      (~32, dense by design), savanna 0.004 (~1), swamp 0.012 (~2), mountains
      0.004 (~1 on grassy slopes; peaks are stone and correctly tree-free).
      v1 was ~3-5x too dense (forest 0.10 → ~25/chunk).
  (3) **Structure/feature order flipped** to match Minecraft's worldgen
      pipeline: generator now runs placeDungeon → placeVillage → placeTrees →
      placePlants (was trees → plants → dungeon → village). placeVillage
      RETURNS house footprints as `{wx, wz, radius:4}` exclusion zones, which
      placeTrees receives and skips via `inExclusionZone` → villages sit in
      natural grassy clearings with no tree clipping the walls. Plants do NOT
      respect zones (grass filling the yard is the intended look). A grid-
      based minimum-tree-spacing check was tried and REMOVED: it over-rejected
      dense biomes (junge/taiga dropped to ~0.1-6/chunk) because each tall
      trunk blocked all 8 neighbors; the per-position density hash already
      distributes trees Poisson-like. Plant densities trimmed ~0.7x for
      consistency (plains 0.35→0.20, jungle 0.45→0.30, etc.). Known limitation:
      cross-chunk structure/tree exclusion (a tree in chunk A near a house in
      chunk B) — rare at 2% village chance + low tree density; documented.

- **Lighting natural-dispersal pass (post-Phase 15, user feedback):** user
  reported light looked "cut off" with no dispersal — interiors/caves/under-
  canopies snapped abruptly to black. Three compounding root causes, all fixed:
  (1) **Skylight was vertical-only** — `computeColumnLight` scanned each (x,z)
      column top-down and clamped everything below the first opaque block to
      sky=0 with NO horizontal spread, so under any overhang/tree/roof there
      was a hard vertical cliff from sky=15 to sky=0 in one block. Added
      `floodSkylight`: a second BFS pass seeded from every sky>0 cell that
      spreads skylight sideways and downward (down = same level, light pours
      unhindered; sideways/up = attenuate 1/step) through transparent blocks,
      reading ACROSS CHUNK BORDERS via the world so light leaks in from lit
      neighbors. Verified: under a 7-block roof overhang, floor skylight now
      ramps 8→9→10→11→12→13→14→15 toward the open edge (was all-0). This is
      exactly what real MC does (vertical skylight + sky-light flood).
  (2) **Linear brightness curve** — mesher mapped lightLevel/15 directly, so a
      level drop 15→10→5 read as a big visible stepdown. Added `lightCurve`:
      a sqrt (gamma ~2.2) perceptual curve (level 4: 0.27 → 0.555; level 0:
      0.0 → 0.08 floor). Darkness now deepens gradually instead of snapping.
      Applied to both cube-face and cross-plant vertex brightness.
  (3) **Night exposure floor too low** — `toneMappingExposure = 0.25 + 0.75*day`
      bottomed at 0.25, so even midday couldn't lift sky=0 regions. Raised to
      `0.40 + 0.60*day` plus the per-vertex MIN_BRIGHTNESS=0.08 floor: caves/
      interiors stay moody-but-visible rather than pitch black. `computeColumn-
      Light` now takes a `world` arg (needed for cross-chunk skylight reads);
      generator + recomputeColumnLight updated. Trade-off: per-column skylight
      BFS adds ~one more flood-fill at gen time (~6144 cells) — cheap for v1's
      edit-rate; deferred-to-Phase-27 item is incremental light updates on
      block change instead of full-column recompute. Block-light BFS still
      uses the local-column approximation (torches look fine); upgrading it to
      cross-chunk like skylight is a documented future tweak.

- **Performance + real-shadow lighting pass (post-Phase 15, user feedback
  "sluggish at startup" + "light should come from the sun"):** two arcs:
  (A) STARTUP PERF — root cause was the Phase-13 skylight flood-fill added
      above: it seeded from EVERY sky>0 cell and re-flooded full-depth columns,
      costing **25.8 ms/column** (60% of the 42 ms generate cost). Fixed three
      ways, all quality-neutral:
      1. `floodSkylight` rewrite: seed every sky=15 cell but `current >= 15 →
         skip` guard means full-depth cells no-op instantly (vertical pass
         owns them). Only spread sideways/down, never up. **25.8 → 8.0 ms**
         (3.2× faster), verified the overhang gradient is unchanged.
      2. `World` column key `cx+','+cz` → numeric `((cx+32768)<<16)|(cz+32768)`.
         The mesher calls getBlock/getLight ~218k times/column; each old call
         allocated a string + hashed it. **Meshing 13.9 → 9.5 ms** (1.5×).
         Added public `World.key()` helper; updated all callers (streamer,
         lighting, main.js mark-dirty) that reached into `.columns` directly.
      3. Streamer: replaced fixed `maxLoadsPerFrame=6` (6×16ms=96ms stalls!)
         with a TIME-BUDGETED gen loop (6ms) + independent mesh budget (12ms).
         No frame now exceeds ~18ms. Measured: radius-3 surroundings fill by
         frame 25 with smooth frames throughout. generateColumn total 42→17ms.
  (B) REAL SUN-DIRECTIONAL SHADOWS — user wanted the sun to be the focal point
      of where light/shadows fall. Researched: vanilla MC lighting is NOT
      directional (omnidirectional flood-fill + AO); true sun shadows need
      shadow mapping.
      - **FIRST ATTEMPT (REVERTED — caused a black-screen regression):** switched
        materials MeshBasic → MeshLambert and DROPPED sky light from the vertex
        colors, assuming Lambert would re-light surfaces from the sun. This was
        the wrong architecture for a voxel engine: Lambert multiplies diffuse ×
        light intensity, and with sky light removed from vertices, every outdoor
        block's diffuse collapsed to ~0 (block light is 0 almost everywhere
        outdoors) → near-black screen. The Lambert path also fought the baked AO
        and lost the proven light model. Reverted entirely.
      - **CORRECT APPROACH (shipped):** keep `MeshBasicMaterial` with the FULL
        baked vertex light (sky + block + AO + faceShade) — vertex colors own
        brightness, exactly as the [0fps.net voxel AO ref](https://0fps.net)
        and the Three.js voxel tutorial prescribe. Add sun-directional shadows
        as a MULTIPLICATIVE DARKENING on top via `onBeforeCompile`:
          * vertex stage injects `shadowmap_pars_vertex` + `shadowmap_vertex`
            (computes vDirectionalShadowCoord from the sun's shadow matrix).
          * fragment stage injects `shadowmap_pars_fragment` + a manual
            `getShadow(directionalShadowMap[0], ...)` sample, then multiplies
            `gl_FragColor.rgb *= 0.5 + sunShadow*0.5` (sunlit=1.0, shaded=0.5).
          * Guarded by `#if NUM_DIR_LIGHT_SHADOWS > 0 && defined(USE_SHADOWMAP)`
            so if shadows are ever disabled, the shader still compiles and just
            shows full-bright (graceful degradation). `customProgramCacheKey`
            set so the patched program isn't shared with vanilla MeshBasic.
      - Sun stays a shadow CASTER (2048² map, ortho ±70 follow-cam). Chunks
        castShadow+receiveShadow (transparent receive-only). sky.js intensities
        reverted to cosmetic-only (MeshBasic ignores scene lights; only the
        shadow DIRECTION matters now). exposure modulation restored
        (0.40+0.60×day) — day/night brightness comes from the baked vertex
        skylight + exposure tint, not from Lambert.
      - VERIFIED (not just compiles): meshed a real Forest column with the
        corrected offset — surface faces (grass tops, exposed dirt, leaves)
        emit brightness up to 1.0; buried underground stone is ~0.04 (correct,
        sky=0, unseen anyway). The black-screen bug is gone; shadows now layer
        on top of the proven light model instead of replacing it.
      - **SHADOWS DISABLED (gated behind `ENABLE_SUN_SHADOWS = false`):** the
        onBeforeCompile GLSL broke the render twice in testing — first the
        Lambert attempt (black screen, wrong architecture), then a second black
        screen from a wrong shadow uniform name (the bias/radius live in the
        `directionalLightShadows[0]` struct, NOT as flat `directionalShadowBias`
        uniforms). A non-compiling shader is the worst failure mode (silent
        black screen, no error visible). Fix shipped: the entire shadow system
        (renderer.shadowMap, sun caster, the shader patch, chunk flags) is gated
        on `ENABLE_SUN_SHADOWS` (declared near the top of main.js, default
        false). With it off, materials are plain MeshBasic and the baked-light
        model renders correctly on its own. Chunk castShadow/receiveShadow flags
        are harmless no-ops when shadowMap.enabled=false (WebGLShadowMap.render
        early-returns). Re-enable only after the GLSL is verified compiling in a
        real browser; the shader string is now correct (struct fields, guarded
        `#if`), but GLSL can't be compile-tested headlessly. Shadows are polish;
        they do NOT block Phase 16 (Crafting).


