// Voxelcraft — Phase 9: ore distribution.
//
// Replaces STONE/DEEPSLATE cells with ore blocks based on 3D noise + a
// triangular Y distribution per ore (peak density at `peak`, tapering to 0 at
// the yMin/yMax edges). Each ore has its own noise generator (seeded) so ores
// don't overlap. Below Y=8 the deepslate variant is used (matching MC 1.18+).
//
// Distribution table (from minecraft.wiki, locked in PLAN.md):
//   Coal      Y  0..320  peak  45
//   Copper    Y -16..112 peak  43
//   Lapis     Y -64..64  peak  -2
//   Iron      Y -64..72  peak  14
//   Gold      Y -64..32  peak -18
//   Redstone  Y -64..16  peak -59
//   Diamond   Y -64..16  peak -59
//   Emerald   Y -16..320 peak  85   (Mountains biome only)
//
// Called AFTER caves, BEFORE compaction. Only STONE and DEEPSLATE are
// replaced — surface blocks, bedrock, water, lava, and air are untouched.

import { BLOCK } from '../engine/blocks.js';
import { Noise3D } from '../engine/noise.js';
import { WORLD_MIN_Y } from '../engine/world.js';
import { BIOME } from './biomes.js';

const DEEPSLATE_Y = 8; // worldY < 8 → deepslate variant

// Ore config. `threshold` is the noise value (0..1) above which an ore
// appears at peak Y; it rises by `margin` toward the yMin/yMax edges, making
// ores rarer away from peak. `scale` is the noise frequency (higher = smaller
// blobs). `biome` restricts the ore to a biome (emerald → Mountains).
const ORES = [
  { id: 'coal',     yMin: 0,   yMax: 320, peak: 45,  threshold: 0.82, margin: 0.10, scale: 0.09,
    normal: BLOCK.COAL_ORE,            deepslate: BLOCK.DEEPSLATE_COAL_ORE },
  { id: 'iron',     yMin: -64, yMax: 72,  peak: 14,  threshold: 0.84, margin: 0.10, scale: 0.10,
    normal: BLOCK.IRON_ORE,            deepslate: BLOCK.DEEPSLATE_IRON_ORE },
  { id: 'copper',   yMin: -16, yMax: 112, peak: 43,  threshold: 0.86, margin: 0.08, scale: 0.11,
    normal: BLOCK.COPPER_ORE,          deepslate: BLOCK.DEEPSLATE_COPPER_ORE },
  { id: 'lapis',    yMin: -64, yMax: 64,  peak: -2,  threshold: 0.87, margin: 0.08, scale: 0.10,
    normal: BLOCK.LAPIS_ORE,           deepslate: BLOCK.DEEPSLATE_LAPIS_ORE },
  { id: 'gold',     yMin: -64, yMax: 32,  peak: -18, threshold: 0.89, margin: 0.07, scale: 0.11,
    normal: BLOCK.GOLD_ORE,            deepslate: BLOCK.DEEPSLATE_GOLD_ORE },
  { id: 'redstone', yMin: -64, yMax: 16,  peak: -59, threshold: 0.85, margin: 0.06, scale: 0.11,
    normal: BLOCK.REDSTONE_ORE,        deepslate: BLOCK.DEEPSLATE_REDSTONE_ORE },
  { id: 'diamond',  yMin: -64, yMax: 16,  peak: -59, threshold: 0.91, margin: 0.05, scale: 0.13,
    normal: BLOCK.DIAMOND_ORE,         deepslate: BLOCK.DEEPSLATE_DIAMOND_ORE },
  { id: 'emerald',  yMin: -16, yMax: 320, peak: 85,  threshold: 0.87, margin: 0.10, scale: 0.14,
    normal: BLOCK.EMERALD_ORE,         deepslate: BLOCK.DEEPSLATE_EMERALD_ORE,
    biome: BIOME.MOUNTAINS },
];

// One seeded Noise3D per ore (lazy-init, cached).
const _noise = {};
function getOreNoise(id, seed = 1337) {
  if (!_noise[id]) {
    _noise[id] = new Noise3D(seed + hashStr(id));
  }
  return _noise[id];
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Triangular density: 1 at peak, 0 at edges. Returns 0..1.
function densityAt(y, ore) {
  const halfRange = Math.max(1, (ore.yMax - ore.yMin) / 2);
  const dist = Math.abs(y - ore.peak);
  return Math.max(0, 1 - dist / halfRange);
}

// Place ores + convert STONE → DEEPSLATE below Y=8. Mutates the column.
// `bm` is the BiomeMap (for emerald biome restriction).
export function placeOres(col, cx, cz, bm) {
  // --- Pass 1: deepslate conversion (STONE → DEEPSLATE for worldY < 8) ---
  for (let s = 0; s < col.subs.length; s++) {
    const oy = WORLD_MIN_Y + s * 16;
    if (oy >= DEEPSLATE_Y) break; // sub-chunk starts at/above Y=8 → no deepslate
    const sc = col.subs[s];
    const topY = oy + 15;
    // Fast path: entirely-below-8 uniform stone → bulk fill.
    if (topY < DEEPSLATE_Y && sc.isUniform() && sc.palette[0] === BLOCK.STONE) {
      sc.fill(BLOCK.DEEPSLATE);
      continue;
    }
    // Mixed or non-uniform: walk cells with worldY < 8.
    const limitLy = Math.min(15, DEEPSLATE_Y - 1 - oy); // inclusive local Y cap
    for (let lx = 0; lx < 16; lx++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let ly = 0; ly <= limitLy; ly++) {
          if (sc.get(lx, ly, lz) === BLOCK.STONE) {
            sc.set(lx, ly, lz, BLOCK.DEEPSLATE);
          }
        }
      }
    }
  }

  // --- Pass 2: ore placement per ore type ---
  for (const ore of ORES) {
    // Sub-chunk index range overlapping [yMin, yMax].
    const yMinSub = Math.max(0, Math.floor((ore.yMin - WORLD_MIN_Y) / 16));
    const yMaxSub = Math.min(col.subs.length - 1, Math.floor((ore.yMax - WORLD_MIN_Y) / 16));
    const noise = getOreNoise(ore.id);

    for (let s = yMinSub; s <= yMaxSub; s++) {
      const sc = col.subs[s];
      const oy = WORLD_MIN_Y + s * 16;
      // Skip all-air sub-chunks (above surface).
      if (sc.isUniform() && sc.palette[0] === BLOCK.AIR) continue;
      // Skip all-water sub-chunks.
      if (sc.isUniform() && sc.palette[0] === BLOCK.WATER) continue;

      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const wx = cx * 16 + lx;
          const wz = cz * 16 + lz;

          // Biome restriction (emerald): skip this column if not Mountains.
          if (ore.biome !== undefined) {
            if (bm.getBiome(wx, wz) !== ore.biome) continue;
          }

          for (let ly = 0; ly < 16; ly++) {
            const worldY = oy + ly;
            if (worldY < ore.yMin || worldY > ore.yMax) continue;
            const id = sc.get(lx, ly, lz);
            if (id !== BLOCK.STONE && id !== BLOCK.DEEPSLATE) continue;

            // 1 octave: ores are small scattered blobs that don't need fractal
            // detail. Halves the per-cell noise cost (ore placement was ~half of
            // total column-gen time at 2 octaves).
            const n = noise.fractal(wx, worldY, wz, 1, 0.5, 2, ore.scale);
            const density = densityAt(worldY, ore);
            const t = ore.threshold + (1 - density) * ore.margin;
            if (n > t) {
              const block = worldY < DEEPSLATE_Y ? ore.deepslate : ore.normal;
              sc.set(lx, ly, lz, block);
            }
          }
        }
      }
    }
  }
}

// Exposed for tests/debug.
export { ORES, DEEPSLATE_Y };
