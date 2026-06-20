// Voxelcraft — Phase 2: chunk-mesh builder.
//
// Builds THREE.BufferGeometry from the mesher output and manages the lifecycle
// of chunk meshes in the scene. Each chunk column produces up to
// 2×SUBCHUNKS_PER_COLUMN meshes (opaque + transparent per sub-chunk); empty
// sub-chunks (all air) produce nothing.

import * as THREE from 'three';
import { meshSubChunk } from '../engine/mesher.js';
import { isTransparent } from '../engine/blocks.js';
import { CHUNK_SIZE, SUBCHUNKS_PER_COLUMN, WORLD_MIN_Y } from '../engine/world.js';

// Build BufferGeometry from a mesher output buffer.
function buildGeometry(buf) {
  if (buf.positions.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  g.setIndex(buf.indices);
  g.computeBoundingSphere();
  return g;
}

// Mesh a single chunk column. Returns { opaque: Mesh[], transparent: Mesh[] }.
// Reads blocks via world.getBlock so the mesher sees across chunk borders.
export function buildColumnMeshes(world, column, atlasMaterial, transparentMaterial) {
  const opaqueMeshes = [];
  const transparentMeshes = [];
  const cx = column.cx;
  const cz = column.cz;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  for (let s = 0; s < SUBCHUNKS_PER_COLUMN; s++) {
    const sc = column.subs[s];
    // Skip all-air sub-chunks (no faces possible) — the uniform fast path in
    // the mesher also handles this, but skipping here avoids even the call.
    if (sc.isUniform() && sc.palette[0] === 0) continue; // 0 = AIR
    const oy = WORLD_MIN_Y + s * 16;
    const { opaque, transparent } = meshSubChunk(
      (x, y, z) => world.getBlock(x, y, z),
      ox, oy, oz,
      atlasMaterial.userData.uvMap,
      sc,
      (x, y, z) => world.getLight(x, y, z)
    );
    if (opaque.positions.length > 0) {
      const g = buildGeometry(opaque);
      const m = new THREE.Mesh(g, atlasMaterial);
      m.frustumCulled = true;
      m.castShadow = true;     // blocks cast sun shadows
      m.receiveShadow = true;  // and receive them (ground/overhangs)
      opaqueMeshes.push(m);
    }
    if (transparent.positions.length > 0) {
      const g = buildGeometry(transparent);
      const m = new THREE.Mesh(g, transparentMaterial);
      m.frustumCulled = true;
      // Transparent (water/leaves/glass): receive shadows but don't cast
      // (casting from every leaf/water face is noisy + costly).
      m.receiveShadow = true;
      transparentMeshes.push(m);
    }
  }
  return { opaque: opaqueMeshes, transparent: transparentMeshes };
}
