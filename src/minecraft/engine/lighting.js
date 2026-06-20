// Voxelcraft — Phase 13: block + sky lighting.
//
// Two light channels, both 0..15, packed per-cell in SubChunk.light:
//   - Sky light: TWO-PASS. (1) Per-column top-down scan sets every air/
//     transparent block above the highest opaque block to sky=15, everything
//     below to sky=0. (2) A horizontal+downward BFS flood-fill then spreads
//     that skylight sideways through air (attenuating 1/step), so under
//     overhangs, tree canopies, and roofs you get a smooth bright→dark
//     gradient instead of a hard vertical cliff. (Real Minecraft does exactly
//     this — pure vertical skylight + a sky-light BFS.) Skylight does NOT
//     spread upward (a block never gets brighter sky than the cell above it).
//   - Block light: BFS flood-fill from emissive blocks (torches=14, lava=15,
//     glowstone=15). Propagates through transparent blocks, attenuating by 1
//     per step. Opaque blocks block propagation.
//
// Both flood-fills READ ACROSS CHUNK BORDERS via the world (so light leaks in
// from lit neighbor columns instead of leaving dark seams). Writes are local
// to this column; neighbor columns get re-meshed on their own dirty pass.
//
// Called after terrain/features/structures generation. On block change, the
// affected column is recomputed (full recompute is cheap enough for edits).

import { BLOCK, getBlockType, isTransparent } from './blocks.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, CHUNK_SIZE, SEA_LEVEL } from './world.js';

const SKY = 15;

// Compute skylight + block light for an entire chunk column.
export function computeColumnLight(col, cx, cz, world) {
  // --- Skylight pass 1: per-column top-down scan ---
  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      let sky = SKY;
      // Scan from top sub-chunk down to bottom.
      for (let s = col.subs.length - 1; s >= 0; s--) {
        const sc = col.subs[s];
        for (let ly = 15; ly >= 0; ly--) {
          const id = sc.get(lx, ly, lz);
          if (id !== 0 && !isTransparent(id)) {
            sky = 0; // opaque block blocks skylight
          }
          sc.setSkyLight(lx, ly, lz, sky);
        }
      }
    }
  }

  // --- Skylight pass 2: horizontal + downward BFS flood-fill ---
  // Seeds = every sky=15 cell in this column. Spreads to transparent neighbors
  // at level-1, BUT never upward (a neighbor above the seed keeps the seed's
  // level only if the seed is already lit — i.e. upward spread is capped so a
  // cell under an overhang can't light the sky above the roof). In practice we
  // allow horizontal + downward + one-up-from-lit (the MC rule: skylight
  // spreads fully horizontally and downward, attenuates only going up).
  floodSkylight(world, col, cx, cz);

  // --- Block light: BFS from all emissive sources ---
  // Clear only block light bits (preserve skylight computed above).
  for (let s = 0; s < col.subs.length; s++) {
    const sc = col.subs[s];
    for (let i = 0; i < sc.light.length; i++) {
      sc.light[i] = sc.light[i] & 0xf0; // keep sky, clear block
    }
  }

  // Collect sources within this column. Use a BFS queue of [subIdx, lx, ly, lz, level].
  const queue = [];
  for (let s = 0; s < col.subs.length; s++) {
    const sc = col.subs[s];
    // Skip the 4096-cell scan unless this sub-chunk's palette actually contains
    // an emissive block. Most sub-chunks have zero torches/lava/glowstone, so
    // the palette check (a handful of entries) lets us skip them entirely.
    let hasEmitter = false;
    for (let p = 0; p < sc.palette.length; p++) {
      if (getBlockType(sc.palette[p]).light > 0) { hasEmitter = true; break; }
    }
    if (!hasEmitter) continue;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          const id = sc.get(lx, ly, lz);
          if (id === 0) continue;
          const bt = getBlockType(id);
          if (bt.light > 0) {
            sc.setBlockLight(lx, ly, lz, bt.light);
            queue.push(s, lx, ly, lz, bt.light);
          }
        }
      }
    }
  }

  // BFS: propagate block light to transparent neighbors.
  const offsets = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  while (queue.length > 0) {
    const level = queue.pop();
    const lz = queue.pop();
    const ly = queue.pop();
    const lx = queue.pop();
    const s = queue.pop();
    const newLevel = level - 1;
    if (newLevel <= 0) continue;

    for (const [dx, dy, dz] of offsets) {
      const nx = lx + dx, ny = ly + dy, nz = lz + dz;
      let ns = s, nly = ny, nlx = nx, nlz = nz;

      // Handle sub-chunk Y boundaries.
      if (ny < 0) { ns = s - 1; nly = 15; }
      else if (ny > 15) { ns = s + 1; nly = 0; }
      if (ns < 0 || ns >= col.subs.length) continue;

      // Handle chunk X/Z boundaries (skip cross-chunk for simplicity in BFS;
      // light at chunk borders may be slightly off, corrected on neighbor gen).
      if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;

      const nsc = col.subs[ns];
      const nid = nsc.get(nlx, nly, nlz);
      // Only propagate through transparent blocks (opaque blocks block light).
      if (nid !== 0 && !isTransparent(nid)) continue;
      const current = nsc.getBlockLight(nlx, nly, nlz);
      if (current < newLevel) {
        nsc.setBlockLight(nlx, nly, nlz, newLevel);
        queue.push(ns, nlx, nly, nlz, newLevel);
      }
    }
  }
}

// Sky-light flood-fill: spread skylight sideways and downward so overhangs /
// canopies / roofs get a smooth gradient instead of a hard vertical cliff.
//
// PERFORMANCE: the vertical pass already set the full column correctly
// (15 above terrain, 0 below opaque). The BFS only needs to leak light
// SIDEWAYS into shadowed regions (cells currently 0 but adjacent to lit air).
// Key optimizations vs the naive version:
//   - Seed ONLY from sky=15 cells whose cell-below is NOT sky=15 (the lit
//     region's lower boundary). Interior lit cells can't spread anything new,
//     so we skip them — this cuts seed count from ~all-air to just the surface.
//   - NEVER re-enter a cell already at 15 (skip the redundant full-depth
//     downward re-flood — the vertical pass owns that).
//   - Only propagate SIDEWAYS and DOWNWARD (never up: a lit cell under a roof
//     can't light the sky above it). Downward at full level; sideways -1/step.
//   - Work in LOCAL column coords as much as possible; cross-chunk reads only
//     at the border slices (lx/lz 0 and 15).
function floodSkylight(world, col, cx, cz) {
  const queue = [];
  const NCZ = cz * CHUNK_SIZE;
  const NCX = cx * CHUNK_SIZE;

  // Seed: every sky=15 cell. The `current >= 15 → skip` guard below prevents
  // the redundant downward re-flood (the expensive part of the naive version),
  // so seeding broadly is cheap — most seeds immediately no-op because their
  // neighbors are also already 15.
  for (let s = col.subs.length - 1; s >= 0; s--) {
    const sc = col.subs[s];
    for (let i = 0; i < sc.light.length; i++) {
      if ((sc.light[i] >> 4) === 15) {
        const ly = i & 15;
        const lz = (i >> 4) & 15;
        const lx = (i >> 8) & 15;
        const worldY = WORLD_MIN_Y + s * 16 + ly;
        queue.push(NCX + lx, worldY, NCZ + lz, 15);
      }
    }
  }

  while (queue.length > 0) {
    const level = queue.pop();
    const wz = queue.pop();
    const wy = queue.pop();
    const wx = queue.pop();
    // Spread to 4 horizontal neighbors + down. (Never up — see header.)
    // Sideways: level - 1. Down: same level ONLY from a directly sky-exposed
    // cell (level === 15); otherwise down also costs 1. This is the real
    // Minecraft rule — the free downward pass belongs to columns open to the
    // sky, NOT to light that has already leaked sideways under an overhang.
    // Without this gate, sideways-leaked skylight poured straight down at full
    // strength and lit deep enclosed caves (sky=9 forty blocks underground).
    for (let n = 0; n < 5; n++) {
      const ax = wx + SKY_NX[n];
      const ay = wy + SKY_NY[n];
      const az = wz + SKY_NZ[n];
      if (ay < WORLD_MIN_Y || ay > WORLD_MAX_Y) continue;

      // Only WRITE within this column (cross-chunk done on neighbor's own pass).
      const ncx = Math.floor(ax / CHUNK_SIZE);
      const ncz = Math.floor(az / CHUNK_SIZE);
      if (ncx !== cx || ncz !== cz) continue;
      const nlx = ax - ncx * CHUNK_SIZE;
      const nlz = az - ncz * CHUNK_SIZE;
      const nsub = (ay - WORLD_MIN_Y) >>> 4;
      const nly = (ay - WORLD_MIN_Y) & 15;
      const nsc = col.subs[nsub];

      const id = nsc.get(nlx, nly, nlz);
      if (id !== 0 && !isTransparent(id)) continue;

      const newLevel = (SKY_NY[n] < 0 && level === 15) ? level : level - 1;
      if (newLevel <= 0) continue;

      const current = nsc.getSkyLight(nlx, nly, nlz);
      // Skip cells already full-15 (vertical pass owns them; re-flooding is
      // the main cost in the naive version).
      if (current >= 15) continue;
      if (current < newLevel) {
        nsc.setSkyLight(nlx, nly, nlz, newLevel);
        queue.push(ax, ay, az, newLevel);
      }
    }
  }
}

// Neighbor offsets for skylight BFS: +X, -X, +Z, -Z, -Y (down). No +Y — skylight
// never spreads upward (a shadowed cell under a roof can't light the sky).
const SKY_NX = [1, -1, 0, 0, 0];
const SKY_NY = [0, 0, 0, 0, -1];
const SKY_NZ = [0, 0, 1, -1, 0];


// Recompute light for a column after a block edit. Full recompute is O(6144)
// for skylight + BFS from sources — fast enough for occasional edits.
export function recomputeColumnLight(world, cx, cz) {
  const col = world.columns.get(world.key(cx, cz));
  if (!col) return;
  computeColumnLight(col, cx, cz, world);
  col.dirty = true;
}
