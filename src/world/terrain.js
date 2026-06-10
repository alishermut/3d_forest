import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

// Terrain v2 (Phase 11): 800x800 m. Rolling forest in the west, a ridged
// mountain range rising along the east side, a lake basin in the center,
// and a river carving down from the mountains into the lake.
// Still ONE analytic getHeight(x, z) — the player, physics heightfield,
// trees, grass and flowers all keep working because they all ask it.

export const WORLD_SIZE = 1200;  // terrain extent in meters (Phase 16: was 800)
export const WORLD_RADIUS = 560; // soft walkable boundary (circle)
export const TERRAIN_SEGMENTS = 768; // grid subdivisions — same 1.56 m density as 512/800

// Player spawn: west shore of the lake, looking east across the water
// toward the sun and the mountains.
export const SPAWN = { x: -120, z: 30 };

// Lake (center of the map)
const LAKE_X = 0;
const LAKE_Z = 0;

// Deterministic PRNG so the world is identical on every load.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const heightNoise = new SimplexNoise({ random: mulberry32(1337) });
const tintNoise = new SimplexNoise({ random: mulberry32(9001) });

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
const lerp = THREE.MathUtils.lerp;

// --- River: quadratic bezier from the mountain foothills down to the lake,
// pre-sampled into a polyline for fast distance queries.
const RIVER_P0 = { x: 265, z: -95 };
const RIVER_P1 = { x: 150, z: -20 };
const RIVER_P2 = { x: 58, z: 6 };
const RIVER_SAMPLES = 96;
const riverPts = [];
for (let i = 0; i <= RIVER_SAMPLES; i++) {
  const t = i / RIVER_SAMPLES;
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const c = t * t;
  riverPts.push({
    x: a * RIVER_P0.x + b * RIVER_P1.x + c * RIVER_P2.x,
    z: a * RIVER_P0.z + b * RIVER_P1.z + c * RIVER_P2.z,
    t,
  });
}

// Distance to the river curve + curve parameter (0 = mountains, 1 = lake).
// Cheap bbox reject first — getHeight is called millions of times at init.
// RIVER DISABLED (Phase 15): a believable river needs real flow physics —
// removed for now. Returning Infinity makes every consumer (terrain carve,
// tree/grass/flower masks, water level) inert without touching them, so the
// river can come back by deleting the next line.
export function getRiverDistance(x, z) {
  return { d: Infinity, t: 0 };
  if (x < 25 || x > 300 || z < -135 || z > 45) return { d: Infinity, t: 0 };
  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i < riverPts.length - 1; i++) {
    const p = riverPts[i];
    const q = riverPts[i + 1];
    const vx = q.x - p.x;
    const vz = q.z - p.z;
    const wx = x - p.x;
    const wz = z - p.z;
    const len2 = vx * vx + vz * vz;
    let s = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
    s = THREE.MathUtils.clamp(s, 0, 1);
    const dx = wx - vx * s;
    const dz = wz - vz * s;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      bestT = p.t + (q.t - p.t) * s;
    }
  }
  return { d: Math.sqrt(best), t: bestT };
}

export function getLakeDistance(x, z) {
  return Math.hypot(x - LAKE_X, z - LAKE_Z);
}

// Single source of truth for ground height.
export function getHeight(x, z) {
  // Rolling forest hills
  let h = 0;
  h += heightNoise.noise(x / 150, z / 150) * 6.0;
  h += heightNoise.noise(x / 45, z / 45) * 1.5;
  h += heightNoise.noise(x / 12, z / 12) * 0.3;

  // Mountain range along the east side: ridged noise (1 - |n|) for sharp
  // crests, big wavelength for the main ridge + smaller spurs.
  const m = smoothstep(185, 330, x);
  if (m > 0) {
    const ridge1 = 1 - Math.abs(heightNoise.noise(x / 175, z / 175));
    const ridge2 = 1 - Math.abs(heightNoise.noise(x / 70 + 9.7, z / 70 - 3.1));
    h += m * (Math.pow(ridge1, 1.6) * 72 + ridge2 * 16 + 12);
  }

  // Lake basin: a guaranteed dry RIM ring first (no natural dips below the
  // waterline outside the bowl — otherwise the water sheet floods random
  // low forest), then a continuous beach descent into the bowl.
  const dl = getLakeDistance(x, z);
  if (dl < 130) {
    const rim = smoothstep(125, 100, dl) * smoothstep(45, 70, dl);
    h = lerp(h, Math.max(h, 0.6), rim);
    // Beach profile (Phase 15): the old min(h, 1.2) clamp + sink left a
    // ~40 m dead-flat ring around the water that read as a second water
    // sheet from the shore. Instead, descend continuously from the rim
    // (≈2.2 m) to the bowl floor (≈-10.5 m); the base noise survives until
    // full takeover, so the waterline stays irregular like a real bank.
    const beach = lerp(2.2, -10.5, smoothstep(108, 30, dl));
    h = lerp(h, Math.min(h, beach), smoothstep(118, 88, dl));
  }

  // River channel (Phase 15 rewrite): FORCE the terrain to the bed profile
  // near the centerline — raising or lowering. The old min() only carved,
  // so wherever natural ground dipped below the bed line the water ribbon
  // floated in mid-air. Banks crest ~0.75 m above the water surface
  // (surface = bed + 0.55) just outside the water strip, then blend back
  // into natural terrain like a levee. Inside the lake bowl the channel
  // only deepens, so it never builds a ridge across the beach.
  const r = getRiverDistance(x, z);
  if (r.d < 30) {
    const bedY = lerp(13, -4.5, smoothstep(0, 1, r.t));
    const halfW = 6 + r.t * 5; // widens toward the mouth
    const bank = bedY + 1.3 * smoothstep(halfW - 2, halfW + 1, r.d);
    const bowl = smoothstep(95, 75, dl);
    const channel = lerp(bank, Math.min(bank, h), bowl);
    h = lerp(h, channel, smoothstep(halfW + 12, halfW + 1, r.d));
  }

  return h;
}

// ---------------------------------------------------------------------------
// Water (Phase 13): the lake fills the basin, the river follows its bed.
// ---------------------------------------------------------------------------
export const LAKE_WATER_Y = -1.5;

export function getRiverHalfWidth(t) {
  return 6 + t * 5;
}

// River surface height along the curve: follows the descending bed but never
// drops below the lake it feeds (Phase 11 pools finding).
export function getRiverSurfaceY(t) {
  return Math.max(lerp(13, -4.5, smoothstep(0, 1, t)) + 0.55, LAKE_WATER_Y);
}

export function getRiverPoints() {
  return riverPts;
}

// Water surface height at (x, z), or null where there is no water body.
// Consumers: physics (swim/buoyancy), water rendering, underwater FX.
export function getWaterLevel(x, z) {
  let level = null;
  // 106 matches the lake mesh's clip radius — volume and visual agree.
  if (getLakeDistance(x, z) < 106) level = LAKE_WATER_Y;

  const r = getRiverDistance(x, z);
  if (r.d < getRiverHalfWidth(r.t) + 6) {
    const rl = getRiverSurfaceY(r.t);
    level = level === null ? rl : Math.max(level, rl);
  }
  return level;
}

// ---------------------------------------------------------------------------
// Shared height grid (Phase 16): getHeight sampled ONCE over the terrain
// lattice, reused by the render mesh (vertex heights + rock-blend slope) and
// the Rapier heightfield. Replaces three separate sampling passes — the
// 1200 m world loads FASTER than the old 800 m one (the per-vertex getSlope
// alone was 4 extra getHeight calls per vertex).
// Layout: heights[iz * (n + 1) + ix], ix spans -W/2..+W/2 in x, iz same in z.
// ---------------------------------------------------------------------------
let _heightGrid = null;

export function getHeightGrid() {
  if (_heightGrid) return _heightGrid;
  const n = TERRAIN_SEGMENTS;
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let iz = 0; iz <= n; iz++) {
    const z = (iz / n - 0.5) * WORLD_SIZE;
    for (let ix = 0; ix <= n; ix++) {
      const x = (ix / n - 0.5) * WORLD_SIZE;
      heights[iz * (n + 1) + ix] = getHeight(x, z);
    }
  }
  _heightGrid = { n, step: WORLD_SIZE / n, heights };
  return _heightGrid;
}

// Approximate slope (rise over run) via central differences.
export function getSlope(x, z) {
  const e = 1.5;
  const dx = getHeight(x + e, z) - getHeight(x - e, z);
  const dz = getHeight(x, z + e) - getHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

// Large-scale color variation (0..1) — drives ground tint AND grass density.
export function getTint(x, z) {
  return tintNoise.noise(x / 55, z / 55) * 0.5 + 0.5;
}

export function createTerrain({ map, normalMap, armMap, rockMap }) {
  const grid = getHeightGrid();
  const n = grid.n;
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, n, n);
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const rockBlend = new Float32Array(pos.count);

  // Grid lookups by lattice index (robust to the plane's vertex ordering).
  const gh = (ix, iz) =>
    grid.heights[
      THREE.MathUtils.clamp(iz, 0, n) * (n + 1) + THREE.MathUtils.clamp(ix, 0, n)
    ];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const ix = Math.round((x / WORLD_SIZE + 0.5) * n);
    const iz = Math.round((z / WORLD_SIZE + 0.5) * n);
    const h = gh(ix, iz);
    pos.setY(i, h);

    // Macro tint: darker earthy patches vs lighter mossy ones.
    const t = getTint(x, z);
    const shade = 0.72 + t * 0.42;
    colors[i * 3 + 0] = shade * 0.98;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * 0.92;

    // Rock shows where it's steep or high (cliffs, upper mountains).
    // Slope from grid central differences — no extra getHeight calls.
    const slope =
      Math.hypot(gh(ix + 1, iz) - gh(ix - 1, iz), gh(ix, iz + 1) - gh(ix, iz - 1)) /
      (2 * grid.step);
    rockBlend[i] = THREE.MathUtils.clamp(
      smoothstep(0.5, 0.95, slope) + smoothstep(26, 48, h) * 0.85,
      0,
      1
    );
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aRock', new THREE.BufferAttribute(rockBlend, 1));
  geometry.computeVertexNormals();

  const repeat = WORLD_SIZE / 4; // one forest-floor tile ≈ 4 m
  for (const tex of [map, normalMap, armMap]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
  }
  map.colorSpace = THREE.SRGBColorSpace;

  rockMap.wrapS = rockMap.wrapT = THREE.RepeatWrapping;
  rockMap.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap: armMap, // green channel of Poly Haven ARM = roughness
    metalness: 0,
    vertexColors: true,
  });

  // Slope/altitude splat: blend the forest floor into rock using the
  // per-vertex aRock attribute. Rock samples the same (repeated) UV at a
  // larger scale so cliffs read at ~20 m tiling.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rockMap = { value: rockMap };

    shader.vertexShader =
      `
      attribute float aRock;
      varying float vRock;
      ` +
      shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vRock = aRock;`
      );

    shader.fragmentShader =
      `
      uniform sampler2D rockMap;
      varying float vRock;
      ` +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec4 floorColor = texture2D(map, vMapUv);
        vec4 rockColor = texture2D(rockMap, vMapUv * 0.2);
        diffuseColor *= mix(floorColor, rockColor, vRock);
        #ifdef USE_FOG
        // Wet shoreline: darken a band just above/below the lake waterline
        // (-1.5) so the beach reads as a beach, not a second water sheet.
        // vFogWorldPos comes from the height-fog chunks (atmosphere.js).
        float wetAbove = smoothstep(-0.35, -1.25, vFogWorldPos.y);
        float wetFade = 1.0 - smoothstep(-3.0, -6.0, vFogWorldPos.y);
        diffuseColor.rgb *= 1.0 - 0.45 * wetAbove * wetFade;
        #endif
        `
      );

    material.userData.shader = shader;
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
