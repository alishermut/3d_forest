// Voxelcraft — Phase 5: DDA voxel raycast.
//
// Amanatides & Woo's fast voxel traversal. Casts a ray from `origin` along
// `dir` (normalized) and steps through each voxel the ray enters, up to
// `maxDist` blocks. Returns the first solid (non-air, non-transparent-by-
// default) block hit + the face normal of the hit (so the caller knows which
// adjacent cell to place a block into).
//
// Returns { x, y, z, nx, ny, nz } or null if nothing solid within range.
// (x,y,z) = hit block coords; (nx,ny,nz) = face normal (which neighbor cell
// is empty / where a placed block would go).

import { isSolid } from './blocks.js';

export function raycastVoxel(world, origin, dir, maxDist = 6) {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = Math.sign(dir.x);
  const stepY = Math.sign(dir.y);
  const stepZ = Math.sign(dir.z);

  // Distance to the next voxel boundary along each axis, in t-parameter units.
  const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

  // Initial t to cross the first boundary.
  const fracX = stepX > 0 ? (1 - (origin.x - x)) : (origin.x - x);
  const fracY = stepY > 0 ? (1 - (origin.y - y)) : (origin.y - y);
  const fracZ = stepZ > 0 ? (1 - (origin.z - z)) : (origin.z - z);
  let tMaxX = dir.x !== 0 ? tDeltaX * fracX : Infinity;
  let tMaxY = dir.y !== 0 ? tDeltaY * fracY : Infinity;
  let tMaxZ = dir.z !== 0 ? tDeltaZ * fracZ : Infinity;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  // Check the starting voxel (in case the camera is inside a block).
  if (isSolid(world.getBlock(x, y, z))) {
    return { x, y, z, nx: 0, ny: 0, nz: 0 };
  }

  while (t <= maxDist) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDist) break;
    if (isSolid(world.getBlock(x, y, z))) {
      return { x, y, z, nx, ny, nz };
    }
  }
  return null;
}
