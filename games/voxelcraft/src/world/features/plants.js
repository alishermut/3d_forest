// Voxelcraft — Phase 10: plant features.
//
// Places small plants (tall grass, ferns, flowers, dead bushes) on the
// surface per biome. All plants are cross-shaped blocks (X model, non-solid,
// transparent). Placement is deterministic via a position hash so chunk
// regeneration is reproducible.
//
// Plant rules per biome:
//   Plains     — tall grass (common), dandelion, poppy
//   Forest     — tall grass, fern, dandelion, poppy
//   Taiga      — fern (common), tall grass (rare)
//   Snowy      — sparse, none (snow covers)
//   Jungle     — tall grass (dense), fern
//   Savanna    — tall grass, dead bush
//   Desert     — dead bush (rare)
//   Swamp      — tall grass, fern
//   Mountains  — tall grass (sparse)
//   Beach/Ocean— none
//
// Plants only place on grass/dirt surface blocks above sea level. They are
// skipped if a tree already occupies the column (checked by reading the cell
// above the surface — if it's a log/leaves, skip).

import { BLOCK } from '../../engine/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, SEA_LEVEL } from '../../engine/world.js';
import { BIOME } from '../biomes.js';

function hash01(wx, wz, salt) {
  let h = (wx * 73856093) ^ (wz * 83492791) ^ (salt * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h % 100000) / 100000;
}

function setLocal(col, lx, worldY, lz, id) {
  if (worldY < WORLD_MIN_Y || worldY > WORLD_MAX_Y) return;
  const rel = worldY - WORLD_MIN_Y;
  const s = rel >>> 4;
  const ly = rel & 15;
  col.subs[s].set(lx, ly, lz, id);
}

function getLocal(col, lx, worldY, lz) {
  if (worldY < WORLD_MIN_Y || worldY > WORLD_MAX_Y) return BLOCK.AIR;
  const rel = worldY - WORLD_MIN_Y;
  const s = rel >>> 4;
  const ly = rel & 15;
  return col.subs[s].get(lx, ly, lz);
}

// Plant table: each biome has a list of { block, weight } entries. The total
// density determines how often a plant appears at all; weights split the type.
const PLANT_TABLE = {
  [BIOME.PLAINS]: [
    { block: BLOCK.TALL_GRASS, weight: 0.6 },
    { block: BLOCK.DANDELION, weight: 0.2 },
    { block: BLOCK.POPPY, weight: 0.2 },
  ],
  [BIOME.FOREST]: [
    { block: BLOCK.TALL_GRASS, weight: 0.45 },
    { block: BLOCK.FERN, weight: 0.25 },
    { block: BLOCK.DANDELION, weight: 0.15 },
    { block: BLOCK.POPPY, weight: 0.15 },
  ],
  [BIOME.TAIGA]: [
    { block: BLOCK.FERN, weight: 0.7 },
    { block: BLOCK.TALL_GRASS, weight: 0.3 },
  ],
  [BIOME.SNOWY]: [
    { block: BLOCK.TALL_GRASS, weight: 1.0 },
  ],
  [BIOME.JUNGLE]: [
    { block: BLOCK.TALL_GRASS, weight: 0.6 },
    { block: BLOCK.FERN, weight: 0.4 },
  ],
  [BIOME.SAVANNA]: [
    { block: BLOCK.TALL_GRASS, weight: 0.5 },
    { block: BLOCK.DEAD_BUSH, weight: 0.5 },
  ],
  [BIOME.DESERT]: [
    { block: BLOCK.DEAD_BUSH, weight: 1.0 },
  ],
  [BIOME.SWAMP]: [
    { block: BLOCK.TALL_GRASS, weight: 0.5 },
    { block: BLOCK.FERN, weight: 0.5 },
  ],
  [BIOME.MOUNTAINS]: [
    { block: BLOCK.TALL_GRASS, weight: 1.0 },
  ],
};

// Overall plant density per biome (probability per surface column). Trimmed
// ~0.7x vs v1 to keep grass visible without the cluttered look (trees were the
// main offender; plants toned down for consistency).
const PLANT_DENSITY = {
  [BIOME.PLAINS]: 0.20,
  [BIOME.FOREST]: 0.18,
  [BIOME.TAIGA]: 0.16,
  [BIOME.SNOWY]: 0.04,
  [BIOME.JUNGLE]: 0.30,
  [BIOME.SAVANNA]: 0.14,
  [BIOME.DESERT]: 0.03,
  [BIOME.SWAMP]: 0.22,
  [BIOME.MOUNTAINS]: 0.10,
  [BIOME.BEACH]: 0.0,
  [BIOME.OCEAN]: 0.0,
};

// Place all plants in a chunk column. Called after trees (so tree trunks/leaves
// are already placed and can be checked). `surfaceY` is a function (wx, wz) →
// surface height.
export function placePlants(col, cx, cz, bm, surfaceY) {
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const biome = bm.getBiome(wx, wz);
      const density = PLANT_DENSITY[biome] || 0;
      if (density <= 0) continue;

      if (hash01(wx, wz, 88) >= density) continue;

      const height = surfaceY(wx, wz);
      if (height <= SEA_LEVEL) continue; // no plants underwater

      const surface = getLocal(col, lx, height, lz);
      if (surface !== BLOCK.GRASS && surface !== BLOCK.DIRT) continue;

      // Don't place a plant where a tree trunk already is.
      const above = getLocal(col, lx, height + 1, lz);
      if (above !== BLOCK.AIR) continue;

      const table = PLANT_TABLE[biome];
      if (!table || table.length === 0) continue;

      const plant = pickPlant(table, wx, wz);
      setLocal(col, lx, height + 1, lz, plant);
    }
  }
}

function pickPlant(table, wx, wz) {
  const r = hash01(wx, wz, 123);
  let acc = 0;
  for (const entry of table) {
    acc += entry.weight;
    if (r < acc) return entry.block;
  }
  return table[0].block;
}

export { PLANT_DENSITY, PLANT_TABLE };
