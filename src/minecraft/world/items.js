// Voxelcraft — Phase 15: block drops + item pickup.
//
// When a block is broken, a small spinning cube entity spawns at the block's
// position using the block's drop (from the registry's `drops` field). The
// entity falls with gravity, rests on the ground, bobs + spins, and is
// attracted toward the player within 1.5 blocks. On contact (< 0.6 blocks)
// it's added to the inventory and removed.
//
// Item meshes are cached per block type (shared geometry + material) so
// spawning/collecting is cheap. Geometry is a 0.3³ cube with UVs remapped
// to the block's primary atlas tile.

import * as THREE from 'three';
import { BLOCK, BLOCK_REGISTRY } from '../engine/blocks.js';
import { isSolid } from '../engine/blocks.js';
import { ITEM_REGISTRY } from '../engine/items.js';

const ITEM_SIZE = 0.3;
const GRAVITY = 16;
const PICKUP_RADIUS = 1.5;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const COLLECT_RADIUS_SQ = 0.36; // ~0.6 blocks
const PICKUP_COOLDOWN = 0.5; // seconds before a newly-dropped item can be collected
const LIFETIME = 300; // seconds before despawn (5 min)

export class ItemDrops {
  constructor(scene, atlasTexture, uvMap, world) {
    this.scene = scene;
    this.atlasTexture = atlasTexture;
    this.uvMap = uvMap;
    this.world = world;
    this.items = []; // { mesh, payload:{kind,id}, pos, vel, age, cooldown }
    this.geoCache = new Map(); // cacheKey → BoxGeometry
    this.mat = new THREE.MeshBasicMaterial({ map: atlasTexture });
  }

  // Resolve the atlas tile name for a payload (block primary face or item texture).
  _tileFor(payload) {
    if (payload.kind === 'item') {
      const it = ITEM_REGISTRY.get(payload.id);
      return it ? it.texture : null;
    }
    const type = BLOCK_REGISTRY[payload.id];
    return type ? type.textures[0] : null;
  }

  // Get or create a cached geometry for this payload (block or item).
  _getGeometry(payload) {
    const key = (payload.kind || 'block') + ':' + payload.id;
    let geo = this.geoCache.get(key);
    if (geo) return geo;
    geo = new THREE.BoxGeometry(ITEM_SIZE, ITEM_SIZE, ITEM_SIZE);
    const tileName = this._tileFor(payload);
    if (tileName) {
      // Remap UVs to the atlas tile.
      const uvRect = this.uvMap.get(tileName) || [0, 0, 1, 1];
      const [u0, v0, u1, v1] = uvRect;
      const uvAttr = geo.attributes.uv;
      for (let i = 0; i < uvAttr.count; i++) {
        const u = uvAttr.getX(i);
        const v = uvAttr.getY(i);
        uvAttr.setXY(i, u0 + u * (u1 - u0), v0 + v * (v1 - v0));
      }
      uvAttr.needsUpdate = true;
    }
    this.geoCache.set(key, geo);
    return geo;
  }

  // Spawn a dropped item at (x, y, z) with a small upward pop. `payload` is
  // either a numeric block id (legacy: treated as {kind:'block',id}) or a
  // {kind, id} object (supports items). AIR / nonexistent payloads are skipped.
  spawn(x, y, z, payload) {
    // Normalize legacy numeric-id calls to a {kind:'block',id} payload.
    const p = (typeof payload === 'object' && payload !== null)
      ? { kind: payload.kind || 'block', id: payload.id }
      : { kind: 'block', id: payload };
    if (p.kind === 'block' && p.id === BLOCK.AIR) return;
    if (p.kind === 'item' && !ITEM_REGISTRY.has(p.id)) return;
    const geo = this._getGeometry(p);
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.scale.set(1, 1, 1);
    this.scene.add(mesh);
    this.items.push({
      mesh,
      payload: p,
      x: x + 0.5,
      y: y + 0.5,
      z: z + 0.5,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 2.5,
      vz: (Math.random() - 0.5) * 1.5,
      age: 0,
      cooldown: PICKUP_COOLDOWN,
    });
  }

  // Update all items: physics, spin, attraction, pickup.
  // Returns an array of { blockId, count } for collected items.
  update(dt, playerX, playerY, playerZ) {
    const collected = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.age += dt;
      item.cooldown = Math.max(0, item.cooldown - dt);

      // Gravity + ground collision.
      item.vy -= GRAVITY * dt;
      let nx = item.x + item.vx * dt;
      let ny = item.y + item.vy * dt;
      let nz = item.z + item.vz * dt;

      // Simple ground check: if the block below is solid, rest on top.
      if (item.vy < 0) {
        const groundBlock = this.world.getBlock(
          Math.floor(item.x),
          Math.floor(ny - 0.15),
          Math.floor(item.z)
        );
        if (isSolid(groundBlock)) {
          ny = Math.floor(ny) + 1.0;
          item.vy = 0;
          // Friction on ground.
          item.vx *= 0.6;
          item.vz *= 0.6;
          if (Math.abs(item.vx) < 0.01) item.vx = 0;
          if (Math.abs(item.vz) < 0.01) item.vz = 0;
        }
      }

      item.x = nx;
      item.y = ny;
      item.z = nz;

      // Spin + bob.
      item.mesh.rotation.y += dt * 2;
      item.mesh.position.set(
        item.x,
        item.y + Math.sin(item.age * 3) * 0.08 + 0.15,
        item.z
      );

      // Despawn after lifetime.
      if (item.age > LIFETIME) {
        this._remove(i);
        continue;
      }

      // Attraction toward player.
      const dx = playerX - item.x;
      const dy = playerY - item.y;
      const dz = playerZ - item.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (item.cooldown <= 0) {
        if (distSq < COLLECT_RADIUS_SQ) {
          // Pickup! Return a {kind,id,count} payload the inventory understands.
          collected.push({ kind: item.payload.kind, id: item.payload.id, count: 1 });
          this._remove(i);
          continue;
        }
        if (distSq < PICKUP_RADIUS_SQ) {
          // Accelerate toward player.
          const dist = Math.sqrt(distSq);
          const pull = 6 * dt;
          item.x += dx / dist * pull;
          item.y += dy / dist * pull;
          item.z += dz / dist * pull;
        }
      }
    }
    return collected;
  }

  _remove(index) {
    const item = this.items[index];
    this.scene.remove(item.mesh);
    // Don't dispose geometry — it's cached + shared.
    this.items.splice(index, 1);
  }

  get count() {
    return this.items.length;
  }
}
