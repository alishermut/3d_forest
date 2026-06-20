// Voxelcraft — Phase 7: surface rules.
//
// Determines the surface block stack (top + sub-surface + transition-to-
// stone) for a given (biome, height, seaLevel, neighborBiome) context. Used by
// the generator to lay blocks on top of the stone column.
//
// Rules:
//   - Beaches auto-detect: any land biome at height 60..66 (near sea level)
//     gets sand instead of grass, so ocean shorelines always have beaches
//     even when the biome map says FOREST.
//   - Deserts have deep sand (4) + sandstone (3) before stone.
//   - Plains/forest/swamp have dirt (3-4) before stone.
//   - Mountains show stone at high altitude (above Y=80) and thin dirt below.
//   - Snowy biomes get a snow block top + dirt under.
//   - Taiga gets grass top + dirt (darker, but same block for now).
//   - Underwater floors: sand (ocean/beach) or dirt (other biomes).

import { BLOCK } from '../engine/blocks.js';
import { BIOME } from './biomes.js';
import { SEA_LEVEL } from '../engine/world.js';

// Returns { top, sub, subDepth, beachOverride } for a given context.
// `beachOverride` is true when we force sand on a land biome near sea level.
export function surfaceRules(biome, height, isShoreline) {
  // Auto-beach: land near sea level gets sand.
  const nearShore = isShoreline || (height >= SEA_LEVEL - 2 && height <= SEA_LEVEL + 4);

  switch (biome) {
    case BIOME.OCEAN:
      return { top: BLOCK.SAND, sub: BLOCK.SAND, subDepth: 4, underwater: true };
    case BIOME.BEACH:
      return { top: BLOCK.SAND, sub: BLOCK.SAND, subDepth: 4 };
    case BIOME.DESERT:
      // Deep sand + sandstone transition.
      return { top: BLOCK.SAND, sub: BLOCK.SAND, subDepth: 4, transition: BLOCK.SANDSTONE, transDepth: 3 };
    case BIOME.SNOWY:
      return { top: BLOCK.SNOW, sub: BLOCK.DIRT, subDepth: 3 };
    case BIOME.TAIGA:
      return { top: BLOCK.GRASS, sub: BLOCK.DIRT, subDepth: 3 };
    case BIOME.MOUNTAINS:
      // High mountains: stone breaks through above Y=80; thin dirt below.
      if (height > 80) return { top: BLOCK.STONE, sub: BLOCK.STONE, subDepth: 0 };
      return { top: BLOCK.GRASS, sub: BLOCK.DIRT, subDepth: 2 };
    case BIOME.SWAMP:
      return { top: BLOCK.DIRT, sub: BLOCK.DIRT, subDepth: 4 };
    case BIOME.SAVANNA:
      return { top: BLOCK.GRASS, sub: BLOCK.DIRT, subDepth: 2 };
    case BIOME.JUNGLE:
      return { top: BLOCK.GRASS, sub: BLOCK.DIRT, subDepth: 4 };
    case BIOME.PLAINS:
    case BIOME.FOREST:
    default:
      // Auto-beach near shorelines.
      if (nearShore && height <= SEA_LEVEL + 2) {
        return { top: BLOCK.SAND, sub: BLOCK.SAND, subDepth: 3 };
      }
      return { top: BLOCK.GRASS, sub: BLOCK.DIRT, subDepth: 4 };
  }
}

// Bedrock pattern at a given (x, y, z) within the bottom 5 layers.
// Deterministic: uses a simple hash of (x,y,z) so the pattern is reproducible
// across chunk regenerations. Bottom layer (y=WORLD_MIN_Y) is always bedrock;
// above that, probability decreases with height.
import { WORLD_MIN_Y } from '../engine/world.js';

export function isBedrock(x, y, z) {
  if (y === WORLD_MIN_Y) return true;
  const layer = y - WORLD_MIN_Y; // 0..4
  if (layer > 4) return false;
  // Probability decreases with height: layer 1 = 75%, 2 = 50%, 3 = 25%, 4 = 5%.
  const threshold = [1.0, 0.75, 0.5, 0.25, 0.05][layer];
  // Simple deterministic hash.
  const h = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
  const r = (h % 1000) / 1000;
  return r < threshold;
}
