// Voxelcraft — Phase 10: tree features.
//
// Places trees per biome during chunk generation (after ores, before
// compaction). Each (x,z) column gets a deterministic hash decision: if the
// hash falls below the biome's tree density, a tree is placed at the surface
// height, provided the canopy fits within the chunk (margin 2 from edges) and
// the surface block is appropriate (grass/dirt for most, sand for desert
// cacti).
//
// Tree shapes (classic MC):
//   Oak     — trunk 4-5, round canopy radius 2 (plains/forest)
//   Birch   — trunk 5-6, smaller round canopy (forest)
//   Spruce  — trunk 6-8, conical layered canopy (taiga/snowy)
//   Jungle  — trunk 8-10, large canopy (jungle)
//   Acacia  — trunk 4-5, flat wide canopy (savanna)
//   Cactus  — 1-3 tall column (desert)
//
// Determinism: all randomness derives from a position hash (wx, wz, salt) so
// chunk regeneration is reproducible. Trees only write within their own chunk
// (canopy clipped to chunk bounds; placement requires lx/lz in [2,13] so the
// canopy fits without ugly half-trees at borders).

import { BLOCK } from '../../engine/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../engine/world.js';
import { BIOME } from '../biomes.js';

// Tree density per biome (probability per surface column). Calibrated to real
// Minecraft per-chunk tree counts (256 columns/chunk): plains ~1, forest ~7,
// taiga ~6, jungle ~36. v1 was ~3-5x too dense; these match vanilla.
const TREE_DENSITY = {
  [BIOME.PLAINS]: 0.005,    //  ~1   tree/chunk
  [BIOME.FOREST]: 0.050,    //  ~7   trees/chunk
  [BIOME.TAIGA]: 0.024,     //  ~6   trees/chunk
  [BIOME.SNOWY]: 0.024,     //  ~5   trees/chunk
  [BIOME.JUNGLE]: 0.190,    // ~25   trees/chunk (dense — vanilla feel)
  [BIOME.SAVANNA]: 0.004,   //  ~1   tree/chunk
  [BIOME.SWAMP]: 0.012,     //  ~2   trees/chunk
  [BIOME.MOUNTAINS]: 0.004, //  ~1   tree/chunk
  [BIOME.DESERT]: 0.0,      // desert uses cacti, not trees
  [BIOME.BEACH]: 0.0,
  [BIOME.OCEAN]: 0.0,
};

// Deterministic hash → 0..1. `salt` varies per feature type to decorrelate
// trees from plants at the same position.
function hash01(wx, wz, salt) {
  let h = (wx * 73856093) ^ (wz * 83492791) ^ (salt * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h % 100000) / 100000;
}

// Set a block in the column at world Y (local helper, same as generator's).
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

// Place all trees + cacti in a chunk column. Called after ores, before compact.
// `surfaceY` is a function (wx, wz) → surface height (top solid block Y).
// `exclusionZones` (optional) is an array of { wx, wz, radius } — a tree whose
// trunk falls within `radius` (world blocks) of any zone center is skipped,
// producing a natural clearing around structures (villages).
export function placeTrees(col, cx, cz, bm, surfaceY, exclusionZones = []) {
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const biome = bm.getBiome(wx, wz);
      const density = TREE_DENSITY[biome] || 0;

      if (biome === BIOME.DESERT) {
        // Cacti: 3% chance, 1-3 tall.
        if (hash01(wx, wz, 777) < 0.03) {
          tryCactus(col, lx, lz, surfaceY(wx, wz), wx, wz);
        }
        continue;
      }

      if (density <= 0) continue;

      // Tree: requires canopy margin (lx, lz in [2, 13]).
      if (lx < 2 || lx > 13 || lz < 2 || lz > 13) continue;
      if (hash01(wx, wz, 42) >= density) continue;

      const height = surfaceY(wx, wz);
      if (height <= 62) continue; // don't place trees underwater
      const surface = getLocal(col, lx, height, lz);
      // Must be on grass/dirt (or snow on top of grass).
      if (surface !== BLOCK.GRASS && surface !== BLOCK.DIRT && surface !== BLOCK.SNOW) continue;

      const treeType = pickTreeType(biome, wx, wz);

      // Skip trees that fall inside any structure's clearing zone.
      if (inExclusionZone(wx, wz, exclusionZones)) continue;

      // NOTE: no minimum-spacing grid scan. The per-position density hash
      // already distributes trees in a Poisson-like pattern, and a grid-based
      // spacing check over-rejected dense biomes (taiga/jungle dropped to
      // ~0.1-6/chunk) because each tall trunk blocks all 8 neighbors. Density
      // calibration (TREE_DENSITY) is the sole control on count; clumps are
      // rare at these densities and acceptable when they occur.

      placeTree(col, lx, lz, height, treeType, wx, wz);
    }
  }
}

// Is (wx, wz) within any structure clearing zone? Trees inside a zone are
// skipped so structures sit in natural clearings.
function inExclusionZone(wx, wz, zones) {
  for (const z of zones) {
    const dx = wx - z.wx;
    const dz = wz - z.wz;
    if (dx * dx + dz * dz <= z.radius * z.radius) return true;
  }
  return false;
}

function pickTreeType(biome, wx, wz) {
  switch (biome) {
    case BIOME.FOREST:
      return hash01(wx, wz, 99) < 0.5 ? 'oak' : 'birch';
    case BIOME.TAIGA:
    case BIOME.SNOWY:
      return 'spruce';
    case BIOME.JUNGLE:
      return 'jungle';
    case BIOME.SAVANNA:
      return 'acacia';
    default:
      return 'oak';
  }
}

function placeTree(col, lx, lz, surfaceY, type, wx, wz) {
  const trunkH = trunkHeight(type, wx, wz);
  const logBlock = logBlockFor(type);
  const leafBlock = leafBlockFor(type);
  const topY = surfaceY + 1;

  // Trunk.
  for (let i = 0; i < trunkH; i++) {
    setLocal(col, lx, topY + i, lz, logBlock);
  }

  // Canopy.
  const canopyBase = topY + trunkH - 2; // leaves start 2 below trunk top
  switch (type) {
    case 'oak':
    case 'birch':
      canopyRound(col, lx, canopyBase, lz, 2, leafBlock, trunkH);
      break;
    case 'jungle':
      canopyRound(col, lx, canopyBase, lz, 2, leafBlock, trunkH);
      // Extra layer higher up for fuller jungle canopy.
      canopyLayer(col, lx, topY + trunkH, lz, 1, leafBlock);
      break;
    case 'acacia':
      canopyFlat(col, lx, canopyBase, lz, 2, leafBlock, trunkH);
      break;
    case 'spruce':
      canopyConical(col, lx, topY, lz, trunkH, leafBlock);
      break;
  }
}

function trunkHeight(type, wx, wz) {
  const r = hash01(wx, wz, 314);
  switch (type) {
    // Trunks raised +1-2 vs v1 so the lowest leaf layer sits above the player's
    // ~1.8 m head — you can walk under every tree type without colliding with
    // the (solid) leaves.
    case 'oak': return 5 + Math.floor(r * 3);       // 5-7
    case 'birch': return 7 + Math.floor(r * 3);     // 7-9
    case 'spruce': return 8 + Math.floor(r * 5);    // 8-12
    case 'jungle': return 10 + Math.floor(r * 4);   // 10-13
    case 'acacia': return 5 + Math.floor(r * 3);    // 5-7
    default: return 5;
  }
}

function logBlockFor(type) {
  switch (type) {
    case 'oak': return BLOCK.WOOD_LOG;
    case 'birch': return BLOCK.BIRCH_LOG;
    case 'spruce': return BLOCK.SPRUCE_LOG;
    case 'jungle': return BLOCK.JUNGLE_LOG;
    case 'acacia': return BLOCK.ACACIA_LOG;
    default: return BLOCK.WOOD_LOG;
  }
}

function leafBlockFor(type) {
  switch (type) {
    case 'oak': return BLOCK.LEAVES;
    case 'birch': return BLOCK.BIRCH_LEAVES;
    case 'spruce': return BLOCK.SPRUCE_LEAVES;
    case 'jungle': return BLOCK.JUNGLE_LEAVES;
    case 'acacia': return BLOCK.ACACIA_LEAVES;
    default: return BLOCK.LEAVES;
  }
}

// Round canopy: layers of decreasing radius. Top of trunk gets a small cap.
function canopyRound(col, lx, baseY, lz, radius, leaf, trunkH) {
  for (let dy = -1; dy <= 1; dy++) {
    const r = dy === 1 ? radius - 1 : radius;
    canopyLayer(col, lx, baseY + dy, lz, r, leaf);
  }
  // Top cap.
  setLocal(col, lx, baseY + 2, lz, leaf);
}

// Flat canopy (acacia): wide, 1-2 layers.
function canopyFlat(col, lx, baseY, lz, radius, leaf, trunkH) {
  canopyLayer(col, lx, baseY, lz, radius, leaf);
  canopyLayer(col, lx, baseY + 1, lz, radius - 1, leaf);
}

// Conical canopy (spruce): stacked layers in the UPPER ~60% of the trunk,
// leaving the bottom bare so you can walk under. Layers shrink toward the top
// and end with a spire one block above the trunk.
function canopyConical(col, lx, topY, lz, trunkH, leaf) {
  const trunkTop = topY + trunkH;       // top log
  const layers = 4;
  // Anchor the bottom layer at ~40% up the trunk (clear headroom below).
  const startLayer = topY + Math.ceil(trunkH * 0.4);
  let r = 2;
  for (let layer = 0; layer < layers; layer++) {
    const ly = startLayer + layer * 2;
    if (ly >= trunkTop) break;
    canopyLayer(col, lx, ly, lz, r, leaf);
    if (r > 0) r--;
  }
  // Top spire one block above the trunk.
  setLocal(col, lx, trunkTop + 1, lz, leaf);
}

// Place a single square layer of leaves at radius `r` around (lx, y, lz),
// skipping the center (trunk) and corners for a rounder shape.
function canopyLayer(col, lx, y, lz, r, leaf) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx === 0 && dz === 0) continue; // skip trunk
      // Round corners: skip the 4 outer corners.
      if (Math.abs(dx) === r && Math.abs(dz) === r) {
        // 50% skip for softer corners (deterministic per cell).
        const h = ((lx + dx) * 31 + (lz + dz) * 17 + y * 7) & 7;
        if (h < 4) continue;
      }
      setLocal(col, lx + dx, y, lz + dz, leaf);
    }
  }
}

// Cactus: 1-3 tall column on sand.
function tryCactus(col, lx, lz, surfaceY, wx, wz) {
  const surface = getLocal(col, lx, surfaceY, lz);
  if (surface !== BLOCK.SAND) return;
  const h = 1 + Math.floor(hash01(wx, wz, 555) * 3); // 1..3
  for (let i = 1; i <= h; i++) {
    setLocal(col, lx, surfaceY + i, lz, BLOCK.CACTUS);
  }
}

export { TREE_DENSITY };
