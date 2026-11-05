// Voxelcraft — Phase 8: cave generation.
//
// Carves underground cave systems into the stone body of each chunk column
// using two 3D noise channels:
//   - Cheese caves: low-frequency noise → large open interconnected caverns.
//   - Spaghetti caves: ridged higher-frequency noise → winding tube tunnels.
//
// Only STONE blocks are carved (surface dirt/grass/sand/bedrock are left
// intact). Below Y=−55, carved blocks become LAVA instead of air (lava lakes
// at the world's depths). Caves don't extend above Y=120 to keep the surface
// clean.
//
// Performance: only underground stone cells are evaluated (~32k per land
// column). Air/surface/bedrock cells are skipped via a fast palette check.

import { BLOCK } from '../engine/blocks.js';
import { Noise3D } from '../engine/noise.js';
import { WORLD_MIN_Y } from '../engine/world.js';

const LAVA_Y = -55;
const CAVE_MAX_Y = 120;
const BEDROCK_TOP = WORLD_MIN_Y + 4; // -60

let _cheese = null;
let _spaghetti = null;

export function getCaveNoise(seed = 1337) {
  if (!_cheese) {
    _cheese = new Noise3D(seed + 100);
    _spaghetti = new Noise3D(seed + 200);
  }
  return { cheese: _cheese, spaghetti: _spaghetti };
}

// Carve caves into a generated column. Mutates sub-chunk data in-place.
// Called AFTER the surface pass, BEFORE compaction.
export function carveCaves(col, cx, cz) {
  const noise = getCaveNoise();

  for (let s = 0; s < col.subs.length; s++) {
    const sc = col.subs[s];
    const oy = WORLD_MIN_Y + s * 16;

    // Skip sub-chunks entirely above the cave ceiling or below bedrock.
    if (oy + 15 < BEDROCK_TOP + 1) continue;
    if (oy > CAVE_MAX_Y) continue;

    // Fast skip: if the sub-chunk is uniform and not stone, nothing to carve.
    if (sc.isUniform() && sc.palette[0] !== BLOCK.STONE) continue;

    for (let lx = 0; lx < 16; lx++) {
      for (let lz = 0; lz < 16; lz++) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        for (let ly = 0; ly < 16; ly++) {
          const worldY = oy + ly;
          if (worldY <= BEDROCK_TOP) continue;
          if (worldY > CAVE_MAX_Y) continue;

          const id = sc.get(lx, ly, lz);
          if (id !== BLOCK.STONE) continue;

          // Cheese caves: large caverns. Early-out: if far from threshold,
          // skip the more expensive spaghetti check.
          const cheese = noise.cheese.fractal(wx, worldY, wz, 2, 0.5, 2, 0.022);
          if (cheese > 0.76) {
            sc.set(lx, ly, lz, worldY < LAVA_Y ? BLOCK.LAVA : BLOCK.AIR);
            continue;
          }

          // Spaghetti caves: winding tubes (ridged noise). Only check if
          // cheese didn't trigger (most cells skip this).
          if (cheese > 0.55) {
            const raw = noise.spaghetti.fractal(wx, worldY, wz, 2, 0.5, 2, 0.045);
            const ridge = 1 - Math.abs(2 * raw - 1);
            if (ridge > 0.92) {
              sc.set(lx, ly, lz, worldY < LAVA_Y ? BLOCK.LAVA : BLOCK.AIR);
              continue;
            }
          }
        }
      }
    }
  }
}
