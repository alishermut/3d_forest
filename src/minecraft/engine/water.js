// Voxelcraft — Phase 17: flowing water (finite fluid simulation).
//
// A Minecraft-style finite water model layered ON TOP of the existing voxel
// world WITHOUT touching terrain gen, lighting, or the mesher. Water cells are
// ordinary BLOCK.WATER voxels; this sim only decides WHERE water blocks should
// exist and re-meshes the affected columns via the normal dirty flag.
//
// Level model (higher = more water):
//   - SOURCE (8): a WATER block NOT tracked in `level` — settled/infinite
//     water from world generation (oceans, lakes). Never dries. This is why
//     digging into the ocean floods endlessly, exactly like Minecraft.
//   - FALLING (8, tracked): a flowing cell fed by water directly above. Full
//     height, only feeds downward, can dry when its feed is cut.
//   - FLOWING (1..7, tracked): horizontal spread. Each block away from a full
//     source loses 1 level; at 0 the water stops (max reach 7 blocks).
//
// Propagation is a relaxation over an update queue:
//   - An AIR cell becomes water if water is directly above (→ falling) or a
//     horizontal neighbour has level >= 2 (→ that level - 1).
//   - A FLOWING cell recomputes its level each tick as max(neighbour levels)-1
//     (or 8 if fed from above). If that drops below 1 it dries to AIR. Removing
//     a source therefore makes the whole stream recede, cell by cell.
//
// Only DISTURBED cells are simulated (queued on block break/place), so settled
// oceans cost nothing until you dig into them. One ring of cells advances per
// tick, giving a visible progressive flow.

import { BLOCK, isSolid } from './blocks.js';
import { CHUNK_SIZE } from './world.js';

const SOURCE = 8;   // settled/source water OR falling water: full height
const FALLING = 8;  // a tracked full cell fed from above (can dry)
const TICK_INTERVAL = 0.18;       // seconds between simulation steps
const MAX_UPDATES_PER_TICK = 4000; // safety cap; overflow defers to next tick

function key(x, y, z) { return x + ',' + y + ',' + z; }

export class WaterSim {
  constructor(world) {
    this.world = world;
    this.level = new Map();        // key -> tracked level (1..8); absent = source
    this.queue = new Set();        // keys pending evaluation
    this._accum = 0;
    this._dirtyCols = new Set();    // column keys re-meshed this tick
  }

  // Level of the water at a cell: 8 settled/source, 1..8 tracked, 0 if not water.
  levelAt(x, y, z) {
    if (this.world.getBlock(x, y, z) !== BLOCK.WATER) return 0;
    const v = this.level.get(key(x, y, z));
    return v === undefined ? SOURCE : v;
  }

  _isAir(x, y, z) { return this.world.getBlock(x, y, z) === BLOCK.AIR; }

  // Level this cell contributes to HORIZONTAL spread.
  //   - SOURCE (settled gen water): always 8 — oceans/lakes always push into any
  //     adjacent air (so digging a channel floods it).
  //   - FLOWING/FALLING (tracked): spreads sideways ONLY when resting on SOLID
  //     ground. A mid-fall cell has water (or air) below — not solid — so it
  //     contributes 0 and the falling column stays 1 wide; only where the stream
  //     lands on solid does it fan out into a puddle. This is the Minecraft rule.
  _horizLevel(x, y, z) {
    if (this.world.getBlock(x, y, z) !== BLOCK.WATER) return 0;
    const v = this.level.get(key(x, y, z));
    if (v === undefined) return SOURCE;                       // source: always spreads
    if (!isSolid(this.world.getBlock(x, y - 1, z))) return 0; // flowing: only when grounded
    return v;
  }

  // Public hook: call after any block change (break/place) at (x,y,z). Queues
  // the cell + its 6 neighbours so the sim re-evaluates the disturbed region.
  notify(x, y, z) {
    this._enqueue(x, y, z);
    this._enqueueNeighbors(x, y, z);
  }

  _enqueue(x, y, z) { this.queue.add(key(x, y, z)); }
  _enqueueNeighbors(x, y, z) {
    this.queue.add(key(x + 1, y, z)); this.queue.add(key(x - 1, y, z));
    this.queue.add(key(x, y + 1, z)); this.queue.add(key(x, y - 1, z));
    this.queue.add(key(x, y, z + 1)); this.queue.add(key(x, y, z - 1));
  }

  // Advance the simulation. Process one ring of queued cells per TICK_INTERVAL.
  tick(dt) {
    this._accum += dt;
    if (this._accum < TICK_INTERVAL) return;
    this._accum = 0;
    if (this.queue.size === 0) return;

    // Snapshot this tick's work; cells enqueued during processing run next tick
    // (this is what makes water advance one block-ring per tick, visibly).
    const batch = this.queue;
    this.queue = new Set();
    let n = 0;
    for (const k of batch) {
      if (n++ >= MAX_UPDATES_PER_TICK) { this.queue.add(k); continue; }
      const c = k.split(',');
      this._evaluate(+c[0], +c[1], +c[2]);
    }
  }

  _setWater(x, y, z, lvl) {
    this.world.setBlock(x, y, z, BLOCK.WATER); // marks the column dirty
    if (lvl >= SOURCE) this.level.set(key(x, y, z), FALLING); // tracked full (can dry)
    else this.level.set(key(x, y, z), lvl);
    this._markDirty(x, z);
    this._enqueueNeighbors(x, y, z);
  }

  _setAir(x, y, z) {
    this.world.setBlock(x, y, z, BLOCK.AIR);
    this.level.delete(key(x, y, z));
    this._markDirty(x, z);
    this._enqueueNeighbors(x, y, z);
  }

  _evaluate(x, y, z) {
    const b = this.world.getBlock(x, y, z);

    if (b === BLOCK.AIR) {
      // Fill from above (falling) first, else from supported horizontal
      // neighbours (_horizLevel excludes falling water).
      if (this.levelAt(x, y + 1, z) > 0) { this._setWater(x, y, z, FALLING); return; }
      const maxN = Math.max(
        this._horizLevel(x + 1, y, z), this._horizLevel(x - 1, y, z),
        this._horizLevel(x, y, z + 1), this._horizLevel(x, y, z - 1)
      );
      if (maxN >= 2) this._setWater(x, y, z, maxN - 1);
      return;
    }

    if (b !== BLOCK.WATER) return; // solid block placed here — nothing to do

    const k = key(x, y, z);
    const tracked = this.level.has(k);
    const belowAir = this._isAir(x, y - 1, z);

    if (!tracked) {
      // SOURCE: never changes. Always feed straight down; spread sideways only
      // when it can't fall (supported), matching the falling-vs-spreading rule.
      this._propagate(x, y, z, belowAir);
      return;
    }

    // FLOWING/FALLING: recompute the level this cell should have.
    let desired;
    if (this.levelAt(x, y + 1, z) > 0) {
      desired = FALLING; // fed from above → stays full
    } else {
      const maxN = Math.max(
        this._horizLevel(x + 1, y, z), this._horizLevel(x - 1, y, z),
        this._horizLevel(x, y, z + 1), this._horizLevel(x, y, z - 1)
      );
      desired = maxN - 1;
    }

    if (desired < 1) { this._setAir(x, y, z); return; }

    const cur = this.level.get(k);
    if (desired !== cur) {
      this.level.set(k, desired);
      this._markDirty(x, z);
      this._enqueueNeighbors(x, y, z);
    }
    this._propagate(x, y, z, belowAir);
  }

  // Queue where this water flows next: straight down if air below (and stop —
  // it can't also spread sideways), otherwise the 4 horizontal air neighbours.
  _propagate(x, y, z, belowAir) {
    if (belowAir) { this._enqueue(x, y - 1, z); return; }
    if (this._horizLevel(x, y, z) > 1) {
      if (this._isAir(x + 1, y, z)) this._enqueue(x + 1, y, z);
      if (this._isAir(x - 1, y, z)) this._enqueue(x - 1, y, z);
      if (this._isAir(x, y, z + 1)) this._enqueue(x, y, z + 1);
      if (this._isAir(x, y, z - 1)) this._enqueue(x, y, z - 1);
    }
  }

  // Mark the column containing (x,z) dirty, plus border-neighbour columns so
  // chunk-edge faces re-mesh (mirrors main.js markDirty for player edits).
  _markDirty(x, z) {
    const w = this.world;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const mark = (gx, gz) => { const c = w.columns.get(w.key(gx, gz)); if (c) c.dirty = true; };
    mark(cx, cz);
    if (lx === 0) mark(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) mark(cx + 1, cz);
    if (lz === 0) mark(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) mark(cx, cz + 1);
  }

  get activeCount() { return this.level.size; }
  get pending() { return this.queue.size; }
}
