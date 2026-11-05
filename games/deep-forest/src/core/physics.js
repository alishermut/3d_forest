import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  getHeight,
  getHeightGrid,
  getWaterLevel as waterLevelAt,
  LAKE_WATER_Y,
  WORLD_SIZE,
  WORLD_RADIUS,
} from '../world/terrain.js';
import { getWaveHeight } from '../world/water.js';

// Set each frame from the render clock; floating bodies and the swimming
// camera ride the same waves the water shader displays.
let waveTime = 0;
export function setWaveTime(t) {
  waveTime = t;
}

// Water level including the visible lake waves (river surface stays flat).
function waterSurfaceAt(x, z) {
  const level = waterLevelAt(x, z);
  if (level === null) return null;
  if (Math.abs(level - LAKE_WATER_Y) < 0.01) {
    return level + getWaveHeight(x, z, waveTime);
  }
  return level;
}

// Physics foundation (Phase 8): Rapier in full — kinematic character
// controller for the player, static colliders for terrain/trees/logs,
// dynamic rigid bodies for everything that will one day break or float.

const FIXED_DT = 1 / 60;
const MAX_FALL_SPEED = 40;

// Capsule: total height 1.9 m, eye sits 1.7 m above the feet.
export const PLAYER = {
  radius: 0.35,
  halfHeight: 0.6,            // cylindrical section half-height
  get centerOffset() {        // capsule center above feet
    return this.halfHeight + this.radius;
  },
  get eyeOffset() {           // eye above capsule center
    return 1.7 - this.centerOffset;
  },
};

let world = null;
let playerBody = null;
let playerCollider = null;
// Surface kind per collider handle (combat arc): 'dirt' | 'wood' | 'rock'.
// Impact FX pick decal/particle/sound flavor from this.
const colliderKinds = new Map();
let characterController = null;
let verticalVelocity = 0;
let accumulator = 0;

const dynamicSyncs = []; // { body, mesh }

export async function initPhysics(
  scene,
  { trunks = [], logs = [], rocks = [] } = {},
  spawn = { x: 0, z: 8 }
) {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  createTerrainCollider();
  createTrunkColliders(trunks);
  createLogColliders(logs);
  for (const r of rocks) {
    const c = world.createCollider(
      RAPIER.ColliderDesc.ball(r.r).setTranslation(r.x, r.y, r.z)
    );
    colliderKinds.set(c.handle, 'rock');
  }
  createPlayer(spawn);
  createTestCrate(scene, spawn);
  verifyHeightfield();

  // Debug handle for the engine arc (water/buoyancy work will use it too).
  window.__phys = { world, RAPIER, dynamicSyncs };
}

// ---------------------------------------------------------------------------
// Terrain: heightfield from the SHARED height grid (Phase 16) — the exact
// same samples the render mesh uses, no second getHeight pass.
// ---------------------------------------------------------------------------
function createTerrainCollider() {
  const grid = getHeightGrid();
  const n = grid.n;

  // The shared grid is row-major over z (heights[iz*(n+1)+ix]); Rapier wants
  // column-major (index = col*(nrows+1)+row, columns spanning local X) —
  // transpose into Rapier's layout.
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let col = 0; col <= n; col++) {
    for (let row = 0; row <= n; row++) {
      heights[col * (n + 1) + row] = grid.heights[row * (n + 1) + col];
    }
  }

  const c = world.createCollider(
    RAPIER.ColliderDesc.heightfield(n, n, heights, {
      x: WORLD_SIZE,
      y: 1,
      z: WORLD_SIZE,
    })
  );
  colliderKinds.set(c.handle, 'dirt');
}

// Truth test: raycast the collider at sample points and compare against
// getHeight. Catches a transposed heightfield immediately.
function verifyHeightfield() {
  // Rapier's query pipeline (BVH) only exists after a step.
  world.step();
  // Sample points deliberately OFF the heightfield lattice (multiples of
  // the 1.5625 m grid pitch): a ray passing exactly through a triangle
  // edge/vertex can miss degenerately in Rapier (hit (150, 9) on the 576
  // grid — x/pitch = 96.0 exactly).
  const samples = [
    [37, -81], [-122, 54], [88, 133], [-15, -40], [150.7, 9.3], [-90.4, -149.3],
  ];
  const results = [];
  for (const [x, z] of samples) {
    const ray = new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 300, true);
    const rapierY = hit ? 100 - hit.timeOfImpact : null;
    results.push({
      x,
      z,
      rapier: rapierY === null ? null : +rapierY.toFixed(3),
      analytic: +getHeight(x, z).toFixed(3),
    });
  }
  const bad = results.some(
    (r) => r.rapier === null || Math.abs(r.rapier - r.analytic) > 0.25
  );
  if (bad) {
    console.error('[physics] heightfield mismatch vs getHeight!', results);
  }
  window.__physCheck = { ok: !bad, results };
}

// ---------------------------------------------------------------------------
// Static colliders
// ---------------------------------------------------------------------------
function createTrunkColliders(trunks) {
  for (const t of trunks) {
    const baseY = getHeight(t.x, t.z);
    // halfH: forest trunks are 8 m tall; the world tree (Phase 39) passes a
    // taller cylinder so its thick trunk can't be jumped "into".
    const halfH = t.halfH ?? 4;
    const c = world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfH, t.r).setTranslation(
        t.x,
        baseY + halfH - 0.4,
        t.z
      )
    );
    colliderKinds.set(c.handle, 'wood');
  }
}

function createLogColliders(logs) {
  const qLie = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, 0, Math.PI / 2) // cylinder axis Y -> X
  );
  for (const l of logs) {
    const q = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(l.tilt, l.yaw, 0))
      .multiply(qLie);
    const c = world.createCollider(
      RAPIER.ColliderDesc.cylinder(l.halfLen, l.r)
        .setTranslation(l.x, l.y, l.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    );
    colliderKinds.set(c.handle, 'wood');
  }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
function createPlayer(spawn) {
  const y = getHeight(spawn.x, spawn.z) + PLAYER.centerOffset + 0.2;
  playerBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, y, spawn.z)
  );
  playerCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius),
    playerBody
  );

  characterController = world.createCharacterController(0.05);
  characterController.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
  characterController.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(55));
  characterController.enableAutostep(0.4, 0.25, true);
  characterController.enableSnapToGround(0.5);
  characterController.setApplyImpulsesToDynamicBodies(true);
}

const JUMP_SPEED = 5.2; // m/s -> ~1.3 m jump apex

// Move the player by a desired world-space velocity. Rapier resolves
// collisions (trees, terrain, crates) and slope rules; water volumes switch
// movement to wade/swim. Returns the new capsule-center position.
export function movePlayer(desiredVelocity, dt, wantJump = false, swimVertical = 0) {
  const t0 = playerBody.translation();
  const level = waterSurfaceAt(t0.x, t0.z);
  const headY = t0.y + 0.55;
  const feetY = t0.y - PLAYER.centerOffset;
  const swimming = level !== null && headY < level + 0.1;
  const wading = !swimming && level !== null && feetY < level - 0.15;

  let vx = desiredVelocity.x;
  let vz = desiredVelocity.z;

  if (swimming) {
    // Buoyant float toward a head-above-water rest depth + Space/C control.
    vx *= 0.45;
    vz *= 0.45;
    const floatTarget = level - 0.35;
    const buoy = THREE.MathUtils.clamp((floatTarget - t0.y) * 2.5, -2.2, 2.2);
    verticalVelocity = buoy + swimVertical * 2.2;
  } else {
    if (wading) {
      vx *= 0.55;
      vz *= 0.55;
    }
    if (wantJump && characterController.computedGrounded()) {
      verticalVelocity = JUMP_SPEED;
    }
    verticalVelocity = Math.max(
      verticalVelocity + world.gravity.y * dt,
      -MAX_FALL_SPEED
    );
  }

  characterController.computeColliderMovement(playerCollider, {
    x: vx * dt,
    y: verticalVelocity * dt,
    z: vz * dt,
  });
  const c = characterController.computedMovement();
  const t = playerBody.translation();

  let nx = t.x + c.x;
  let ny = t.y + c.y;
  let nz = t.z + c.z;

  // Soft world boundary: slide along the circle.
  const r = Math.hypot(nx, nz);
  if (r > WORLD_RADIUS) {
    const k = WORLD_RADIUS / r;
    nx *= k;
    nz *= k;
  }

  playerBody.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

  if (characterController.computedGrounded() && verticalVelocity < 0) {
    verticalVelocity = -0.5; // small downward bias keeps ground snap engaged
  }

  return { x: nx, y: ny, z: nz };
}

// Drop the capsule at a new spot (used when leaving fly mode); gravity
// then settles it onto whatever is below.
export function teleportPlayer(x, y, z) {
  playerBody.setTranslation({ x, y, z }, true);
  playerBody.setNextKinematicTranslation({ x, y, z });
  verticalVelocity = 0;
}

// ---------------------------------------------------------------------------
// Dynamic bodies — the destruction-arc pipeline, proven by one crate
// ---------------------------------------------------------------------------
function createTestCrate(scene, spawn) {
  // A few meters ahead of spawn, in the direction the camera faces.
  const x = spawn.x + 3.6;
  const z = spawn.z + 1.7;
  const y = getHeight(x, z) + 1.4;

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0)))
  );
  const crateCol = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.35, 0.35, 0.35).setDensity(150).setFriction(0.8),
    body
  );
  colliderKinds.set(crateCol.handle, 'wood');

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x8a6240, roughness: 0.85 })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // buoyancy > 1 floats (wooden crate), < 1 sinks; halfHeight sizes the
  // submersion fraction estimate.
  dynamicSyncs.push({ body, mesh, buoyancy: 1.6, halfHeight: 0.35 });
}

// ---------------------------------------------------------------------------
// Stepping + sync
// ---------------------------------------------------------------------------
export function stepPhysics(dt) {
  // Buoyancy + water drag on dynamic bodies (the future-debris pipeline).
  for (const d of dynamicSyncs) {
    const t = d.body.translation();
    const level = waterSurfaceAt(t.x, t.z);
    d.body.resetForces(true);
    const hh = d.halfHeight ?? 0.35;
    const frac =
      level === null
        ? 0
        : THREE.MathUtils.clamp((level - (t.y - hh)) / (hh * 2), 0, 1);
    if (frac > 0) {
      d.body.addForce(
        { x: 0, y: d.body.mass() * 9.81 * (d.buoyancy ?? 1.5) * frac, z: 0 },
        true
      );
      d.body.setLinearDamping(1.8);
      d.body.setAngularDamping(1.2);
    } else {
      d.body.setLinearDamping(0.05);
      d.body.setAngularDamping(0.1);
    }
  }

  accumulator = Math.min(accumulator + dt, 0.25);
  while (accumulator >= FIXED_DT) {
    world.step();
    accumulator -= FIXED_DT;
  }

  for (const { body, mesh } of dynamicSyncs) {
    const p = body.translation();
    const q = body.rotation();
    mesh.position.set(p.x, p.y, p.z);
    mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }
}

// ---------------------------------------------------------------------------
// Water-volume API: terrain owns the surface data; the engine exposes it.
// Consumers: character controller (wade/swim), dynamic bodies (buoyancy),
// underwater camera FX.
// ---------------------------------------------------------------------------
export function getWaterLevel(x, z) {
  return waterLevelAt(x, z);
}

export function isSubmerged(position) {
  const level = waterLevelAt(position.x, position.z);
  return level !== null && position.y < level;
}

// ---------------------------------------------------------------------------
// Combat queries (v4): bullets sweep the SAME colliders the player walks on.
// ---------------------------------------------------------------------------
// dir must be normalized. Returns null or
// { point, normal, dist, kind, body } — body only for dynamic hits.
export function raycastBullet(origin, dir, maxDist) {
  if (!world) return null;
  const ray = new RAPIER.Ray(origin, dir);
  const hit = world.castRayAndGetNormal(
    ray,
    maxDist,
    true,
    undefined,
    undefined,
    playerCollider,
    playerBody
  );
  if (!hit) return null;
  const body = hit.collider.parent();
  const dynamic = !!body && body.isDynamic();
  return {
    point: ray.pointAt(hit.timeOfImpact),
    normal: hit.normal,
    dist: hit.timeOfImpact,
    kind: colliderKinds.get(hit.collider.handle) ?? 'dirt',
    body: dynamic ? body : null,
  };
}

// Kick a dynamic body at the hit point (crate today, debris tomorrow).
export function applyHitImpulse(body, dir, point, magnitude) {
  body.applyImpulseAtPoint(
    { x: dir.x * magnitude, y: dir.y * magnitude, z: dir.z * magnitude },
    point,
    true
  );
}
