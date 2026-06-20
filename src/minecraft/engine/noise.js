// Voxelcraft — Phase 6: simplex-like noise.
//
// A small, fast 2D/3D value-gradient noise implementation with fractal
// (octave) summation. Not a true simplex (Patent-free → we use a hashed
// value-noise + smoothstep interpolation that looks close enough for
// terrain). Seeded so worlds are reproducible.
//
// Reference: Stefan Gustavson's noise primer (simplified). We use a
// permutation table seeded by a 32-bit integer.

// --- PRNG (mulberry32) ----------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Hashed value noise 2D -------------------------------------------------
// Returns 0..1. Smoothstep-interpolated lattice.
export class Noise2D {
  constructor(seed = 1337) {
    const rnd = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.seed = seed;
  }

  // Single-octave value noise at (x, z). Returns 0..1.
  _value(x, z) {
    const xi = Math.floor(x) & 255;
    const zi = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const zf = z - Math.floor(z);
    // Smoothstep
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);

    const aa = this.perm[this.perm[xi] + zi];
    const ab = this.perm[this.perm[xi] + zi + 1];
    const ba = this.perm[this.perm[xi + 1] + zi];
    const bb = this.perm[this.perm[xi + 1] + zi + 1];

    const x1 = lerp(aa, ba, u);
    const x2 = lerp(ab, bb, u);
    return lerp(x1, x2, v) / 255;
  }

  // Fractal (octave) noise. Returns ~0..1.
  fractal(x, z, octaves = 4, persistence = 0.5, lacunarity = 2, scale = 1) {
    let total = 0;
    let frequency = scale;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this._value(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}

// --- Hashed value noise 3D (for caves) ------------------------------------
export class Noise3D {
  constructor(seed = 1337) {
    const rnd = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  _value(x, y, z) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const zi = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);

    const p = this.perm;
    const a = p[p[xi] + yi] + zi;
    const b = p[p[xi + 1] + yi] + zi;
    const aa = p[a], ab = p[a + 1];
    const ba = p[b], bb = p[b + 1];
    const c = p[p[xi] + yi + 1] + zi;
    const d = p[p[xi + 1] + yi + 1] + zi;
    const ca = p[c], cb = p[c + 1];
    const da = p[d], db = p[d + 1];

    const x1 = lerp(aa, ba, u);
    const x2 = lerp(ab, bb, u);
    const x3 = lerp(ca, da, u);
    const x4 = lerp(cb, db, u);
    const y1 = lerp(x1, x2, v);
    const y2 = lerp(x3, x4, v);
    return lerp(y1, y2, w) / 255;
  }

  fractal(x, y, z, octaves = 4, persistence = 0.5, lacunarity = 2, scale = 1) {
    let total = 0;
    let frequency = scale;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this._value(x * frequency, y * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
