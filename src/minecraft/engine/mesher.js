// Voxelcraft — Phase 2: greedy mesher.
//
// Converts a 16³ sub-chunk of voxel data into renderable geometry using greedy
// meshing (Mikola Lysenko / 0fps algorithm): coplanar adjacent faces of the
// same block type are merged into larger quads, cutting vertex/triangle count
// by 5–50× vs naive face-culling.
//
// Per-vertex ambient occlusion (AO) is baked into vertex colors. For each
// emitted quad corner we sample the 3 neighbor blocks on the outside of the
// face (two edge-adjacent + the diagonal) and compute a 0..3 AO level which
// maps to a brightness multiplier. Merged quads get 4 corner AO values; the
// GPU interpolates across the quad.
//
// The mesher reads block ids via a getBlock(worldX, worldY, worldZ) callback
// so it can see across chunk borders (avoids seams). Unloaded = air → border
// faces are drawn.
//
// Two geometries are produced: opaque (stone, dirt, etc.) and transparent
// (water, leaves, glass). Transparent blocks don't draw internal faces against
// the same type (no water-water faces) but do cull against opaque.

import { isTransparent, getBlockType, isCross } from './blocks.js';

const SIZE = 16;

// Face direction (normal) → texture index in the block registry's textures[6].
// Registry order: [top(+Y), bottom(-Y), north(-Z), south(+Z), east(+X), west(-X)]
const FACE_TEX = {
  '0,1,0': 0,  '0,-1,0': 1,
  '0,0,-1': 2, '0,0,1': 3,
  '1,0,0': 4,  '-1,0,0': 5,
};

// AO level 0..3 → brightness multiplier.
const AO_BRIGHTNESS = [0.4, 0.65, 0.85, 1.0];

// Minimum rendered brightness — no block is ever fully black, but kept low so
// truly unlit caves read as dark-needs-a-torch rather than dim grey.
const MIN_BRIGHTNESS = 0.03;

// Light curve: maps a raw light level (0..15) to a brightness factor. A STEEP
// (squared) curve keeps full light (level 15 = open sky / right next to a torch)
// at full brightness while making the MID range fall off fast — so skylight that
// has leaked a few blocks into a cave (level ~7) renders dim (~24%) instead of
// the ~71% a sqrt curve gave. This is what makes caves read as dark away from
// openings/torches without dimming the surface at all (15 → 1.0 either way).
function lightCurve(level) {
  const t = Math.max(0, Math.min(15, level)) / 15;
  const curved = t * t; // steep falloff: bright stays bright, mid/low go dark
  return MIN_BRIGHTNESS + (1 - MIN_BRIGHTNESS) * curved;
}

// Face-direction shading (MC-style): top brightest, bottom darkest.
// Index: [axis d][dir] → shade multiplier.
//   d=0 (X): 0.6, d=1 (Y top): 1.0, d=1 (Y bottom): 0.5, d=2 (Z): 0.8
function faceShade(d, dir) {
  if (d === 1) return dir > 0 ? 1.0 : 0.5; // Y: top/bottom
  if (d === 0) return 0.6; // X faces
  return 0.8; // Z faces
}

// Standard voxel AO: darker when more of the 3 outside-neighbors are solid.
function vertexAO(side1, side2, corner) {
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + corner);
}

export function meshSubChunk(getBlock, ox, oy, oz, uvMap, subChunk, getLight) {
  const opaque = { positions: [], normals: [], uvs: [], colors: [], indices: [] };
  const transparent = { positions: [], normals: [], uvs: [], colors: [], indices: [] };

  // Fast path: if this sub-chunk is uniform (single palette entry), only the
  // 6 boundary slices can produce faces (interior cells have same-type
  // neighbors on both sides → no faces). Skip the 15 interior slices per axis.
  // For a uniform all-air sub-chunk, produce nothing at all.
  if (subChunk && subChunk.isUniform()) {
    const id = subChunk.palette[0];
    if (id === 0) return { opaque, transparent };
    // Cross-shaped uniform sub-chunk: emit cross quads for all cells.
    if (isCross(id)) {
      emitCrossPlants(getBlock, getLight, ox, oy, oz, uvMap, transparent, subChunk);
      return { opaque, transparent };
    }
    // Only check the 2 boundary slices per axis (slice -1 and SIZE-1).
    const axes = [
      { d: 0, u: 1, v: 2 },
      { d: 1, u: 2, v: 0 },
      { d: 2, u: 0, v: 1 },
    ];
    for (const { d, u, v } of axes) {
      for (const slice of [-1, SIZE - 1]) {
        meshSlice(getBlock, getLight, ox, oy, oz, d, u, v, slice, uvMap, opaque, transparent);
      }
    }
    return { opaque, transparent };
  }

  // Full scan: all slices for all 3 axes.
  const axes = [
    { d: 0, u: 1, v: 2 }, // ±X faces
    { d: 1, u: 2, v: 0 }, // ±Y faces
    { d: 2, u: 0, v: 1 }, // ±Z faces
  ];

  for (const { d, u, v } of axes) {
    for (let slice = -1; slice < SIZE; slice++) {
      meshSlice(getBlock, getLight, ox, oy, oz, d, u, v, slice, uvMap, opaque, transparent);
    }
  }

  // Cross-shaped plant blocks: emit 2 diagonal quads per cell (no cube faces).
  if (subChunk) emitCrossPlants(getBlock, getLight, ox, oy, oz, uvMap, transparent, subChunk);

  return { opaque, transparent };
}

// Process one slice boundary: build the 2D mask of visible faces and greedy-
// merge into quads. Shared by the full-scan and uniform fast path.
function meshSlice(getBlock, getLight, ox, oy, oz, d, u, v, slice, uvMap, opaque, transparent) {
      // Build the 2D mask of visible faces for this slice boundary.
      const mask = new Array(SIZE * SIZE).fill(null);
      for (let iu = 0; iu < SIZE; iu++) {
        for (let iv = 0; iv < SIZE; iv++) {
          const a = sample(getBlock, ox, oy, oz, d, u, v, slice, iu, iv);
          const b = sample(getBlock, ox, oy, oz, d, u, v, slice + 1, iu, iv);
          if (a !== 0 && faceVisible(a, b)) {
            mask[iu * SIZE + iv] = { id: a, dir: 1 };
          } else if (b !== 0 && faceVisible(b, a)) {
            mask[iu * SIZE + iv] = { id: b, dir: -1 };
          }
        }
      }

      // Greedy-merge the mask into rectangles.
      for (let iu = 0; iu < SIZE; iu++) {
        let iv = 0;
        while (iv < SIZE) {
          const m = mask[iu * SIZE + iv];
          if (!m) { iv++; continue; }
          // Expand width in u.
          let wu = 1;
          while (iu + wu < SIZE && sameMask(mask[(iu + wu) * SIZE + iv], m)) wu++;
          // Expand height in v.
          let wv = 1;
          outer: while (iv + wv < SIZE) {
            for (let k = 0; k < wu; k++) {
              if (!sameMask(mask[(iu + k) * SIZE + (iv + wv)], m)) break outer;
            }
            wv++;
          }
          // Emit the merged quad.
          emitQuad(getBlock, getLight, ox, oy, oz, d, u, v, slice, m.dir, m.id,
                   iu, iv, wu, wv, uvMap,
                   isTransparent(m.id) ? transparent : opaque);
          // Clear merged cells.
          for (let a = 0; a < wu; a++) {
            for (let b2 = 0; b2 < wv; b2++) {
              mask[(iu + a) * SIZE + (iv + b2)] = null;
            }
          }
          iv += wv;
        }
      }
}

// Read block id at axis-local (slice, iu, iv) → world coords.
function sample(getBlock, ox, oy, oz, d, u, v, slice, iu, iv) {
  const c = [0, 0, 0];
  c[d] = slice;
  c[u] = iu;
  c[v] = iv;
  return getBlock(ox + c[0], oy + c[1], oz + c[2]);
}

// Face between `a` (on -d side) and `b` (on +d side) is visible from a when
// b is transparent and a ≠ b (no internal faces for same-type transparent).
// Cross-shaped blocks (flowers, tall grass) emit no cube faces — they use
// the cross-plant pass instead.
function faceVisible(a, b) {
  if (a === 0) return false;
  if (isCross(a)) return false;
  if (a === b) return false;
  return isTransparent(b);
}

function sameMask(x, y) {
  return x && y && x.id === y.id && x.dir === y.dir;
}

// Emit a merged quad as two triangles.
function emitQuad(getBlock, getLight, ox, oy, oz, d, u, v, slice, dir, id,
                  iu, iv, wu, wv, uvMap, out) {
  const dPos = slice + 1; // face plane between slice and slice+1, always at slice+1

  // 4 corners (CCW when viewed from the +dir side): BL, BR, TR, TL.
  const corners = [
    { cu: iu,      cv: iv,      offU: -1, offV: -1 }, // BL
    { cu: iu + wu, cv: iv,      offU: +1, offV: -1 }, // BR
    { cu: iu + wu, cv: iv + wv, offU: +1, offV: +1 }, // TR
    { cu: iu,      cv: iv + wv, offU: -1, offV: +1 }, // TL
  ];

  // Face normal in axis-local coords.
  const nLocal = [0, 0, 0];
  nLocal[d] = dir;

  // Tile + UV rect for this face direction.
  const texIdx = FACE_TEX[nLocal.join(',')];
  const tileName = getBlockType(id).textures[texIdx];
  const uvRect = uvMap.get(tileName) || [0, 0, 1, 1];

  // Outside block d-coordinate (the air block the face looks into).
  const outsideD = dPos - (dir < 0 ? 1 : 0);

  // Per-corner AO + light. Both sample from the owning cell's outside block.
  const aos = [];
  const lightFactors = [];
  for (const { cu, cv, offU, offV } of corners) {
    const cellU = cu - (offU > 0 ? 1 : 0);
    const cellV = cv - (offV > 0 ? 1 : 0);
    aos.push(computeAO(getBlock, ox, oy, oz, d, u, v, dPos, dir, cellU, cellV, offU, offV));
    // Sample light at the outside block for this cell.
    if (getLight) {
      const lc = [0, 0, 0];
      lc[d] = outsideD;
      lc[u] = cellU;
      lc[v] = cellV;
      const packed = getLight(ox + lc[0], oy + lc[1], oz + lc[2]);
      const sky = packed >> 4;
      const block = packed & 0x0f;
      // FULL baked light: max(sky, block). MeshBasicMaterial renders this
      // directly (no scene lights re-light it). Sun-directional shadows are
      // applied on top as a multiplicative darken in the opaque material's
      // onBeforeCompile patch (main.js). This is the correct voxel model: the
      // baked light owns brightness, shadows only ever reduce it.
      lightFactors.push(lightCurve(Math.max(sky, block)));
    } else {
      lightFactors.push(1.0); // no light system → full bright
    }
  }

  // Face-direction shade (MC-style: top brightest, bottom darkest). Baked into
  // vertex color since MeshBasicMaterial doesn't compute it from the normal.
  const shade = faceShade(d, dir);

  const base = out.positions.length / 3;
  for (let i = 0; i < 4; i++) {
    const { cu, cv } = corners[i];
    const pos = [0, 0, 0];
    pos[d] = dPos;
    pos[u] = cu;
    pos[v] = cv;
    out.positions.push(ox + pos[0], oy + pos[1], oz + pos[2]);
    out.normals.push(nLocal[0], nLocal[1], nLocal[2]);
    // UV: map corner's (uFrac, vFrac) within the quad to the tile rect.
    const uFrac = (cu - iu) / wu;
    const vFrac = (cv - iv) / wv;
    out.uvs.push(
      uvRect[0] + uFrac * (uvRect[2] - uvRect[0]),
      uvRect[1] + vFrac * (uvRect[3] - uvRect[1])
    );
    // Final baked brightness: AO × face-direction shade × light (sky+block).
    // Sun-cast shadows are applied later as a multiplicative darken (main.js
    // material patch), so they reduce this without re-lighting it.
    const b = AO_BRIGHTNESS[aos[i]] * shade * lightFactors[i];
    out.colors.push(b, b, b);
  }
  // Two triangles; winding flips with dir so the face points outward.
  if (dir > 0) {
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  } else {
    out.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

// AO for one corner: sample 3 neighbors on the outside layer (dPos + dir).
function computeAO(getBlock, ox, oy, oz, d, u, v, dPos, dir, cellU, cellV, offU, offV) {
  const od = dPos + dir;
  const base = [0, 0, 0];
  base[d] = od;
  base[u] = cellU;
  base[v] = cellV;
  const solid = (du, dv) => {
    const c = base.slice();
    c[u] += du;
    c[v] += dv;
    const id = getBlock(ox + c[0], oy + c[1], oz + c[2]);
    return (id !== 0 && !isTransparent(id)) ? 1 : 0;
  };
  const s1 = solid(offU, 0);
  const s2 = solid(0, offV);
  const co = solid(offU, offV);
  return vertexAO(s1, s2, co);
}

  // Cross-shaped plants: emit 2 diagonal quads (forming an X) per plant cell.
  // These go into the transparent geometry (double-sided, depthWrite off).
  // No face culling — every cross block is always rendered. UVs map the plant
  // texture onto each diagonal quad.
  function emitCrossPlants(getBlock, getLight, ox, oy, oz, uvMap, out, subChunk) {
    for (let lx = 0; lx < SIZE; lx++) {
      for (let ly = 0; ly < SIZE; ly++) {
        for (let lz = 0; lz < SIZE; lz++) {
          const id = subChunk.get(lx, ly, lz);
          if (!isCross(id)) continue;
          emitCrossQuad(getBlock, getLight, ox, oy, oz, lx, ly, lz, id, uvMap, out);
        }
      }
    }
  }

  // Emit one X-shaped cross (2 diagonal quads) at local (lx, ly, lz).
  function emitCrossQuad(getBlock, getLight, ox, oy, oz, lx, ly, lz, id, uvMap, out) {
    const tileName = getBlockType(id).textures[0];
    const uv = uvMap.get(tileName) || [0, 0, 1, 1];
    const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
    const wx = ox + lx, wy = oy + ly, wz = oz + lz;

    // Sample light at the plant's own position (full sky+block baked light).
    let lightFactor = 1.0;
    if (getLight) {
      const packed = getLight(wx, wy, wz);
      const sky = packed >> 4;
      const block = packed & 0x0f;
      lightFactor = lightCurve(Math.max(sky, block));
    }

    // Two diagonal quads: A goes from (0,0)→(1,1), B from (1,0)→(0,1) in XZ.
    const quads = [
      [[wx, wy, wz], [wx+1, wy, wz+1], [wx+1, wy+1, wz+1], [wx, wy+1, wz]],
      [[wx+1, wy, wz], [wx, wy, wz+1], [wx, wy+1, wz+1], [wx+1, wy+1, wz]],
    ];

    for (const q of quads) {
      const base = out.positions.length / 3;
      for (let i = 0; i < 4; i++) {
        out.positions.push(q[i][0], q[i][1], q[i][2]);
        out.normals.push(0, 1, 0);
      }
      out.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      // Brightness = light level (cross plants: no AO, full shade).
      const b = lightFactor;
      out.colors.push(b, b, b, b, b, b, b, b, b, b, b, b);
      out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
