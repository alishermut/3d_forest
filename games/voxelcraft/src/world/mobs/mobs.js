// Voxelcraft — Phase 19: passive mobs (sheep, cow, pig, chicken).
//
// A standalone MobManager (parallel to ItemDrops — no shared entity base class
// exists, and forcing one for Phase 19+20 alone is over-engineering). Each Mob
// owns a cube-built THREE.Group model (Minecraft-style: body + head + 4 legs,
// textured from the atlas), wanders with gravity + swept-AABB collision, has
// type-specific HP, and on death emits drop events that the caller spawns via
// ItemDrops (so mob drops reuse the proven physics + pickup flow).
//
// AI is deliberately simple (per the Phase 19 decision): random wander within a
// home radius, gravity + wall-slide via the parametrized collision, idle
// pauses, leg animation scaled to speed. No pathfinding — turns on wall hits.
// Breeding, sounds, and hostile AI are deferred.

import * as THREE from 'three';
import { moveAndCollide, PLAYER_DIMS } from '../../engine/collision.js';
import { isSolid } from '../../engine/blocks.js';
import { BLOCK, BLOCK_REGISTRY } from '../../engine/blocks.js';
import { ITEM } from '../../engine/items.js';

// --- Per-type configuration ------------------------------------------------
// Dims are half-width × height (matches the collision AABB contract). Speed in
// blocks/sec; hp in half-hearts-equivalent (fist = 1 dmg/ hit). Drops are
// arrays of {kind,id,count} payloads the manager emits on death.
export const MOB_TYPES = {
  sheep: {
    half: 0.45, height: 1.3, speed: 2.3, hp: 8,
    drops: [{ kind: 'item', id: ITEM.WOOL, count: 1 }, { kind: 'item', id: ITEM.MUTTON, count: 1 }],
    build: buildSheep,
  },
  cow: {
    half: 0.45, height: 1.4, speed: 2.1, hp: 10,
    drops: [{ kind: 'item', id: ITEM.LEATHER, count: 2 }, { kind: 'item', id: ITEM.BEEF, count: 1 }],
    build: buildCow,
  },
  pig: {
    half: 0.45, height: 1.0, speed: 2.4, hp: 10,
    drops: [{ kind: 'item', id: ITEM.PORKCHOP, count: 2 }],
    build: buildPig,
  },
  chicken: {
    half: 0.3, height: 0.7, speed: 2.0, hp: 4,
    drops: [{ kind: 'item', id: ITEM.FEATHER, count: 1 }, { kind: 'item', id: ITEM.CHICKEN, count: 1 }],
    build: buildChicken,
  },
};

const GRAVITY = 22;
const DESPAWN_DIST_SQ = 80 * 80;
const HOME_RADIUS = 14;
const HOME_RADIUS_SQ = HOME_RADIUS * HOME_RADIUS;
const MOB_CAP = 12;
const REACH = 4.0;          // LMB attack reach (blocks)
const FIST_DAMAGE = 1;
const HURT_FLASH = 0.3;     // seconds of red flash after being hit

// --- Mob -------------------------------------------------------------------
class Mob {
  constructor(type, x, y, z, scene, uvMap, texture) {
    this.type = type;
    const cfg = MOB_TYPES[type];
    this.cfg = cfg;
    this.dims = { half: cfg.half, height: cfg.height };
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.hp = cfg.hp;
    this.maxHp = cfg.hp;
    this.scene = scene;
    this.dead = false;
    this.hurtTimer = 0;
    this.facing = Math.random() * Math.PI * 2; // yaw
    // Wander AI state.
    this.aiTimer = 0;       // counts down the current wander/idle segment
    this.aiMoving = false;
    this.moveDir = Math.random() * Math.PI * 2;
    // Build the model Group; legs array for animation.
    const built = cfg.build(uvMap, texture);
    this.group = built.group;
    this.legs = built.legs || [];
    this.legPhase = 0;
    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  damage(amount, knockDir) {
    if (this.dead) return;
    this.hp -= amount;
    this.hurtTimer = HURT_FLASH;
    // Knockback: brief horizontal impulse away from the attacker.
    if (knockDir) {
      this.vel.x += knockDir.x * 4.5;
      this.vel.z += knockDir.z * 4.5;
    }
    if (this.hp <= 0) this.dead = true;
  }

  update(dt, world) {
    if (this.dead) return null;
    if (this.hurtTimer > 0) this.hurtTimer -= dt;

    // --- AI: pick a new wander/idle segment when the timer expires ---
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) {
      // ~60% chance to move, else idle. Segment lasts 2-5s.
      this.aiMoving = Math.random() < 0.6;
      this.aiTimer = 2 + Math.random() * 3;
      if (this.aiMoving) this.moveDir = Math.random() * Math.PI * 2;
    }

    // --- Desired horizontal velocity from AI ---
    let desiredVX = 0, desiredVZ = 0;
    if (this.aiMoving) {
      // If wandered too far from home, steer back toward it instead.
      const dx = this.homeX - this.pos.x;
      const dz = this.homeZ - this.pos.z;
      if (dx * dx + dz * dz > HOME_RADIUS_SQ) {
        this.moveDir = Math.atan2(dz, dx);
      }
      desiredVX = Math.cos(this.moveDir) * this.cfg.speed;
      desiredVZ = Math.sin(this.moveDir) * this.cfg.speed;
      this.facing = this.moveDir;
    }

    // Smooth toward desired horizontal velocity (simple damping).
    const damp = 1 - Math.exp(-8 * dt);
    this.vel.x += (desiredVX - this.vel.x) * damp;
    this.vel.z += (desiredVZ - this.vel.z) * damp;

    // --- Gravity ---
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -30) this.vel.y = -30;

    // --- Collision-resolved movement (reuses the player swept-AABB) ---
    const delta = new THREE.Vector3(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt);
    const prevY = this.pos.y;
    const result = moveAndCollide(world, this.pos, delta, this.dims);
    if (result.hitX || result.hitZ) {
      // Hit a wall: pick a fresh direction next segment (turn now).
      this.moveDir = Math.random() * Math.PI * 2;
      this.aiTimer = Math.min(this.aiTimer, 0.3);
    }
    if (result.onGround) {
      this.vel.y = 0;
    } else if (result.hitY && this.vel.y > 0) {
      this.vel.y = 0; // bonked head
    }
    // Friction on ground when not actively moving.
    if (result.onGround && !this.aiMoving) {
      this.vel.x *= 0.8; this.vel.z *= 0.8;
    }

    // --- Sync model: position + facing + leg animation ---
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.facing;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.legs.length && speed > 0.1) {
      this.legPhase += dt * speed * 3;
      const swing = Math.sin(this.legPhase) * 0.5;
      this.legs[0].rotation.x = swing;
      this.legs[1].rotation.x = -swing;
      this.legs[2].rotation.x = -swing;
      this.legs[3].rotation.x = swing;
    }

    // --- Hurt flash: tint the model red while hurtTimer > 0 ---
    if (this.hurtTimer > 0) {
      const t = this.hurtTimer / HURT_FLASH;
      this._tint(1, 1 - 0.7 * t, 1 - 0.7 * t);
    } else {
      this._tint(1, 1, 1);
    }

    if (this.dead) {
      return { type: 'death', x: this.pos.x, y: this.pos.y, z: this.pos.z, drops: this.cfg.drops };
    }
    return null;
  }

  // Set emissive-ish tint by scaling each child mesh's material color. Cheap
  // hurt flash without a custom shader.
  _tint(r, g, b) {
    this.group.traverse((o) => {
      if (o.material) {
        if (!o.material.userData.baseColor) {
          o.material.userData.baseColor = o.material.color.clone();
        }
        o.material.color.setRGB(
          o.material.userData.baseColor.r * r,
          o.material.userData.baseColor.g * g,
          o.material.userData.baseColor.b * b
        );
      }
    });
  }

  // Hit-test: ray vs this mob's AABB. `origin`/`dir` are THREE.Vector3 (dir
  // normalized). Returns the hit distance along the ray, or Infinity if miss.
  rayHit(origin, dir) {
    const half = this.dims.half;
    const h = this.dims.height;
    // AABB min/max in world space (mob pos = feet center).
    const minX = this.pos.x - half, maxX = this.pos.x + half;
    const minY = this.pos.y, maxY = this.pos.y + h;
    const minZ = this.pos.z - half, maxZ = this.pos.z + half;
    const tx1 = (minX - origin.x) / dir.x;
    const tx2 = (maxX - origin.x) / dir.x;
    const ty1 = (minY - origin.y) / dir.y;
    const ty2 = (maxY - origin.y) / dir.y;
    const tz1 = (minZ - origin.z) / dir.z;
    const tz2 = (maxZ - origin.z) / dir.z;
    const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
    const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
    if (tmax < 0 || tmin > tmax) return Infinity;
    return tmin >= 0 ? tmin : tmax;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

// --- MobManager ------------------------------------------------------------
export class MobManager {
  constructor(scene, world, uvMap, texture) {
    this.scene = scene;
    this.world = world;
    this.uvMap = uvMap;
    this.texture = texture;
    this.mobs = [];
  }

  spawn(type, x, y, z) {
    if (this.mobs.length >= MOB_CAP) return null;
    const mob = new Mob(type, x, y, z, this.scene, this.uvMap, this.texture);
    mob.homeX = x; mob.homeZ = z;
    this.mobs.push(mob);
    return mob;
  }

  // Called by the streamer after a column generates. Mirrors placePlants:
  // deterministic position-hash RNG, biome + daylight gates, GRASS surface.
  onColumnGenerated(cx, cz, bm, daylight) {
    if (daylight < 0.5) return;             // daytime-only spawn
    if (this.mobs.length >= MOB_CAP) return;
    for (let lx = 0; lx < 16; lx++) {
      for (let lz = 0; lz < 16; lz++) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        const biome = bm.getBiome(wx, wz);
        const type = mobTypeForBiome(biome, wx, wz);
        if (!type) continue;
        // Low spawn rate (~0.4% per surface column) via distinct-salt hash.
        if (hash01(wx, wz, 71717) >= 0.004) continue;
        const height = bm.getBaseHeight(wx, wz);
        if (height <= 62) continue;          // not underwater
        const surface = this.world.getBlock(wx, height, wz);
        if (surface !== BLOCK.GRASS) continue;
        const above = this.world.getBlock(wx, height + 1, wz);
        if (above !== BLOCK.AIR) continue;
        // Spawn on top of the grass.
        this.spawn(type, wx + 0.5, height + 1, wz + 0.5);
        if (this.mobs.length >= MOB_CAP) return;
      }
    }
  }

  // Tick all mobs. Returns an array of events ({type:'death', ...}) for the
  // caller to process (spawn drops via ItemDrops).
  update(dt, playerPos) {
    const events = [];
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      const ev = mob.update(dt, this.world);
      if (ev) events.push(ev);
      // Despawn if too far from the player (frees the mob cap).
      const dx = mob.pos.x - playerPos.x;
      const dz = mob.pos.z - playerPos.z;
      if (dx * dx + dz * dz > DESPAWN_DIST_SQ || mob.dead) {
        mob.dispose();
        this.mobs.splice(i, 1);
      }
    }
    return events;
  }

  // LMB attack: ray-test all mobs, return the closest within reach. The caller
  // applies damage + knockback.
  tryHitMob(origin, dir) {
    let best = null;
    let bestT = REACH;
    for (const mob of this.mobs) {
      const t = mob.rayHit(origin, dir);
      if (t < bestT) { bestT = t; best = mob; }
    }
    return best ? { mob, distance: bestT } : null;
  }

  get count() { return this.mobs.length; }
}

// --- Mob-type selection by biome ------------------------------------------
function mobTypeForBiome(biome, wx, wz) {
  // v1 spawn biomes: Plains (all four), Forest (sheep/pig/chicken), Savanna
  // (cow/pig). Others return null (no passive mobs).
  switch (biome) {
    case 2: { // PLAINS
      const r = hash01(wx, wz, 919) * 4;
      if (r < 1) return 'sheep';
      if (r < 2) return 'cow';
      if (r < 3) return 'pig';
      return 'chicken';
    }
    case 3: { // FOREST
      const r = hash01(wx, wz, 920) * 3;
      if (r < 1) return 'sheep';
      if (r < 2) return 'pig';
      return 'chicken';
    }
    case 9: // SAVANNA
      return hash01(wx, wz, 921) < 0.5 ? 'cow' : 'pig';
    default:
      return null;
  }
}

// Deterministic position-hash RNG (same formula as features/plants.js).
function hash01(wx, wz, salt) {
  let h = (wx * 73856093) ^ (wz * 83492791) ^ (salt * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h % 100000) / 100000;
}

// --- Mob model builders ----------------------------------------------------
// Each builds a THREE.Group of textured boxes (body + head + 4 legs) sized so
// the whole thing fits the type's collision AABB. Materials share the atlas
// texture; UVs are remapped to the named tile per face via _faceMat(). Legs are
// returned in an array [FL, FR, BL, BR] for alternating animation.

function _box(w, h, d, uvMap, texture, tile) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uvRect = uvMap.get(tile) || [0, 0, 1, 1];
  const [u0, v0, u1, v1] = uvRect;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  return new THREE.Mesh(geo, mat);
}

// Sheep: white fleece body, grey head + legs. ~0.9 wide, 1.3 tall.
function buildSheep(uvMap, texture) {
  const g = new THREE.Group();
  const body = _box(0.9, 0.7, 1.3, uvMap, texture, 'sheep_fleece');
  body.position.y = 0.75; g.add(body);
  const head = _box(0.4, 0.4, 0.4, uvMap, texture, 'sheep_skin');
  head.position.set(0, 0.95, 0.85); g.add(head);
  const legs = [];
  for (const [x, z] of [[-0.3, 0.45], [0.3, 0.45], [-0.3, -0.45], [0.3, -0.45]]) {
    const leg = _box(0.25, 0.4, 0.25, uvMap, texture, 'sheep_skin');
    leg.position.set(x, 0.2, z);
    leg.geometry.translate(0, 0.2, 0); // pivot at top for rotation
    leg.position.y = 0.4;
    g.add(leg); legs.push(leg);
  }
  return { group: g, legs };
}

// Cow: brown-spotted body, tan head. ~0.9 wide, 1.4 tall.
function buildCow(uvMap, texture) {
  const g = new THREE.Group();
  const body = _box(0.9, 0.8, 1.4, uvMap, texture, 'cow_body');
  body.position.y = 0.85; g.add(body);
  const head = _box(0.45, 0.45, 0.45, uvMap, texture, 'cow_head');
  head.position.set(0, 1.05, 0.9); g.add(head);
  const legs = [];
  for (const [x, z] of [[-0.3, 0.5], [0.3, 0.5], [-0.3, -0.5], [0.3, -0.5]]) {
    const leg = _box(0.28, 0.45, 0.28, uvMap, texture, 'sheep_skin');
    leg.geometry.translate(0, 0.225, 0);
    leg.position.set(x, 0.45, z);
    g.add(leg); legs.push(leg);
  }
  return { group: g, legs };
}

// Pig: pink low body, pink head with snout. ~0.9 wide, 1.0 tall.
function buildPig(uvMap, texture) {
  const g = new THREE.Group();
  const body = _box(0.9, 0.6, 1.2, uvMap, texture, 'pig_skin');
  body.position.y = 0.6; g.add(body);
  const head = _box(0.45, 0.45, 0.45, uvMap, texture, 'pig_head');
  head.position.set(0, 0.65, 0.8); g.add(head);
  const legs = [];
  for (const [x, z] of [[-0.3, 0.4], [0.3, 0.4], [-0.3, -0.4], [0.3, -0.4]]) {
    const leg = _box(0.25, 0.3, 0.25, uvMap, texture, 'pig_skin');
    leg.geometry.translate(0, 0.15, 0);
    leg.position.set(x, 0.3, z);
    g.add(leg); legs.push(leg);
  }
  return { group: g, legs };
}

// Chicken: small white body, red comb, yellow beak. ~0.6 wide, 0.7 tall.
function buildChicken(uvMap, texture) {
  const g = new THREE.Group();
  const body = _box(0.5, 0.45, 0.6, uvMap, texture, 'chicken_white');
  body.position.y = 0.5; g.add(body);
  const head = _box(0.3, 0.3, 0.3, uvMap, texture, 'chicken_white');
  head.position.set(0, 0.85, 0.35); g.add(head);
  const comb = _box(0.12, 0.12, 0.2, uvMap, texture, 'chicken_red');
  comb.position.set(0, 1.0, 0.32); g.add(comb);
  const beak = _box(0.12, 0.1, 0.15, uvMap, texture, 'chicken_beak');
  beak.position.set(0, 0.83, 0.55); g.add(beak);
  // Chickens have small legs; animate them too.
  const legs = [];
  for (const x of [-0.12, 0.12]) {
    const leg = _box(0.08, 0.25, 0.08, uvMap, texture, 'chicken_red');
    leg.geometry.translate(0, 0.125, 0);
    leg.position.set(x, 0.25, 0);
    g.add(leg); legs.push(leg);
    // Duplicate the entry to make the 4-slot alternating animation work (2 legs).
    legs.push(leg);
  }
  return { group: g, legs };
}
