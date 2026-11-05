// Voxelcraft — Phase 11: village structures (light).
//
// Places occasional simple houses on flat land in suitable biomes. A "village"
// is 1-3 houses clustered in a chunk. Houses are small (5×5 footprint, 4
// blocks tall) with planks walls, wood-log corner posts, a peaked roof, glass
// windows, and a 1×2 door gap (door block deferred to Phase 16 crafting).
//
// Placement rules:
//   - ~2% of land chunks in Plains/Forest/Savanna get a village.
//   - Terrain must be flat (height variance ≤ 2 blocks across the footprint).
//   - Surface must be grass or sand (not water/snow).
//   - Houses are placed at deterministic positions within the chunk.
//
// Determinism: all decisions derive from a position hash (cx, cz, salt).
// Structures write only within their own chunk.

import { BLOCK } from '../../engine/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../engine/world.js';
import { BIOME } from '../biomes.js';

const VILLAGE_BIOMES = new Set([BIOME.PLAINS, BIOME.FOREST, BIOME.SAVANNA]);
const VILLAGE_CHANCE = 0.02; // per land chunk

function hash01(a, b, salt) {
  let h = (a * 73856093) ^ (b * 83492791) ^ (salt * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h % 100000) / 100000;
}

function setLocal(col, lx, worldY, lz, id) {
  if (worldY < WORLD_MIN_Y || worldY > WORLD_MAX_Y) return;
  const rel = worldY - WORLD_MIN_Y;
  col.subs[rel >>> 4].set(lx, rel & 15, lz, id);
}

function getLocal(col, lx, worldY, lz) {
  if (worldY < WORLD_MIN_Y || worldY > WORLD_MAX_Y) return BLOCK.AIR;
  const rel = worldY - WORLD_MIN_Y;
  return col.subs[rel >>> 4].get(lx, rel & 15, lz);
}

// Place village structures in this chunk. `surfaceY(wx,wz)` returns terrain height.
// Returns an array of house clearing zones: [{ wx, wz, radius }] — each house's
// footprint center + a radius large enough to keep trees from overhanging the
// walls/roof. The generator passes these to placeTrees so villages sit in
// natural clearings.
export function placeVillage(col, cx, cz, bm, surfaceY) {
  const zones = [];
  // Only attempt in village biomes (check chunk center).
  const centerBiome = bm.getBiome(cx * 16 + 8, cz * 16 + 8);
  if (!VILLAGE_BIOMES.has(centerBiome)) return zones;

  if (hash01(cx, cz, 9090) >= VILLAGE_CHANCE) return zones;

  // Try to place 1-3 houses. Each house needs a flat valid spot.
  const houseCount = 1 + Math.floor(hash01(cx, cz, 9091) * 3);
  for (let i = 0; i < houseCount; i++) {
    // Deterministic house position within the chunk (margin for 5×5 footprint).
    const lx = 3 + Math.floor(hash01(cx, cz, 9092 + i) * 8); // 3..10
    const lz = 3 + Math.floor(hash01(cx, cz, 9093 + i) * 8);
    const baseWx = cx * 16 + lx;
    const baseWz = cz * 16 + lz;
    const h = surfaceY(baseWx, baseWz);

    // Check flatness across the 5×5 footprint.
    if (!isFlat(surfaceY, baseWx, baseWz, 2)) continue;
    if (h <= 62) continue; // not underwater
    const surface = getLocal(col, lx, h, lz);
    if (surface !== BLOCK.GRASS && surface !== BLOCK.SAND && surface !== BLOCK.DIRT) continue;

    placeHouse(col, lx, h, lz, cx, cz, i);
    // Footprint center (lx+2) + clearing radius: 5×5 house + 4-block buffer
    // catches any overhanging canopy (oak/birch radius 2).
    zones.push({ wx: cx * 16 + lx + 2, wz: cz * 16 + lz + 2, radius: 4 });
  }
  return zones;
}

// Check height variance ≤ maxVar across an n×n footprint centered at (wx, wz).
function isFlat(surfaceY, wx, wz, maxVar) {
  let mn = Infinity, mx = -Infinity;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const h = surfaceY(wx + dx, wz + dz);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return (mx - mn) <= maxVar;
}

// Build a 5×5 house at local (lx, surfaceY, lz). The house occupies lx..lx+4.
function placeHouse(col, lx, surfaceY, lz, cx, cz, seed) {
  const wallBlock = hash01(cx, cz, 700 + seed) < 0.5 ? BLOCK.PLANKS : BLOCK.COBBLESTONE;
  const roofBlock = BLOCK.PLANKS;
  const cornerBlock = BLOCK.WOOD_LOG;
  const floorBlock = BLOCK.PLANKS;
  const windowBlock = BLOCK.GLASS;

  // Orientation: door faces +X (east). Determine which wall gets the door.
  const doorOnSouth = hash01(cx, cz, 800 + seed) < 0.5;

  // Clear the area first (remove plants above surface within footprint).
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      for (let dy = 1; dy <= 6; dy++) {
        const id = getLocal(col, lx + dx, surfaceY + dy, lz + dz);
        if (id !== BLOCK.AIR) setLocal(col, lx + dx, surfaceY + dy, lz + dz, BLOCK.AIR);
      }
    }
  }

  // Floor (Y = surfaceY).
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      setLocal(col, lx + dx, surfaceY, lz + dz, floorBlock);
    }
  }

  // Walls (Y = surfaceY+1 .. surfaceY+3). Corners are wood logs.
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      const isCorner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4);
      const isEdge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
      if (!isEdge) continue; // interior stays air
      for (let dy = 1; dy <= 3; dy++) {
        if (isCorner) {
          setLocal(col, lx + dx, surfaceY + dy, lz + dz, cornerBlock);
        } else {
          setLocal(col, lx + dx, surfaceY + dy, lz + dz, wallBlock);
        }
      }
    }
  }

  // Door gap: 1×2 air on the south edge (dz=4) or east edge (dx=4), center.
  if (doorOnSouth) {
    setLocal(col, lx + 2, surfaceY + 1, lz + 4, BLOCK.AIR);
    setLocal(col, lx + 2, surfaceY + 2, lz + 4, BLOCK.AIR);
  } else {
    setLocal(col, lx + 4, surfaceY + 1, lz + 2, BLOCK.AIR);
    setLocal(col, lx + 4, surfaceY + 2, lz + 2, BLOCK.AIR);
  }

  // Windows: glass blocks on the north and west walls, mid-height.
  setLocal(col, lx + 2, surfaceY + 2, lz, windowBlock);
  setLocal(col, lx, surfaceY + 2, lz + 2, windowBlock);

  // Peaked roof (stepped pyramid): layer at surfaceY+4 (full), +5 (3×3), +6 (1×1).
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      setLocal(col, lx + dx, surfaceY + 4, lz + dz, roofBlock);
    }
  }
  for (let dx = 1; dx <= 3; dx++) {
    for (let dz = 1; dz <= 3; dz++) {
      setLocal(col, lx + dx, surfaceY + 5, lz + dz, roofBlock);
    }
  }
  setLocal(col, lx + 2, surfaceY + 6, lz + 2, roofBlock);

  // Clear interior (ensure it's air inside).
  for (let dx = 1; dx <= 3; dx++) {
    for (let dz = 1; dz <= 3; dz++) {
      for (let dy = 1; dy <= 3; dy++) {
        setLocal(col, lx + dx, surfaceY + dy, lz + dz, BLOCK.AIR);
      }
    }
  }
}

export { VILLAGE_BIOMES, VILLAGE_CHANCE };
