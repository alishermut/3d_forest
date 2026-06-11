import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import {
  getWheat,
  getDeepForest,
  getWorldTreeClearing,
  LAKE_CX,
  LAKE_CZ,
} from './biomes.js';

// Terrain v2 (Phase 11): 800x800 m. Rolling forest in the west, a ridged
// mountain range rising along the east side, a lake basin in the center,
// and a river carving down from the mountains into the lake.
// Still ONE analytic getHeight(x, z) — the player, physics heightfield,
// trees, grass and flowers all keep working because they all ask it.

export const WORLD_SIZE = 900;   // terrain extent in meters (Phase 38 compaction: was 1200)
export const WORLD_RADIUS = 420; // soft walkable boundary (circle)
export const TERRAIN_SEGMENTS = 576; // grid subdivisions — same 1.56 m density (8x72 chunks)

// Player spawn (v7 map): the wheat field's lakeside edge, looking east
// across the water toward the sun.
export const SPAWN = { x: -45, z: 15 };

// Lake (Phase 38: moved east so the wheat plain owns the center-west).
// The constants live in biomes.js (import root); re-exported here for
// water/physics/scatter consumers.
export const LAKE_X = LAKE_CX;
export const LAKE_Z = LAKE_CZ;

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

// Discrete foothill bumps (Phase 17): hand-placed gaussian hills scattered
// off the western range — inner spurs poking into the lowland and lone
// hills near the tapered north/south ends. [x, z, height, radius]
const FOOTHILLS = [
  [-280, 120, 26, 58],
  [-255, -160, 22, 52],
  [-120, 330, 18, 48],
  [-110, -340, 16, 44],
];

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

const lakeShapeNoise = new SimplexNoise({ random: mulberry32(7331) });

// Natural lake (Phase 20): warped EFFECTIVE distance — an elongated ellipse
// rotated ~27 deg with two noise octaves carving bays and headlands.
// Returns circle-equivalent meters, so every consumer threshold (basin
// carve, dry rim, beach profile, water level, scatter masks, wheat fade)
// keeps its meaning unchanged.
export function getLakeDistance(x, z) {
  const dx = x - LAKE_X;
  const dz = z - LAKE_Z;
  const rx = (dx * 0.891 + dz * 0.454) / 1.27; // elongated along NE-SW
  const rz = (-dx * 0.454 + dz * 0.891) / 0.82;
  let d = Math.hypot(rx, rz);
  d += lakeShapeNoise.noise(x / 110, z / 110) * 13;
  d += lakeShapeNoise.noise(x / 37 + 7.3, z / 37 - 2.1) * 5;
  return Math.max(d, 0);
}

// Single source of truth for ground height.
export function getHeight(x, z) {
  // Rolling forest hills
  let h = 0;
  const lowFreq = heightNoise.noise(x / 150, z / 150) * 6.0;
  h += lowFreq;
  h += heightNoise.noise(x / 45, z / 45) * 1.5;
  h += heightNoise.noise(x / 12, z / 12) * 0.3;

  // Wheat plain (Phase 18): the field flattens toward a gently rolling
  // version of the low-frequency term — farmland, not a snooker table.
  const wheat = getWheat(x, z);
  if (wheat > 0) {
    h = lerp(h, lowFreq * 0.3 + 1.4, wheat * 0.9);
  }


  // Western mountain range (Phase 17, replaces the old east range): a polar
  // ridge band hugging the west rim. Amplitude keeps rising past the world
  // boundary to the mesh edge, so from inside the massif never visibly ends.
  // Ridged noise (1 - |n|) for sharp crests, like the old range.
  const dist = Math.hypot(x, z);
  if (dist > 210) {
    // Angle from due west (0 = straight west, grows toward N/S).
    const theta = Math.atan2(z, -x);
    // Ragged angular taper: full massif within ~±50 deg, noise-warped fade
    // to ~±80 deg — the ends crumble into foothills, no sharp "horns".
    const edgeWarp = heightNoise.noise(theta * 2.3 + 7.1, dist / 240) * 0.25;
    const aMask = 1 - smoothstep(0.85, 1.4, Math.abs(theta) + edgeWarp);
    if (aMask > 0) {
      // Inner edge warped per angle -> rocky spurs and valleys cut into the
      // lowland instead of a clean circular wall. (Phase 38: rescaled to
      // the 420 m rim — still rising past it, the off-map illusion holds.)
      const rIn = 300 + heightNoise.noise(theta * 3.1 + 3.3, 0.5) * 45;
      const radial = smoothstep(rIn, rIn + 95, dist);
      const ridge1 = 1 - Math.abs(heightNoise.noise(x / 170, z / 170));
      const ridge2 = 1 - Math.abs(heightNoise.noise(x / 68 + 9.7, z / 68 - 3.1));
      const a = aMask * radial;
      h += a * (Math.pow(ridge1, 1.6) * 80 + ridge2 * 14 + 12);
      // Low ridged skirt spilling inward of the main wall.
      h += aMask * (1 - radial) * smoothstep(rIn - 90, rIn, dist) * ridge2 * 9;
    }
  }

  // Discrete foothills scattered off the range — the taper into the forest.
  if (x < -100) {
    for (const [fx, fz, fh, fr] of FOOTHILLS) {
      const dx = x - fx;
      const dz = z - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 < fr * fr * 4) h += fh * Math.exp(-d2 / (fr * fr));
    }
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

  // Island (Phase 20): a flat-topped bump in the basin toward the northeast
  // shore, ~22 m across, crest ~2-3 m above the waterline. Edge radius is
  // noise-wobbled so the outline is ragged, not a perfect circle. Placed
  // AFTER the basin block (the beach min() would flatten it otherwise);
  // vegetation, physics, and the analytic-depth foam ring pick it up free.
  const islandR = Math.hypot(x - (LAKE_X + 38), z - (LAKE_Z + 32));
  if (islandR < 45) {
    const wob = 1 + 0.25 * heightNoise.noise(x / 8, z / 8);
    h += 11 * (1 - smoothstep(6, 22, islandR * wob));
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

  // Chunked terrain (perf batch, 2026-06-11): 8x8 chunks instead of one
  // world-spanning mesh, so frustum culling can drop what's behind/beside
  // the camera (a single 768² mesh was ~1.2 M tris drawn in EVERY pass).
  // Normals come from grid central differences — identical math for the
  // border vertices of adjacent chunks, so the seams are invisible
  // (computeVertexNormals per chunk would crease them).
  const CHUNKS = 8;
  const seg = n / CHUNKS; // 96 segments per chunk
  const vw = seg + 1;

  const gh = (ix, iz) =>
    grid.heights[
      THREE.MathUtils.clamp(iz, 0, n) * (n + 1) + THREE.MathUtils.clamp(ix, 0, n)
    ];

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
      attribute float aSnow;
      varying float vRock;
      varying float vSnow;
      ` +
      shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vRock = aRock;
        vSnow = aSnow;`
      );

    shader.fragmentShader =
      `
      uniform sampler2D rockMap;
      varying float vRock;
      varying float vSnow;
      ` +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec4 floorColor = texture2D(map, vMapUv);
        vec4 rockColor = texture2D(rockMap, vMapUv * 0.2);
        diffuseColor *= mix(floorColor, rockColor, vRock);
        // Snow above the Phase 17 range's snow line (slope-masked attribute).
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.91, 0.93, 0.96), vSnow);
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

  // --- Build the 8x8 chunk meshes (shared material, world-space vertices).
  const group = new THREE.Group();
  group.name = 'terrain';

  for (let ccz = 0; ccz < CHUNKS; ccz++) {
    for (let ccx = 0; ccx < CHUNKS; ccx++) {
      const positions = new Float32Array(vw * vw * 3);
      const normals = new Float32Array(vw * vw * 3);
      const uvs = new Float32Array(vw * vw * 2);
      const colors = new Float32Array(vw * vw * 3);
      const rockBlend = new Float32Array(vw * vw);
      const snowBlend = new Float32Array(vw * vw);
      const indices = new Uint32Array(seg * seg * 6);

      for (let lz = 0; lz < vw; lz++) {
        const giz = ccz * seg + lz;
        const z = (giz / n - 0.5) * WORLD_SIZE;
        for (let lx = 0; lx < vw; lx++) {
          const gix = ccx * seg + lx;
          const x = (gix / n - 0.5) * WORLD_SIZE;
          const v = lz * vw + lx;
          const h = gh(gix, giz);

          positions[v * 3 + 0] = x;
          positions[v * 3 + 1] = h;
          positions[v * 3 + 2] = z;

          // Smooth normal from grid central differences (seam-free).
          const dhdx = (gh(gix + 1, giz) - gh(gix - 1, giz)) / (2 * grid.step);
          const dhdz = (gh(gix, giz + 1) - gh(gix, giz - 1)) / (2 * grid.step);
          const invLen = 1 / Math.hypot(dhdx, 1, dhdz);
          normals[v * 3 + 0] = -dhdx * invLen;
          normals[v * 3 + 1] = invLen;
          normals[v * 3 + 2] = -dhdz * invLen;

          // Continuous global UVs (the textures tile via repeat).
          uvs[v * 2 + 0] = gix / n;
          uvs[v * 2 + 1] = 1 - giz / n;

          // Macro tint: darker earthy patches vs lighter mossy ones.
          const t = getTint(x, z);
          const shade = 0.72 + t * 0.42;
          let cr = shade * 0.98;
          let cg = shade;
          let cb = shade * 0.92;
          // Biome tints (Phase 18): dry gold in the wheat field, darker
          // floor under the deep forest east. Height backstop (2026-06-11):
          // gold fades out above ~4 m so rises inside the mask's fade band
          // (foothill skirts) keep forest-floor ground — the field interior
          // (flattened to <= ~3.7 m) keeps full gold.
          const wheat = getWheat(x, z) * (1 - smoothstep(4.0, 7.0, h));
          if (wheat > 0) {
            const g = 1.0 + t * 0.3; // golden, still tint-varied
            cr = lerp(cr, g * 1.32, wheat * 0.95);
            cg = lerp(cg, g * 1.06, wheat * 0.95);
            cb = lerp(cb, g * 0.52, wheat * 0.95);
          }
          const deep = getDeepForest(x, z);
          if (deep > 0) {
            const dk = 1 - 0.22 * deep;
            cr *= dk;
            cg *= dk;
            cb *= dk;
          }
          // World-tree clearing (Phase 39): bare packed earth at the trunk,
          // blending back to field gold past the dripline. AFTER the wheat
          // tint so it overrides the gold.
          const clearing = getWorldTreeClearing(x, z);
          if (clearing > 0) {
            // v8 giant mask reaches ~52 m — keep bare earth to the root
            // zone (~25 m) and let wheat thin across the outer dripline.
            const earth = smoothstep(0.6, 0.92, clearing);
            cr = lerp(cr, 0.6 + t * 0.12, earth);
            cg = lerp(cg, 0.47 + t * 0.1, earth);
            cb = lerp(cb, 0.34 + t * 0.08, earth);
          }
          colors[v * 3 + 0] = cr;
          colors[v * 3 + 1] = cg;
          colors[v * 3 + 2] = cb;

          // Rock shows where it's steep or high (cliffs, upper mountains).
          const slope = Math.hypot(dhdx, dhdz);
          rockBlend[v] = THREE.MathUtils.clamp(
            smoothstep(0.5, 0.95, slope) + smoothstep(26, 48, h) * 0.85,
            0,
            1
          );

          // Snow (Phase 17): settles on flat-ish faces above ~55 m; cliffs
          // shed it. Terrain noise keeps the snow line naturally irregular.
          snowBlend[v] =
            smoothstep(52, 64, h) * (1 - smoothstep(0.55, 0.85, slope));
        }
      }

      let ii = 0;
      for (let lz = 0; lz < seg; lz++) {
        for (let lx = 0; lx < seg; lx++) {
          const a = lz * vw + lx;
          const b = a + 1;
          const c = a + vw;
          const d = c + 1;
          indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
          indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('aRock', new THREE.BufferAttribute(rockBlend, 1));
      geometry.setAttribute('aSnow', new THREE.BufferAttribute(snowBlend, 1));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      group.add(mesh);
    }
  }

  return group;
}
