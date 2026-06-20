// Voxelcraft — Phase 3: chunk streamer (Phase 5+ perf pass).
//
// Maintains a ring of loaded + meshed chunk columns around a focus point.
// Each frame:
//   1. Unload columns beyond `unloadDistance`.
//   2. Generate missing columns within `genDistance` (slightly wider than
//      the mesh radius so collision always works ahead of the player).
//   3. Re-mesh dirty columns (nearest-first) under a TIME BUDGET so a single
//      frame never stalls for hundreds of ms. When a column finishes meshing,
//      its 4 horizontal neighbors are marked dirty so border faces re-mesh
//      against the now-correct neighbor data (fixes stale-face holes).

import { CHUNK_SIZE } from './world.js';
import { generateColumn } from '../world/generator.js';
import { buildColumnMeshes } from '../world/chunkmesh.js';

export class Streamer {
  constructor(world, scene, opaqueMaterial, transparentMaterial) {
    this.world = world;
    this.scene = scene;
    this.opaqueMaterial = opaqueMaterial;
    this.transparentMaterial = transparentMaterial;
    this.renderDistance = 8;    // mesh radius
    this.genDistance = 10;     // generate radius (wider → collision ahead)
    this.unloadDistance = 12;   // R+4 hysteresis
    // Both gen and mesh now run under a shared per-frame time budget (see
    // update): as many columns as fit within ~12 ms total, nearest-first. This
    // replaces the old fixed `maxLoadsPerFrame=6` which could blow the frame
    // budget (6 × ~16 ms = 96 ms stalls at startup). Caps prevent a runaway
    // frame if generation is somehow free.
    this.genBudgetMs = 6;       // max time spent generating per frame
    this.meshBudgetMs = 12;     // max time spent meshing per frame (priority: visible fill)
    this.maxLoadsPerFrame = 12; // hard cap (safety, rarely hit)
    this._frameStartTime = 0;
    // Optional hook: called as (cx, cz, world) right after a column generates.
    // main.js sets this to drive mob spawning (Phase 19). Decouples the streamer
    // from the mob/sky systems — it just notifies.
    this.onColumnGenerated = null;
  }

  update(focusX, focusZ) {
    this._frameStartTime = (typeof performance !== 'undefined' ? performance : Date).now();
    const fcx = Math.floor(focusX / CHUNK_SIZE);
    const fcz = Math.floor(focusZ / CHUNK_SIZE);
    const R = this.renderDistance;
    const R2 = R * R;
    const GD = this.genDistance;
    const GD2 = GD * GD;

    // 1. Unload distant columns.
    const UD = this.unloadDistance;
    const UD2 = UD * UD;
    for (const [key, column] of this.world.columns) {
      const dx = column.cx - fcx;
      const dz = column.cz - fcz;
      if (dx * dx + dz * dz > UD2) {
        this._removeColumnMeshes(column);
        this.world.columns.delete(key);
      }
    }

    // 2. Generate missing columns within genDistance (nearest-first, limited).
    const toLoad = [];
    for (let dx = -GD; dx <= GD; dx++) {
      for (let dz = -GD; dz <= GD; dz++) {
        if (dx * dx + dz * dz > GD2) continue;
        const cx = fcx + dx;
        const cz = fcz + dz;
        const col = this.world.columns.get(this.world.key(cx, cz));
        if (!col || !col.generated) {
          toLoad.push({ cx, cz, d2: dx * dx + dz * dz });
        }
      }
    }
    toLoad.sort((a, b) => a.d2 - b.d2);

    let loaded = 0;
    for (const { cx, cz } of toLoad) {
      if (loaded >= this.maxLoadsPerFrame) break;
      generateColumn(this.world, cx, cz);
      // Mark the 4 neighbors dirty so they re-mesh border faces against this
      // newly-generated column (fixes stale-face holes at chunk borders).
      this._markNeighborDirty(cx - 1, cz);
      this._markNeighborDirty(cx + 1, cz);
      this._markNeighborDirty(cx, cz - 1);
      this._markNeighborDirty(cx, cz + 1);
      // Notify any spawn hook (mob spawning, Phase 19).
      if (this.onColumnGenerated) this.onColumnGenerated(cx, cz, this.world);
      loaded++;
      // Time-budget the generation so a single frame never stalls. Check after
      // the first column so we always make progress, then stop when over budget.
      if (loaded > 1) {
        const elapsed = (typeof performance !== 'undefined' ? performance : Date).now() - this._frameStartTime;
        if (elapsed > this.genBudgetMs) break;
      }
    }

    // 3. Re-mesh dirty columns (nearest-first) under a time budget.
    const dirty = [];
    for (const column of this.world.columns.values()) {
      if (column.dirty && column.generated) {
        const dx = column.cx - fcx;
        const dz = column.cz - fcz;
        dirty.push({ column, d2: dx * dx + dz * dz });
      }
    }
    dirty.sort((a, b) => a.d2 - b.d2);

    let meshed = 0;
    // Reset the timer before the mesh phase so generation time doesn't eat the
    // mesh budget (each phase gets its own full budget; total stays bounded).
    const meshStart = (typeof performance !== 'undefined' ? performance : Date).now();
    for (const { column } of dirty) {
      // Stop if we've exceeded the time budget AND we've done at least 1.
      if (meshed > 0) {
        const elapsed = (typeof performance !== 'undefined' ? performance : Date).now() - meshStart;
        if (elapsed > this.meshBudgetMs) break;
      }
      this._remeshColumn(column);
      meshed++;
    }
  }

  _markNeighborDirty(cx, cz) {
    const col = this.world.columns.get(this.world.key(cx, cz));
    if (col && col.generated && col.meshes) {
      col.dirty = true; // force re-mesh so border faces update
    }
  }

  remeshAll() {
    for (const column of this.world.columns.values()) {
      if (column.generated) this._remeshColumn(column);
    }
  }

  _remeshColumn(column) {
    this._removeColumnMeshes(column);
    const { opaque, transparent } = buildColumnMeshes(
      this.world, column, this.opaqueMaterial, this.transparentMaterial
    );
    column.meshes = { opaque, transparent };
    for (const m of opaque) this.scene.add(m);
    for (const m of transparent) this.scene.add(m);
    column.dirty = false;
  }

  _removeColumnMeshes(column) {
    if (!column.meshes) return;
    for (const m of column.meshes.opaque) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    for (const m of column.meshes.transparent) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    column.meshes = null;
  }

  meshCount() {
    let n = 0;
    for (const col of this.world.columns.values()) {
      if (col.meshes) n += col.meshes.opaque.length + col.meshes.transparent.length;
    }
    return n;
  }
}