// Voxelcraft — Phase 1: Sub-chunk storage.
//
// A sub-chunk is a 16×16×16 cube of blocks (4,096 cells). Storage uses a
// palette + bit-packed index array, the same scheme real Minecraft has used
// since 1.13:
//   - palette: array of unique block ids present in this sub-chunk (small,
//     typically 2–20 entries)
//   - data: Uint32Array of bit-packed indices, one per cell, each pointing
//     into the palette. bits = ceil(log2(palette.length)).
//
// Memory: a homogeneous sub-chunk (all stone / all air) collapses to a single
// palette entry with bits=0 and an empty data array — near-zero cost. A mixed
// sub-chunk with 8 block types uses 3 bits/cell = 4096×3/32 = 384 uint32s =
// 1.5 KB. The 384-tall column (24 sub-chunks) averages well under 1 KB per
// sub-chunk for natural terrain.
//
// Cell index within a sub-chunk:  i = (y << 8) | (z << 4) | x   (x,y,z in 0..15)
// Bit layout in data: little-endian per uint32, index i at bit position i*bits.

const SIZE = 16;
const CELLS = SIZE * SIZE * SIZE; // 4096

// Number of bits needed to represent `n` distinct values. n<=1 → 0 (single
// value). Uses integer shifts to dodge Math.log2 float edge cases.
function bitsNeeded(n) {
  if (n <= 1) return 0;
  let b = 0;
  let v = 1;
  while (v < n) {
    v <<= 1;
    b++;
  }
  return b;
}

export class SubChunk {
  constructor() {
    this.palette = [0]; // [air]
    this.bits = 0;
    this.data = new Uint32Array(0);
    // Light data: 1 byte per cell, packed as (skyLight << 4) | blockLight.
    // Both channels 0..15. Lazy-filled by the lighting pass after generation.
    this.light = new Uint8Array(CELLS);
  }

  static get SIZE() { return SIZE; }
  static get CELLS() { return CELLS; }

  _cellIndex(x, y, z) {
    return (y << 8) | (z << 4) | x;
  }

  get(x, y, z) {
    if (this.bits === 0) return this.palette[0];
    const i = this._cellIndex(x, y, z);
    const bitPos = i * this.bits;
    const word = bitPos >>> 5;
    const offset = bitPos & 31;
    const mask = (1 << this.bits) - 1;
    let val = (this.data[word] >>> offset) & mask;
    if (offset + this.bits > 32) {
      const extra = offset + this.bits - 32;
      val |= (this.data[word + 1] & ((1 << extra) - 1)) << (this.bits - extra);
    }
    return this.palette[val];
  }

  set(x, y, z, id) {
    // No-op when writing the same value into a single-value sub-chunk.
    if (this.bits === 0 && this.palette[0] === id) return;

    // Ensure the id is in the palette, growing + repacking if needed.
    let pidx = this.palette.indexOf(id);
    if (pidx === -1) {
      pidx = this.palette.length;
      this.palette.push(id);
      const need = bitsNeeded(this.palette.length);
      if (need > this.bits) this._resize(need);
    }

    // bits is now >= 1; write the palette index into the packed data.
    const i = this._cellIndex(x, y, z);
    const bitPos = i * this.bits;
    const word = bitPos >>> 5;
    const offset = bitPos & 31;
    const mask = (1 << this.bits) - 1;
    this.data[word] = (this.data[word] & ~(mask << offset)) | (pidx << offset);
    if (offset + this.bits > 32) {
      const extra = this.bits - (32 - offset);
      const highMask = (1 << extra) - 1;
      this.data[word + 1] =
        (this.data[word + 1] & ~highMask) | (pidx >>> (this.bits - extra));
    }
  }

  // --- Light accessors (packed sky<<4 | block) ---
  getLight(x, y, z) {
    return this.light[this._cellIndex(x, y, z)];
  }
  getSkyLight(x, y, z) {
    return this.light[this._cellIndex(x, y, z)] >> 4;
  }
  getBlockLight(x, y, z) {
    return this.light[this._cellIndex(x, y, z)] & 0x0f;
  }
  setSkyLight(x, y, z, val) {
    const i = this._cellIndex(x, y, z);
    this.light[i] = (val << 4) | (this.light[i] & 0x0f);
  }
  setBlockLight(x, y, z, val) {
    const i = this._cellIndex(x, y, z);
    this.light[i] = (this.light[i] & 0xf0) | val;
  }
  setLight(x, y, z, sky, block) {
    this.light[this._cellIndex(x, y, z)] = (sky << 4) | block;
  }
  fillLight(sky, block) {
    this.light.fill((sky << 4) | block);
  }

  // Grow the bit-width and repack all existing indices into a new array.
  _resize(newBits) {    const oldBits = this.bits;
    const oldData = this.data;
    this.bits = newBits;
    const newWords = Math.ceil((CELLS * newBits) / 32);
    this.data = new Uint32Array(newWords); // zero-filled
    if (oldBits === 0) {
      // Was single-value (palette[0]). All cells already read as palette[0]
      // because data is zero → index 0 → palette[0]. Nothing to copy.
      return;
    }
    for (let i = 0; i < CELLS; i++) {
      const oldBitPos = i * oldBits;
      const ow = oldBitPos >>> 5;
      const oo = oldBitPos & 31;
      const omask = (1 << oldBits) - 1;
      let val = (oldData[ow] >>> oo) & omask;
      if (oo + oldBits > 32) {
        const extra = oo + oldBits - 32;
        val |= (oldData[ow + 1] & ((1 << extra) - 1)) << (oldBits - extra);
      }
      const newBitPos = i * newBits;
      const nw = newBitPos >>> 5;
      const no = newBitPos & 31;
      const nmask = (1 << newBits) - 1;
      this.data[nw] |= (val & nmask) << no;
      if (no + newBits > 32) {
        const extra = no + newBits - 32;
        this.data[nw + 1] |= (val & nmask) >>> (newBits - extra);
      }
    }
  }

  // Set the entire sub-chunk to a single block type (efficient bulk fill).
  fill(id) {
    this.palette = [id];
    this.bits = 0;
    this.data = new Uint32Array(0);
  }

  // Rebuild the palette to drop unused entries. After generation (which
  // bulk-fills stone then overwrites with air/dirt), many sub-chunks have a
  // bloated palette but only one entry is actually used. Compacting collapses
  // them to single-value (bits=0, empty data), which lets the mesher skip
  // all-air sub-chunks entirely.
  compact() {
    if (this.bits === 0) return; // already single-value
    // Count which palette entries are actually used.
    const used = new Uint8Array(this.palette.length);
    for (let i = 0; i < CELLS; i++) {
      const bitPos = i * this.bits;
      const word = bitPos >>> 5;
      const offset = bitPos & 31;
      const mask = (1 << this.bits) - 1;
      let val = (this.data[word] >>> offset) & mask;
      if (offset + this.bits > 32) {
        const extra = offset + this.bits - 32;
        val |= (this.data[word + 1] & ((1 << extra) - 1)) << (this.bits - extra);
      }
      used[val] = 1;
    }
    const usedCount = used.reduce((a, b) => a + b, 0);
    if (usedCount === 1) {
      // Collapse to single-value.
      const idx = used.indexOf(1);
      this.palette = [this.palette[idx]];
      this.bits = 0;
      this.data = new Uint32Array(0);
      return;
    }
    if (usedCount === this.palette.length) return; // no unused entries
    // Rebuild palette + remap indices.
    const newPalette = [];
    const remap = [];
    for (let i = 0; i < this.palette.length; i++) {
      if (used[i]) {
        remap[i] = newPalette.length;
        newPalette.push(this.palette[i]);
      }
    }
    // Remap all indices in-place.
    for (let i = 0; i < CELLS; i++) {
      const bitPos = i * this.bits;
      const word = bitPos >>> 5;
      const offset = bitPos & 31;
      const mask = (1 << this.bits) - 1;
      let val = (this.data[word] >>> offset) & mask;
      if (offset + this.bits > 32) {
        const extra = offset + this.bits - 32;
        val |= (this.data[word + 1] & ((1 << extra) - 1)) << (this.bits - extra);
      }
      const newVal = remap[val];
      this.data[word] = (this.data[word] & ~(mask << offset)) | (newVal << offset);
      if (offset + this.bits > 32) {
        const extra = this.bits - (32 - offset);
        const highMask = (1 << extra) - 1;
        this.data[word + 1] = (this.data[word + 1] & ~highMask) | (newVal >>> (this.bits - extra));
      }
    }
    this.palette = newPalette;
    // The bit width might shrink now, but we keep the same width for simplicity
    // (the remap only reduces palette indices, not the bit count).
  }

  // True if every cell in this sub-chunk is the same single block id.
  isUniform() {
    return this.bits === 0;
  }

  // Approximate bytes used by this sub-chunk's voxel data (for debug HUD).
  byteSize() {
    return this.data.byteLength + this.palette.length * 4;
  }
}
