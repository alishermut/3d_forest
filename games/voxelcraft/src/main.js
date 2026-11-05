// Voxelcraft — Phase 3: chunk streaming + fly controls.
//
// The boot now uses a Streamer that maintains a ring of loaded chunk columns
// around the camera, instead of pre-building a fixed 3×3 debug world. A
// minimal FlyController lets you fly around to test streaming. Phase 4
// replaces the fly controller with the full player controller (collision,
// walk mode, gravity, jump).
//
// See games/voxelcraft/PLAN.md for the full arc.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { World } from './engine/world.js';
import { BLOCK, BLOCK_COUNT, BLOCK_REGISTRY } from './engine/blocks.js';
import { buildAtlas } from './assets/atlas.js';
import { Streamer } from './engine/streamer.js';
import { PlayerController, EYE_HEIGHT } from './player/playerController.js';
import { SURFACE_Y } from './world/generator.js';
import { raycastVoxel } from './engine/raycast.js';
import { BlockHighlight, Hotbar } from './ui/highlight.js';
import { isSolid } from './engine/blocks.js';
import { Sky } from './world/sky.js';
import { computeColumnLight, recomputeColumnLight } from './engine/lighting.js';
import { Inventory, InventoryUI } from './ui/inventory.js';
import { ItemDrops } from './world/items.js';
import { MobManager } from './world/mobs/mobs.js';
import { WaterSim } from './engine/water.js';

const app = document.getElementById('app');
const promptEl = document.getElementById('prompt');
const statsEl = document.getElementById('stats');
const modeEl = document.getElementById('mode');
const crosshairEl = document.getElementById('crosshair');

// Sun-directional shadow mapping toggle. OFF by default — the onBeforeCompile
// GLSL injection is fragile (a non-compiling shader = black screen, the worst
// failure mode). Flip to true to test shadows once the GLSL is verified.
const ENABLE_SUN_SHADOWS = false;

// --- Renderer (WebGL, ACES tone mapping) ----------------------------------
// Sun-directional shadow mapping is OFF by default (see ENABLE_SUN_SHADOWS at
// the shadow-patch section) — it's verified-fragile GLSL and a compile failure
// means a black screen. The baked-light model renders correctly on its own.
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.setClearColor(0x87ceeb);
app.appendChild(renderer.domElement);

// --- Scene + camera --------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(2, SURFACE_Y + 10, 2);
camera.lookAt(16, SURFACE_Y, 16);

// --- World + streamer ------------------------------------------------------
const world = new World();
console.log(`[voxelcraft] world created: ${BLOCK_COUNT} block types registered.`);

// Pre-generate the spawn column so the player has ground to stand on.
import { generateColumn, getBiomeMap } from './world/generator.js';
generateColumn(world, 0, 0);

// --- Texture atlas ---------------------------------------------------------
const atlas = buildAtlas();
console.log(
  `[voxelcraft] atlas built: ${atlas.tileCount} tiles, ` +
  `${atlas.canvas.width}x${atlas.canvas.height}px`
);

// --- Materials (MeshBasicMaterial — vertex colors carry the FULL baked light) ---
// Voxel lighting architecture: the mesher bakes sky + block + AO + faceShade
// into per-vertex colors, and MeshBasicMaterial renders them directly (no scene
// lights re-light the surface). Sun-directional SHADOWS are added on top via an
// onBeforeCompile shader patch: the shadow map darkens the baked color by a
// 0.45..1.0 factor (sunlit=1.0, shaded=0.45). This is the standard voxel
// pattern — the baked light owns brightness, shadows only ever darken it. (The
// earlier Lambert attempt was wrong: it tried to re-light surfaces whose vertex
// colors had no sky term, so everything outside torch range went near-black.)
const opaqueMaterial = new THREE.MeshBasicMaterial({
  map: atlas.texture,
  vertexColors: true,
});
opaqueMaterial.userData.uvMap = atlas.uvs;

const transparentMaterial = new THREE.MeshBasicMaterial({
  map: atlas.texture,
  vertexColors: true,
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
  depthWrite: false,
});

// --- Shadow-darkening shader patch (onBeforeCompile on MeshBasicMaterial) ---
// Gated by ENABLE_SUN_SHADOWS (declared near the top). When OFF, materials are
// left as plain MeshBasicMaterial and the baked-light model renders on its own.
const SHADOW_DARK = 0.5; // shaded fragments keep this fraction of baked light

function patchShadowReceive(material) {
  material.onBeforeCompile = (shader) => {
    // VERTEX: include shadowmap_pars_vertex (declares vDirectionalShadowCoord +
    // the directionalShadowMatrix uniforms) then run shadowmap_vertex AFTER
    // worldpos_vertex so worldPosition is available for the shadow projection.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n#include <shadowmap_pars_vertex>')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n#include <shadowmap_vertex>');

    // FRAGMENT: include shadowmap_pars_fragment, sample the shadow map, derive a
    // 0..1 factor, and multiply gl_FragColor by (SHADOW_DARK + factor*(1-SHADOW_DARK)).
    // Note: bias/radius/size live in the DirectionalLightShadow struct
    // (directionalLightShadows[0]), NOT as flat uniforms — the flat names
    // (directionalShadowBias etc.) DON'T EXIST and cause a silent compile error.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n#include <packing>\n#include <shadowmap_pars_fragment>')
      .replace(
        '#include <fog_fragment>',
        `float sunShadow = 1.0;
         #if NUM_DIR_LIGHT_SHADOWS > 0 && defined( USE_SHADOWMAP )
           sunShadow = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
         #endif
         float shadowFactor = ${SHADOW_DARK.toFixed(2)} + sunShadow * ${(1 - SHADOW_DARK).toFixed(2)};
         gl_FragColor.rgb *= shadowFactor;
         #include <fog_fragment>`
      );
  };
  // Tell three.js this material receives shadows (so the renderer populates the
  // shadow uniforms/coordinates when rendering shadow casters/receivers).
  material.receiveShadow = true;
  // Distinct cache key so this patched program isn't shared with vanilla
  // MeshBasic programs elsewhere in the app.
  material.customProgramCacheKey = () => 'voxelcraft-shadow-basic';
}
if (ENABLE_SUN_SHADOWS) {
  patchShadowReceive(opaqueMaterial);
  patchShadowReceive(transparentMaterial);
}

// --- Lighting --------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(0.5, 1.0, 0.3);
scene.add(sun);
scene.add(sun.target); // target must be in scene for direction to update
// Sun-directional shadow mapping (only when ENABLE_SUN_SHADOWS). When on, the
// sun casts a shadow map; the ortho box follows the player (sized here, recent-
// ered in sky.apply). When off, no shadow map is allocated and the baked-light
// model owns all brightness.
if (ENABLE_SUN_SHADOWS) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xbfdfff, 0x6b5a3a, 0.4);
scene.add(hemi);

// --- Day/night cycle (Phase 12) --------------------------------------------
const sky = new Sky(scene);
// Start at mid-morning so the first session isn't pitch dark.
sky.time = 2000;

// --- Submerged-camera overlay (water / lava murk) --------------------------
// When the camera block is a liquid, swap in a dense colored fog + matching
// background so the view reads as "underwater" (murky, short sight line)
// instead of looking like air with a pane of glass overhead. MeshBasicMaterial
// chunk surfaces respect scene.fog, so this fogs the world correctly.
const WATER_FOG = new THREE.FogExp2(0x3a6fb0, 0.09);   // murky blue, ~10-block sight
const LAVA_FOG = new THREE.FogExp2(0xd84818, 0.55);    // near-opaque orange
const WATER_BG = new THREE.Color(0x2a5590);
const LAVA_BG = new THREE.Color(0xc23410);

// --- Streamer (chunk load/unload/mesh lifecycle) --------------------------
const streamer = new Streamer(world, scene, opaqueMaterial, transparentMaterial);

// --- Flowing water (Phase 17) ----------------------------------------------
// Finite-fluid sim layered on top of the voxel world. Settled gen water acts as
// infinite sources; breaking/placing blocks near water makes it flow/recede via
// waterSim.notify (wired into breakBlock/placeBlock) + the per-frame tick.
const waterSim = new WaterSim(world);

// --- Item drops (Phase 15) -------------------------------------------------
const itemDrops = new ItemDrops(scene, atlas.texture, atlas.uvs, world);
let dropsEnabled = true; // toggle with 'KeyB' to test in creative

// --- Passive mobs (Phase 19) -----------------------------------------------
const mobs = new MobManager(scene, world, atlas.uvs, atlas.texture);
const FIST_DAMAGE = 1;

// --- Pointer lock + player controller --------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
const player = new PlayerController(camera, world, controls);

controls.addEventListener('lock', () => {
  promptEl.classList.add('hidden');
  statsEl.classList.remove('hidden');
  modeEl.classList.remove('hidden');
  crosshairEl.classList.remove('hidden');
  document.body.classList.add('playing');
});
controls.addEventListener('unlock', () => {
  promptEl.classList.remove('hidden');
  crosshairEl.classList.add('hidden');
  document.body.classList.remove('playing');
});

promptEl.addEventListener('click', () => controls.lock());

// Spawn the player on land. Search outward from origin for a non-ocean biome
// with a surface above sea level.
const bm = getBiomeMap();
// Mob spawn hook: the streamer calls this right after each column generates.
// Gate on daylight (passive mobs spawn by day) and let MobManager.onColumn-
// Generated handle biome/surface/cap checks.
streamer.onColumnGenerated = (cx, cz) => {
  const daylight = sky.getDaylight();
  mobs.onColumnGenerated(cx, cz, bm, daylight);
};
import { BIOME_NAMES } from './world/biomes.js';
let spawnX = 0, spawnZ = 0, spawnH = 0;
for (let r = 0; r < 200; r += 8) {
  let found = false;
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const sx = Math.round(Math.cos(a) * r);
    const sz = Math.round(Math.sin(a) * r);
    const h = bm.getBaseHeight(sx, sz);
    const b = bm.getBiome(sx, sz);
    if (h > 64 && b !== 0) { // not ocean
      spawnX = sx; spawnZ = sz; spawnH = h;
      found = true;
      break;
    }
  }
  if (found) break;
}
generateColumn(world, Math.floor(spawnX / 16), Math.floor(spawnZ / 16));
player.spawnAt(spawnX + 0.5, spawnH + 5, spawnZ + 0.5);
console.log(`[voxelcraft] player spawned at (${spawnX}, ${spawnH}, ${spawnZ}) biome=${BIOME_NAMES[bm.getBiome(spawnX, spawnZ)]} feet.y=${player.feet.y.toFixed(1)}`);
player._notifyMode();

// --- Block interaction (Phase 5) + Inventory (Phase 14) --------------------
const highlight = new BlockHighlight(scene);
const inventory = new Inventory();
const atlasDataURL = atlas.canvas.toDataURL();
const inventoryUI = new InventoryUI(inventory, atlasDataURL, atlas.uvs);
const hotbar = new Hotbar(inventory);
let currentTarget = null; // { x, y, z, nx, ny, nz } or null

// E key: toggle inventory (pauses/resumes pointer lock).
inventoryUI.onToggle = (open) => {
  if (open) {
    if (controls.isLocked) controls.unlock();
  } else {
    hotbar.render(); // refresh hotbar display after inventory changes
  }
};
function getCameraRay() {
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return { origin, dir };
}

// Mark the column containing (x, z) dirty, plus neighbors if on a chunk
// border (so border faces re-mesh). The streamer's per-frame mesh queue
// picks it up.
function markDirty(x, z) {
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const lx = x - cx * 16;
  const lz = z - cz * 16;
  const col = world.columns.get(world.key(cx, cz));
  if (col) col.dirty = true;
  if (lx === 0) {
    const n = world.columns.get(world.key(cx - 1, cz));
    if (n) n.dirty = true;
  }
  if (lx === 15) {
    const n = world.columns.get(world.key(cx + 1, cz));
    if (n) n.dirty = true;
  }
  if (lz === 0) {
    const n = world.columns.get(world.key(cx, cz - 1));
    if (n) n.dirty = true;
  }
  if (lz === 15) {
    const n = world.columns.get(world.key(cx, cz + 1));
    if (n) n.dirty = true;
  }
}

// Break the targeted block (creative: instant). Spawns item drop (Phase 15).
function breakBlock() {
  if (!currentTarget) return;
  const { x, y, z } = currentTarget;
  const brokenId = world.getBlock(x, y, z);
  world.setBlock(x, y, z, BLOCK.AIR);
  recomputeColumnLight(world, Math.floor(x / 16), Math.floor(z / 16));
  markDirty(x, z);
  waterSim.notify(x, y, z); // water may flow into the new gap

  // Spawn item drop.
  if (dropsEnabled && brokenId !== BLOCK.AIR) {
    const type = BLOCK_REGISTRY[brokenId];
    const dropId = type?.drops;
    if (dropId !== null && dropId !== undefined) {
      itemDrops.spawn(x, y, z, dropId === 0 ? brokenId : dropId);
    }
  }
}

// Place the selected hotbar block against the targeted face.
function placeBlock() {
  if (!currentTarget) return;
  const { x, y, z, nx, ny, nz } = currentTarget;
  const px = x + nx, py = y + ny, pz = z + nz;
  // Don't place inside the player.
  const feet = player.feet;
  const playerMinX = Math.floor(feet.x - 0.3);
  const playerMaxX = Math.floor(feet.x + 0.3);
  const playerMinZ = Math.floor(feet.z - 0.3);
  const playerMaxZ = Math.floor(feet.z + 0.3);
  const playerMinY = Math.floor(feet.y);
  const playerMaxY = Math.floor(feet.y + 1.8);
  if (px >= playerMinX && px <= playerMaxX &&
      pz >= playerMinZ && pz <= playerMaxZ &&
      py >= playerMinY && py <= playerMaxY) return;
  const id = hotbar.selectedBlock;
  if (id === BLOCK.AIR) return;
  if (world.getBlock(px, py, pz) !== BLOCK.AIR) return; // don't overwrite
  world.setBlock(px, py, pz, id);
  recomputeColumnLight(world, Math.floor(px / 16), Math.floor(pz / 16));
  markDirty(px, pz);
  waterSim.notify(px, py, pz); // placing may block/displace flowing water
}

// Right-click: if targeting a usable block (crafting table), open its UI;
// otherwise place the selected hotbar block. (Sneak-place not implemented —
// table-use takes precedence, matching Minecraft.)
function useOrPlaceBlock() {
  if (currentTarget) {
    const { x, y, z } = currentTarget;
    const targetedId = world.getBlock(x, y, z);
    if (targetedId === BLOCK.CRAFTING_TABLE) {
      // Open the inventory with the 3×3 crafting grid.
      inventoryUI.setCraftingSize(3);
      inventoryUI.open();
      return;
    }
    if (targetedId === BLOCK.CHEST) {
      // Chest storage UI is Phase 22; place/break work today. Show a note.
      console.log('[voxelcraft] Chest: storage UI coming in Phase 22.');
      return;
    }
  }
  placeBlock();
}

// LMB: attack a mob if one is in reach, otherwise break the targeted block.
// This mirrors Minecraft (entity hit takes precedence over block break).
function attackOrBreak() {
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const hit = mobs.tryHitMob(origin, dir);
  if (hit) {
    // Knockback direction: from player toward the mob, on the XZ plane.
    const kx = hit.mob.pos.x - origin.x;
    const kz = hit.mob.pos.z - origin.z;
    const kl = Math.hypot(kx, kz) || 1;
    hit.mob.damage(FIST_DAMAGE, { x: kx / kl, z: kz / kl });
    return;
  }
  breakBlock();
}

// Mouse buttons: LMB = attack/break, RMB = place OR use a block (crafting table).
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) return;
  if (e.button === 0) attackOrBreak();         // left
  else if (e.button === 2) useOrPlaceBlock();  // right
});
// Prevent the context menu on right-click.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// Prevent the context menu on right-click.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Hotbar: number keys 1-9, mouse wheel, E = inventory.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyE') {
    e.preventDefault();
    inventoryUI.toggle();
    return;
  }
  if (inventoryUI.isOpen) return; // ignore game keys while inventory is open
  if (e.code.startsWith('Digit')) {
    const n = parseInt(e.code.slice(5), 10);
    if (n >= 1 && n <= 9) hotbar.select(n - 1);
  }
});
window.addEventListener('wheel', (e) => {
  if (!controls.isLocked) return;
  hotbar.cycle(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

// --- HUD -------------------------------------------------------------------
let statsVisible = false;

function renderStats() {
  if (!statsVisible) return;
  const info = renderer.info;
  const calls = info.render.calls;
  const tris = info.render.triangles;
  const kb = (world.voxelBytes() / 1024).toFixed(1);
  const meshes = streamer.meshCount();
  const cols = world.loadedColumnCount();
  const cx = Math.floor(camera.position.x / 16);
  const cz = Math.floor(camera.position.z / 16);
  const tgt = currentTarget ? `${currentTarget.x},${currentTarget.y},${currentTarget.z}` : '—';
  const sel = BLOCK_REGISTRY[hotbar.selectedBlock]?.name?.split(' ')[0] ?? '—';
  statsEl.textContent =
    `voxelcraft phase 15\n` +
    `fps      ${fps.toFixed(0).padStart(5)}\n` +
    `draws    ${String(calls).padStart(5)}\n` +
    `tris     ${String(tris).padStart(5)}\n` +
    `meshes   ${String(meshes).padStart(5)}\n` +
    `columns  ${String(cols).padStart(5)}\n` +
    `chunk    ${cx}, ${cz}\n` +
    `renderd  ${streamer.renderDistance}\n` +
    `time     ${sky.getClock()} (${sky.getPhase()})${sky.paused ? ' [paused]' : ''}\n` +
    `mode     ${player.fly ? 'FLY' : 'WALK'}${player.onGround ? ' (ground)' : ''}\n` +
    `target   ${tgt}\n` +
    `select   ${sel}\n` +
    `voxmem   ${kb.padStart(7)} KB\n` +
    `items    ${itemDrops.count}${dropsEnabled ? '' : ' (off)'}\n` +
    `mobs     ${mobs.count}\n` +
    `pos      ${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}`;
}

// --- Render loop -----------------------------------------------------------
const clock = new THREE.Clock();
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1); // clamp to avoid huge jumps on tab return

  // Rolling fps over ~0.5 s windows
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  // Player controller (only when pointer locked)
  if (controls.isLocked) player.update(dt);

  // Day/night cycle
  sky.update(dt);
  sky.apply(camera, sun, ambient, hemi);

  // Day/night modulation. With MeshBasic surfaces, the baked vertex skylight is
  // constant brightness; the exposure tint darkens the whole scene at night so
  // it reads as night without re-running lighting. Floor (0.40) keeps caves/
  // interiors moody-but-visible (plus the per-vertex MIN_BRIGHTNESS + gamma).
  const daylight = sky.getDaylight();
  renderer.toneMappingExposure = 0.40 + 0.60 * daylight;

  // Underwater/lava murk: override sky background + add fog when the camera
  // (eye) is inside a liquid block. sky.apply already reset background+fog this
  // frame, so when we surface it returns to normal automatically.
  const eyeBlock = world.getBlock(
    Math.floor(camera.position.x),
    Math.floor(camera.position.y),
    Math.floor(camera.position.z)
  );
  if (eyeBlock === BLOCK.WATER) {
    scene.fog = WATER_FOG;
    scene.background = WATER_BG;
  } else if (eyeBlock === BLOCK.LAVA) {
    scene.fog = LAVA_FOG;
    scene.background = LAVA_BG;
  } else {
    scene.fog = null;
  }

  // Block targeting: raycast from camera, update highlight.
  if (controls.isLocked) {
    const { origin, dir } = getCameraRay();
    currentTarget = raycastVoxel(world, origin, dir, 6);
  } else {
    currentTarget = null;
  }
  highlight.update(currentTarget);

  // Flowing water: advance the fluid sim (only active near recent edits).
  waterSim.tick(dt);

  // Streamer: load/unload/mesh chunks around the camera
  streamer.update(camera.position.x, camera.position.z);

  // Passive mobs: AI + physics. Death events → spawn drops via ItemDrops.
  const mobEvents = mobs.update(dt, camera.position);
  for (const ev of mobEvents) {
    if (ev.type === 'death') {
      for (const drop of ev.drops) {
        itemDrops.spawn(ev.x - 0.5, ev.y, ev.z - 0.5, drop);
      }
    }
  }

  // Item drops: physics + pickup.
  const collected = itemDrops.update(
    dt,
    camera.position.x,
    camera.position.y - 1.62, // feet position
    camera.position.z
  );
  for (const c of collected) {
    inventory.addItem({ kind: c.kind, id: c.id }, c.count);
  }

  renderer.info.reset();
  renderer.render(scene, camera);
  renderStats();
}
animate();

// --- Resize ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Key bindings ----------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    statsVisible = !statsVisible;
    statsEl.classList.toggle('hidden', !statsVisible);
  }
  // Render distance adjust: [ and ]
  if (e.code === 'BracketRight' && controls.isLocked) {
    streamer.renderDistance = Math.min(16, streamer.renderDistance + 1);
    streamer.genDistance = streamer.renderDistance + 2;
    streamer.unloadDistance = streamer.renderDistance + 4;
  }
  if (e.code === 'BracketLeft' && controls.isLocked) {
    streamer.renderDistance = Math.max(2, streamer.renderDistance - 1);
    streamer.genDistance = streamer.renderDistance + 2;
    streamer.unloadDistance = streamer.renderDistance + 4;
  }
  // Time scrub: Comma = back 500 ticks, Period = forward 500 ticks.
  if (e.code === 'Comma') sky.scrub(-500);
  if (e.code === 'Period') sky.scrub(500);
  // Pause/unpause time.
  if (e.code === 'KeyP') sky.paused = !sky.paused;
  // Toggle item drops (for creative mode testing).
  if (e.code === 'KeyB') dropsEnabled = !dropsEnabled;
});

// --- Debug handles ---------------------------------------------------------
window.__renderer = renderer;
window.__scene = scene;
window.__camera = camera;
window.__controls = controls;
window.__world = world;
window.__BLOCK = BLOCK;
window.__streamer = streamer;
window.__player = player;
window.__hotbar = hotbar;
window.__inventory = inventory;
window.__items = itemDrops;
window.__mobs = mobs;
window.__watersim = waterSim;
window.__highlight = highlight;
window.__sky = sky;
window.__raycast = () => {
  const { origin, dir } = getCameraRay();
  return raycastVoxel(world, origin, dir, 6);
};
