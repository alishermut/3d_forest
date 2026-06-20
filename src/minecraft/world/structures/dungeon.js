// Voxelcraft — Phase 11: dungeon structures (light).
//
// Places small underground rooms (5×5×4) made of mossy cobblestone + stone
// bricks. These are classic MC-style dungeons minus the mob spawner + chest
// (deferred to survival phases). Placed rarely underground in solid stone,
// carving out the interior.
//
// Placement rules:
//   - ~1.5% of chunks get a dungeon.
//   - Y level between -20 and 30 (shallow-mid underground).
//   - Only placed where the 5×5 area is solid stone/deepslate (so it doesn't
//     break the surface or float in a cave).
//   - Interior is hollowed to air; walls/floor/ceiling are structure blocks.
//   - One 1×2 doorway in a wall (so it's reachable from caves/tunnels).

import { BLOCK } from '../../engine/blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../engine/world.js';

const DUNGEON_CHANCE = 0.015;

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

const SOLID = new Set([BLOCK.STONE, BLOCK.DEEPSLATE, BLOCK.DIRT]);

// Place a dungeon in this chunk if eligible. Returns true if placed.
export function placeDungeon(col, cx, cz) {
  if (hash01(cx, cz, 4242) >= DUNGEON_CHANCE) return false;

  // Pick a position within the chunk (margin for 5×5 footprint).
  const lx = 3 + Math.floor(hash01(cx, cz, 4243) * 8);
  const lz = 3 + Math.floor(hash01(cx, cz, 4244) * 8);
  // Y level: -20..30
  const baseY = -20 + Math.floor(hash01(cx, cz, 4245) * 50);

  // Verify the surrounding is solid stone (so the dungeon is embedded, not
  // floating in a cave or breaking the surface).
  for (let dx = -1; dx <= 5; dx++) {
    for (let dz = -1; dz <= 5; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        const id = getLocal(col, lx + dx, baseY + dy, lz + dz);
        if (!SOLID.has(id)) return false;
      }
    }
  }

  // Carve the interior (5×5×4) and set walls/floor/ceiling.
  const wallBlock = hash01(cx, cz, 4246) < 0.5 ? BLOCK.MOSSY_COBBLESTONE : BLOCK.STONE_BRICKS;
  for (let dx = 0; dx <= 4; dx++) {
    for (let dz = 0; dz <= 4; dz++) {
      for (let dy = 0; dy <= 3; dy++) {
        const isEdge = dx === 0 || dx === 4 || dz === 0 || dz === 4 || dy === 0 || dy === 3;
        if (isEdge) {
          setLocal(col, lx + dx, baseY + dy, lz + dz, wallBlock);
        } else {
          setLocal(col, lx + dx, baseY + dy, lz + dz, BLOCK.AIR);
        }
      }
    }
  }

  // Doorway: 1×2 gap in the center of one wall (south edge, dz=4).
  setLocal(col, lx + 2, baseY + 1, lz + 4, BLOCK.AIR);
  setLocal(col, lx + 2, baseY + 2, lz + 4, BLOCK.AIR);

  return true;
}

export { DUNGEON_CHANCE };
