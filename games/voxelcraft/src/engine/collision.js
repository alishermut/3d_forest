// Voxelcraft — Phase 4/19: voxel collision (swept-AABB).
//
// Resolves an AABB's movement against the voxel grid. We move one axis at a
// time with substepping: break large moves into ≤0.4-block steps so we can't
// tunnel through walls at high speed or low frame rate. At each sub-step, if
// the new position overlaps a solid voxel, we snap to the block face and stop.
//
// Parametrized by { half, height } so it serves BOTH the player (0.6×1.8) and
// mobs (sheep 0.9×1.3, chicken 0.6×0.7, etc.). Callers that omit `dims` get
// the player dimensions (back-compat with the Phase 4 player code).
//
// Returns the resolved position + a flags object { hitX, hitY, hitZ, onGround }.

import { isSolid } from './blocks.js';

const PLAYER_HALF = 0.3;  // 0.6 wide
const PLAYER_HEIGHT = 1.8;
const MAX_STEP = 0.4;     // max move per sub-step (blocks)

export const PLAYER_DIMS = { half: PLAYER_HALF, height: PLAYER_HEIGHT };

// Check whether an AABB of `dims` at position (x, y, z) [feet at y] overlaps
// any solid voxel. y is the feet position; the AABB spans [y, y+dims.height].
export function collidesAt(world, x, y, z, dims = PLAYER_DIMS) {
  const half = dims.half;
  const height = dims.height;
  const minX = Math.floor(x - half);
  const maxX = Math.floor(x + half);
  const minY = Math.floor(y);
  // -epsilon so touching the top face isn't a collision (lets you stand on ground)
  const maxY = Math.floor(y + height - 0.001);
  const minZ = Math.floor(z - half);
  const maxZ = Math.floor(z + half);
  for (let bx = minX; bx <= maxX; bx++) {
    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        if (isSolid(world.getBlock(bx, by, bz))) return true;
      }
    }
  }
  return false;
}

// Move along a single axis by `delta`, substepping to avoid tunneling.
// Mutates pos[axis]; returns true if a collision stopped the move.
function moveAxis(world, pos, delta, axis, dims) {
  if (delta === 0) return false;

  const steps = Math.ceil(Math.abs(delta) / MAX_STEP);
  const stepSize = delta / steps;
  let hit = false;

  for (let i = 0; i < steps; i++) {
    pos[axis] += stepSize;
    if (collidesAt(world, pos.x, pos.y, pos.z, dims)) {
      // Revert this sub-step.
      pos[axis] -= stepSize;
      // Snap to the block face: nudge forward in tiny increments until we
      // just touch the wall (flush, no gap).
      const nudge = stepSize > 0 ? 0.01 : -0.01;
      const limit = stepSize > 0 ? stepSize : -stepSize;
      let moved = 0;
      while (moved < limit) {
        pos[axis] += nudge;
        if (collidesAt(world, pos.x, pos.y, pos.z, dims)) {
          pos[axis] -= nudge; // back off the last nudge that touched
          break;
        }
        moved += Math.abs(nudge);
      }
      hit = true;
      break;
    }
  }
  return hit;
}

// Resolve full 3D movement: delta is a THREE.Vector3 to attempt. Mutates pos.
// Returns { hitX, hitY, hitZ, onGround }. `dims` defaults to the player.
export function moveAndCollide(world, pos, delta, dims = PLAYER_DIMS) {
  const hitX = moveAxis(world, pos, delta.x, 'x', dims);
  const hitY = moveAxis(world, pos, delta.y, 'y', dims);
  const hitZ = moveAxis(world, pos, delta.z, 'z', dims);
  // onGround: we hit something while moving down, OR we're resting on ground.
  const onGround = hitY && delta.y <= 0;
  return { hitX, hitY, hitZ, onGround };
}
