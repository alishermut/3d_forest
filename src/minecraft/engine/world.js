// Voxelcraft — Phase 1: World — the chunk map.
//
// The world is a Map of chunk columns keyed by "cx,cz". A chunk column is a
// 16×16 pillar of blocks, 384 blocks tall (Y = −64..319), stored as 24
// SubChunks of 16³ each. World coordinates map to chunk-local coordinates via
// Math.floor division (works correctly for negative coords).
//
// getBlock / setBlock transparently cross chunk borders. Reads from columns
// that aren't loaded return AIR (0) — the streamer (Phase 3) will populate
// them. Writes auto-create the column. Y outside [−64, 319] is a no-op / air.

import { SubChunk } from './chunk.js';
import { BLOCK } from './blocks.js';

export const CHUNK_SIZE = 16;
export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 319; // inclusive
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y + 1; // 384
export const SUBCHUNKS_PER_COLUMN = WORLD_HEIGHT / 16; // 24
export const SEA_LEVEL = 62;

export class ChunkColumn {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.subs = new Array(SUBCHUNKS_PER_COLUMN);
    for (let i = 0; i < SUBCHUNKS_PER_COLUMN; i++) this.subs[i] = new SubChunk();
    this.dirty = true; // mesh needs (re)building (Phase 2+)
    this.generated = false;
  }

  // Convert world Y to (subIndex, localY).
  static worldYToLocal(y) {
    const rel = y - WORLD_MIN_Y;
    const subIdx = rel >>> 4; // div 16
    const ly = rel & 15; // mod 16
    return [subIdx, ly];
  }
}

export class World {
  constructor() {
    // Numeric column key: pack (cx, cz) into one 32-bit int. Chunk coords are
    // signed ~±2000 for any reasonable world, so 16 bits each (offset to
    // unsigned) fits with huge headroom. Avoids the string alloc + hash of
    // the old `cx + ',' + cz` key on every getBlock/getLight (the mesher calls
    // these ~200k times per column).
    this.columns = new Map();
  }

  // Pack (cx, cz) → single int key. cx,cz shifted to 0..65535 unsigned.
  static _key(cx, cz) {
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  _key(cx, cz) {
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  // Public column-key helper for callers that access .columns directly
  // (streamer, main.js mark-dirty). Keeps the packing in one place.
  static key(cx, cz) {
    return ((cx + 32768) << 16) | (cz + 32768);
  }
  key(cx, cz) {
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  getColumn(cx, cz) {
    const k = this._key(cx, cz);
    let c = this.columns.get(k);
    if (!c) {
      c = new ChunkColumn(cx, cz);
      this.columns.set(k, c);
    }
    return c;
  }

  hasColumn(cx, cz) {
    return this.columns.has(this._key(cx, cz));
  }

  getBlock(x, y, z) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return BLOCK.AIR;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const c = this.columns.get(this._key(cx, cz));
    if (!c) return BLOCK.AIR;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const rel = y - WORLD_MIN_Y;
    return c.subs[rel >>> 4].get(lx, rel & 15, lz);
  }

  setBlock(x, y, z, id) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const c = this.getColumn(cx, cz);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const rel = y - WORLD_MIN_Y;
    c.subs[rel >>> 4].set(lx, rel & 15, lz, id);
    c.dirty = true;
  }

  // Cross-chunk light reads (returns packed sky<<4|block, 0 for unloaded).
  getLight(x, y, z) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return 0;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const c = this.columns.get(this._key(cx, cz));
    if (!c) return 0;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const rel = y - WORLD_MIN_Y;
    return c.subs[rel >>> 4].getLight(lx, rel & 15, lz);
  }

  // Approximate total voxel memory across all loaded columns (for debug HUD).
  voxelBytes() {
    let bytes = 0;
    for (const c of this.columns.values()) {
      for (const s of c.subs) bytes += s.byteSize();
    }
    return bytes;
  }

  loadedColumnCount() {
    return this.columns.size;
  }
}
