// Voxelcraft — Phase 7: world generator (terrain + biomes + surface rules).
//
// For each chunk column:
//   1. Look up the biome (BiomeMap).
//   2. Compute a base terrain height from continentality + hills + mountains.
//   3. Fill the entire column to stone (fast bulk fill).
//   4. Carve from the top down: air/water above `height`, then surface blocks
//      (top + sub-surface + optional sandstone transition) using surface.js
//      rules, then stone down to bedrock.
//   5. Bedrock floor: deterministic pattern (bottom layer solid, 4 layers of
//      decreasing density) via a position hash — NOT Math.random(), so chunk
//      regeneration is reproducible.
//
// Caves, ores, trees, and structures come in Phases 8–11. The per-column
// interface is unchanged from Phase 3 so the streamer doesn't need edits.

import { BLOCK } from '../engine/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, SEA_LEVEL } from '../engine/world.js';
import { BiomeMap, BIOME } from './biomes.js';
import { surfaceRules, isBedrock } from './surface.js';
import { carveCaves } from './caves.js';
import { placeOres } from './ores.js';
import { placeTrees } from './features/trees.js';
import { placePlants } from './features/plants.js';
import { placeVillage } from './structures/village.js';
import { placeDungeon } from './structures/dungeon.js';
import { computeColumnLight } from '../engine/lighting.js';

const BEDROCK_TOP = WORLD_MIN_Y + 4; // bedrock fills Y -64..-60

let _biomeMap = null;
export function getBiomeMap(seed = 1337) {
  if (!_biomeMap) _biomeMap = new BiomeMap(seed);
  return _biomeMap;
}

export const SURFACE_Y = 70; // approximate land surface (for spawn fallback)

export function generateColumn(world, cx, cz) {
  const col = world.getColumn(cx, cz);
  if (col.generated) return col;

  const bm = getBiomeMap();

  // Fast path: bulk-fill all sub-chunks to stone.
  for (let s = 0; s < col.subs.length; s++) col.subs[s].fill(BLOCK.STONE);

  // Second pass: per-column surface carving.
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const biome = bm.getBiome(wx, wz);
      const height = bm.getBaseHeight(wx, wz);

      // --- Bedrock floor (deterministic) ---
      for (let y = WORLD_MIN_Y; y <= BEDROCK_TOP; y++) {
        if (isBedrock(wx, y, wz)) {
          setLocal(col, lx, y, lz, BLOCK.BEDROCK);
        }
      }

      // --- Surface rules ---
      const isShoreline = isOceanAdjacent(bm, wx, wz);
      const rules = surfaceRules(biome, height, isShoreline);

      // --- Above height: air or water ---
      const isUnderwater = height < SEA_LEVEL;
      if (isUnderwater) col.hasWater = true; // gates the water-cave seal below
      for (let y = WORLD_MAX_Y; y > height; y--) {
        if (y <= SEA_LEVEL) {
          setLocal(col, lx, y, lz, BLOCK.WATER);
        } else {
          setLocal(col, lx, y, lz, BLOCK.AIR);
        }
      }

      // --- Top block ---
      setLocal(col, lx, height, lz, rules.top);

      // --- Sub-surface layers ---
      let y = height - 1;
      for (let i = 0; i < rules.subDepth && y > BEDROCK_TOP; i++, y--) {
        setLocal(col, lx, y, lz, rules.sub);
      }
      // Optional transition block (sandstone under desert sand).
      if (rules.transition) {
        for (let i = 0; i < rules.transDepth && y > BEDROCK_TOP; i++, y--) {
          setLocal(col, lx, y, lz, rules.transition);
        }
      }

      // --- Snow layer on snowy biomes (above ground) ---
      if (biome === BIOME.SNOWY && height > SEA_LEVEL) {
        // The top block is already SNOW (from surfaceRules). Place a snow
        // layer on adjacent exposed ground too — handled per-column, so just
        // ensure the top is snow. Done above.
      }

      // --- Gravel patches in deep ocean (rare) ---
      if (biome === BIOME.OCEAN && height < SEA_LEVEL - 10) {
        // Small chance of gravel on the ocean floor.
        const h = ((wx * 73856093) ^ (wz * 83492791)) >>> 0;
        if ((h % 100) < 10) {
          setLocal(col, lx, height, lz, BLOCK.GRAVEL);
        }
      }
    }
  }

  // Carve caves into the stone body (after surface, before compaction).
  carveCaves(col, cx, cz);

  // Seal cave faces that would expose water as a static "aquarium" wall: any
  // cave-air cell adjacent to water gets backed with stone. Caves near water
  // stay dry + walled instead of showing a see-through water pane; mining
  // through still releases the water via the runtime fluid sim. Only cells at or
  // below sea level are scanned, so the open ocean surface is never re-capped.
  // Gated on water presence (this column or a loaded neighbour) so the dry
  // inland majority pays nothing.
  if (col.hasWater || neighborHasWater(world, cx, cz)) {
    sealWaterCaves(world, cx, cz);
  }

  // Place ores + convert STONE → DEEPSLATE below Y=8 (after caves, before
  // compaction). Caves carved to AIR/LAVA are left untouched; only remaining
  // STONE/DEEPSLATE is eligible for ore replacement.
  placeOres(col, cx, cz, bm);

  // Place structures BEFORE features (matches Minecraft's worldgen pipeline:
  // the structure step runs before the decoration/feature step). Dungeons are
  // underground; villages report their house footprints as tree-exclusion
  // zones so trees carve natural clearings around them instead of clipping the
  // walls.
  const surfaceYFn = (wx, wz) => bm.getBaseHeight(wx, wz);
  placeDungeon(col, cx, cz);
  const exclusionZones = placeVillage(col, cx, cz, bm, surfaceYFn);

  // Place trees + plants (after structures). Trees skip any exclusion zone;
  // plants do NOT (grass/flowers filling the yard around a house is the
  // intended natural look).
  placeTrees(col, cx, cz, bm, surfaceYFn, exclusionZones);
  placePlants(col, cx, cz, bm, surfaceYFn);

  // Compact all sub-chunks: drop unused palette entries so homogeneous
  // sub-chunks (all-air above surface, all-stone underground) collapse to
  // single-value storage. This lets the mesher skip them entirely.
  for (let s = 0; s < col.subs.length; s++) col.subs[s].compact();

  // Compute lighting (skylight + block light) after all blocks are placed.
  computeColumnLight(col, cx, cz, world);

  col.generated = true;
  col.dirty = true;
  return col;
}

// Back every cave-air cell that touches water with stone, so caves carved into
// the side of a water body don't leave a see-through "aquarium" pane. Scans only
// y <= SEA_LEVEL (water never exists above it), which also guarantees the open
// ocean surface — the air at y = SEA_LEVEL+1 — is never filled. Cross-chunk
// neighbours are read through the world, so boundaries with already-loaded
// columns seal too (a face against a not-yet-generated column may seal when that
// neighbour generates).
// True if any of the 4 neighbour columns is already generated and holds water
// (so a dry coastal column still seals its cave faces against the sea).
function neighborHasWater(world, cx, cz) {
  const g = (dx, dz) => { const c = world.columns.get(world.key(cx + dx, cz + dz)); return !!(c && c.hasWater); };
  return g(1, 0) || g(-1, 0) || g(0, 1) || g(0, -1);
}

// Lowest Y the seal scans. Water only exists above the terrain at/below sea
// level, and ocean floors never approach this depth, so scanning below it would
// only waste time on solid stone.
const SEAL_MIN_Y = 0;

// Fill a single cell with stone if it is air AND its column is already loaded
// (never auto-create an ungenerated neighbour column).
function sealNeighborAir(world, gx, gy, gz) {
  const ncx = Math.floor(gx / 16);
  const ncz = Math.floor(gz / 16);
  if (!world.columns.has(world.key(ncx, ncz))) return;
  if (world.getBlock(gx, gy, gz) === BLOCK.AIR) world.setBlock(gx, gy, gz, BLOCK.STONE);
}

function sealWaterCaves(world, cx, cz) {
  const W = BLOCK.WATER;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      for (let y = SEA_LEVEL; y >= SEAL_MIN_Y; y--) {
        const b = world.getBlock(wx, y, wz);
        if (b === BLOCK.AIR) {
          // Own cave-air touching any water (this column or a loaded neighbour).
          if (
            world.getBlock(wx + 1, y, wz) === W || world.getBlock(wx - 1, y, wz) === W ||
            world.getBlock(wx, y, wz + 1) === W || world.getBlock(wx, y, wz - 1) === W ||
            world.getBlock(wx, y + 1, wz) === W || world.getBlock(wx, y - 1, wz) === W
          ) {
            world.setBlock(wx, y, wz, BLOCK.STONE);
          }
        } else if (b === W && (lx === 0 || lx === 15 || lz === 0 || lz === 15)) {
          // Own border water: seal cave-air across the chunk edge in an already-
          // loaded neighbour. Together with the air scan above, whichever of two
          // adjacent columns loads SECOND seals BOTH sides of their shared
          // boundary — so cross-chunk aquarium seams close as neighbours stream in.
          if (lx === 15) sealNeighborAir(world, wx + 1, y, wz);
          if (lx === 0)  sealNeighborAir(world, wx - 1, y, wz);
          if (lz === 15) sealNeighborAir(world, wx, y, wz + 1);
          if (lz === 0)  sealNeighborAir(world, wx, y, wz - 1);
        }
      }
    }
  }
}

// Check if any of the 4 neighbors is ocean (for auto-beach detection).
function isOceanAdjacent(bm, x, z) {
  return bm.getBiome(x + 1, z) === BIOME.OCEAN ||
         bm.getBiome(x - 1, z) === BIOME.OCEAN ||
         bm.getBiome(x, z + 1) === BIOME.OCEAN ||
         bm.getBiome(x, z - 1) === BIOME.OCEAN;
}

// Set a block in world Y coordinates (handles sub-chunk lookup).
function setLocal(col, lx, worldY, lz, id) {
  if (worldY < WORLD_MIN_Y || worldY > WORLD_MAX_Y) return;
  const rel = worldY - WORLD_MIN_Y;
  const s = rel >>> 4;
  const ly = rel & 15;
  col.subs[s].set(lx, ly, lz, id);
}
