import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

// Biome masks (Phase 18): ONE queryable source of truth for "what grows
// where". All masks are pure functions of (x, z) — no terrain imports, so
// terrain.js itself can consume them (the wheat mask flattens getHeight).
// Each returns 0..1 with noise-warped edges; consumers combine them with
// their own height/slope rules.

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const edgeNoise = new SimplexNoise({ random: mulberry32(60311) });

// Lake center (v7 map). Owned HERE because biomes.js is the import root —
// terrain.js re-exports these as LAKE_X/LAKE_Z for everyone else.
export const LAKE_CX = 90;
export const LAKE_CZ = 0;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// --- Wheat plain (v7 map / Phase 38; SHRUNK 2026-06-11 on user feedback):
// flat farmland around the world tree, NOT up the hills. The old 300x380
// reach pushed the warped fade band onto the western foothills (26 m bump
// at -280,120 and 22 m at -255,-160), where partial flattening left wheat
// climbing real slopes. Now ~240x300 m centered on the tree, steeper edge,
// tighter warp — the fade band ends before the foothill skirts. Consumers
// (wheat.js scatter, terrain tint) ALSO gate by height as a backstop.
const WHEAT_CX = -130;
const WHEAT_CZ = 10;
const WHEAT_HX = 120; // half-extent east-west (was 150)
const WHEAT_HZ = 150; // half-extent north-south (was 190)

export function getWheat(x, z) {
  const dx = (x - WHEAT_CX) / WHEAT_HX;
  const dz = (z - WHEAT_CZ) / WHEAT_HZ;
  // Superellipse distance (rounded rectangle, exponent 3).
  const d = Math.pow(
    Math.pow(Math.abs(dx), 3) + Math.pow(Math.abs(dz), 3),
    1 / 3
  );
  const warp = edgeNoise.noise(x / 90 + 11.3, z / 90 - 4.7) * 0.12;
  let m = 1 - smoothstep(0.8, 1.0, d + warp);
  if (m <= 0) return 0;
  // Fade out before the lake's beach band. GEOMETRIC distance from the lake
  // CENTER (we can't import the warped getLakeDistance — terrain imports
  // us); 115-135 clears the elongated waterline's worst-case ~118 m reach.
  const dl = Math.hypot(x - LAKE_CX, z - LAKE_CZ);
  m *= smoothstep(108, 126, dl);
  return m;
}

// --- World tree (Phase 39): the landmark oak at the wheat field's center.
// The clearing mask is 1 at the trunk fading to 0 past the dripline —
// consumers: wheat scatter (fade out under the canopy), terrain tint (bare
// earth ring at the trunk), tree scatter (keep the clearing clear).
export const WORLD_TREE_X = -130;
export const WORLD_TREE_Z = 10;

export function getWorldTreeClearing(x, z) {
  // v11 standard oak: ~30 m tree, ~11 m dripline. 1 at the trunk fading to
  // 0 past the dripline — the weed patch (trees.js) lives inside this ring.
  const d = Math.hypot(x - WORLD_TREE_X, z - WORLD_TREE_Z);
  if (d > 26) return 0;
  const warp = edgeNoise.noise(x / 10 - 7.7, z / 10 + 2.3) * 3;
  return 1 - smoothstep(3, 17, d + warp);
}

// --- Deep forest: the east — dense dark woodland meeting the lake's east
// beach (Phase 38: lake east shore sits at ~x +190).
export function getDeepForest(x, z) {
  const warp = edgeNoise.noise(x / 160 + 3.1, z / 160 + 8.9) * 55;
  return smoothstep(120, 240, x + warp);
}

// --- Alpine: the western range band (mirrors the Phase 17/38 polar massif —
// approximate, for scatter rules; the terrain itself owns the real shape).
export function getAlpine(x, z) {
  const dist = Math.hypot(x, z);
  if (dist < 240) return 0;
  const theta = Math.atan2(z, -x);
  const aMask = 1 - smoothstep(0.85, 1.4, Math.abs(theta));
  return smoothstep(290, 360, dist) * aMask;
}
