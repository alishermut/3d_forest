// Voxelcraft — Phase 1: debug world spawn.
//
// Temporary: fills a small 3×3 platform of chunk columns with a flat
// landscape so the data model can be verified before the mesher (Phase 2) and
// the real terrain generator (Phase 6) exist. Replaced by terrain.js in
// Phase 6.

import { World } from '../engine/world.js';
import { BLOCK } from '../engine/blocks.js';

const RADIUS = 1; // 3×3 columns around origin
const SURFACE_Y = 70;

export function spawnDebugWorld() {
  const world = new World();

  for (let cx = -RADIUS; cx <= RADIUS; cx++) {
    for (let cz = -RADIUS; cz <= RADIUS; cz++) {
      const col = world.getColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const x = cx * 16 + lx;
          const z = cz * 16 + lz;
          // Bedrock floor
          world.setBlock(x, -64, z, BLOCK.BEDROCK);
          // Stone body
          for (let y = -63; y < SURFACE_Y - 4; y++) {
            world.setBlock(x, y, z, BLOCK.STONE);
          }
          // Dirt sub-surface
          for (let y = SURFACE_Y - 4; y < SURFACE_Y; y++) {
            world.setBlock(x, y, z, BLOCK.DIRT);
          }
          // Grass top
          world.setBlock(x, SURFACE_Y, z, BLOCK.GRASS);
        }
      }
      col.generated = true;
    }
  }

  return world;
}

export { SURFACE_Y };
