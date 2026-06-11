import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB, measureRestBox } from '../core/assets.js';
import {
  getHeight,
  getSlope,
  getLakeDistance,
  getWaterLevel,
  SPAWN,
  WORLD_RADIUS,
} from './terrain.js';
import { getWheat, getWorldTreeClearing } from './biomes.js';
import { treeColliders } from './trees.js';

// Land animals (Phase 48): deer/stag (animated GLB clips), rabbits
// (static GLB + procedural hop), hedgehogs (Idle clip + shuffle).
// CPU steering on root objects; skeletal mixers throttle by distance;
// everything freezes past the fog cutoff. No shadow casting (vertex-bound
// frame budget — Phase 35 finding).

const MIXER_DIST = 90;
const HIDE_DIST = 150;

const animals = []; // populated by createAnimals

// --- habitat -----------------------------------------------------------
// Where animals are allowed to stand/walk: dry, gentle, out of the wheat
// core and the world-tree clearing, below the treeline band.
function habitatOk(x, z) {
  if (Math.hypot(x, z) > WORLD_RADIUS - 40) return false;
  if (getLakeDistance(x, z) < 114) return false;
  if (getWaterLevel(x, z) !== null) return false;
  if (getWheat(x, z) > 0.25) return false;
  if (getWorldTreeClearing(x, z) > 0.55) return false;
  const h = getHeight(x, z);
  if (h < 0.4 || h > 13) return false;
  if (getSlope(x, z) > 0.55) return false;
  return true;
}

// Coarse trunk grid for cheap avoidance (3200 colliders -> 16 m buckets).
const treeGrid = new Map();
const CELL = 16;
function buildTreeGrid() {
  if (treeGrid.size) return;
  for (const t of treeColliders) {
    const key = `${Math.floor(t.x / CELL)},${Math.floor(t.z / CELL)}`;
    if (!treeGrid.has(key)) treeGrid.set(key, []);
    treeGrid.get(key).push(t);
  }
}
function nearestTrunkPush(x, z, out) {
  const cx = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  out.set(0, 0);
  let pushed = false;
  for (let iz = cz - 1; iz <= cz + 1; iz++)
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      const bucket = treeGrid.get(`${ix},${iz}`);
      if (!bucket) continue;
      for (const t of bucket) {
        const dx = x - t.x;
        const dz = z - t.z;
        const d = Math.hypot(dx, dz);
        const min = t.r + 0.7;
        if (d < min && d > 1e-4) {
          out.x += (dx / d) * (min - d);
          out.y += (dz / d) * (min - d); // .y carries z
          pushed = true;
        }
      }
    }
  return pushed;
}

function shortestAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Expanding-ring search for a qualified spawn point (flower-patch lesson:
// qualify with the SAME rules the wander uses, or animals start stuck).
function findSpot(cx, cz, rMin, rMax, minDistOthers = 0) {
  for (let i = 0; i < 120; i++) {
    const ang = Math.random() * Math.PI * 2;
    const d = rMin + Math.random() * (rMax - rMin);
    const x = cx + Math.cos(ang) * d;
    const z = cz + Math.sin(ang) * d;
    if (!habitatOk(x, z)) continue;
    if (
      minDistOthers > 0 &&
      animals.some((a) => Math.hypot(a.root.position.x - x, a.root.position.z - z) < minDistOthers)
    )
      continue;
    return { x, z };
  }
  return null;
}

// --- rig helpers ---------------------------------------------------------
function prepRig(gltfScene, targetHeight) {
  const rig = cloneSkinned(gltfScene);
  const box = measureRestBox(rig);
  const size = box.getSize(new THREE.Vector3());
  const s = targetHeight / size.y;
  rig.scale.setScalar(s);
  // Rest the feet on y=0: the packs' origins mostly sit at the feet
  // already, but trust the measured bbox instead.
  rig.position.y = -box.min.y * s;
  rig.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return rig;
}

// Prefer the armature-prefixed clip: the Quaternius animal GLBs ship every
// clip TWICE (bare + 'AnimalArmature|' prefixed) and the bare copies carry
// position tracks at the wrong unit scale — playing one collapses every
// bone to the origin and the mesh rasterizes as a single point.
function pickClip(animations, name) {
  return (
    animations.find((a) => a.name.endsWith('|' + name)) ||
    animations.find((a) => a.name === name)
  );
}

// --- factories -----------------------------------------------------------
function makeDeer(scene, gltf, spot, height, walkSpeed, fleeSpeed) {
  const rig = prepRig(gltf.scene, height);
  const root = new THREE.Group();
  root.add(rig);
  root.position.set(spot.x, getHeight(spot.x, spot.z), spot.z);
  root.rotation.y = Math.random() * Math.PI * 2;
  scene.add(root);

  const mixer = new THREE.AnimationMixer(rig);
  const actions = {};
  for (const [key, clipName] of Object.entries({
    idle: 'Idle',
    graze: 'Eating',
    alert: 'Idle_Headlow',
    walk: 'Walk',
    flee: 'Gallop',
  })) {
    const clip = pickClip(gltf.animations, clipName);
    if (clip) actions[key] = mixer.clipAction(clip);
  }
  actions.idle.play();

  return {
    kind: 'deer',
    root,
    mixer,
    actions,
    current: 'idle',
    state: 'idle',
    stateTimer: 2 + Math.random() * 6,
    heading: root.rotation.y,
    speed: 0,
    walkSpeed,
    fleeSpeed,
    fleeRadius: 17,
    calmRadius: 34,
    target: null,
  };
}

function makeRabbit(scene, gltf, spot, height, jack) {
  const rig = prepRig(gltf.scene, height);
  const root = new THREE.Group();
  root.add(rig);
  root.position.set(spot.x, getHeight(spot.x, spot.z), spot.z);
  root.rotation.y = Math.random() * Math.PI * 2;
  scene.add(root);
  return {
    kind: 'rabbit',
    root,
    rig,
    state: 'idle',
    stateTimer: 1 + Math.random() * 5,
    heading: root.rotation.y,
    speed: 0,
    walkSpeed: jack ? 1.4 : 1.1,
    fleeSpeed: jack ? 4.4 : 3.6,
    fleeRadius: 9,
    calmRadius: 22,
    hopPhase: Math.random(),
    hopLen: jack ? 1.0 : 0.7, // meters per hop
    hopH: jack ? 0.32 : 0.22,
    target: null,
  };
}

function makeHedgehog(scene, gltf, spot, height) {
  const rig = prepRig(gltf.scene, height);
  const root = new THREE.Group();
  root.add(rig);
  root.position.set(spot.x, getHeight(spot.x, spot.z), spot.z);
  root.rotation.y = Math.random() * Math.PI * 2;
  scene.add(root);
  const mixer = new THREE.AnimationMixer(rig);
  const idle = pickClip(gltf.animations, 'Idle');
  if (idle) mixer.clipAction(idle).play();
  return {
    kind: 'hedgehog',
    root,
    mixer,
    state: 'idle',
    stateTimer: 2 + Math.random() * 4,
    heading: root.rotation.y,
    speed: 0,
    walkSpeed: 0.18,
    fleeRadius: 4, // freeze radius — hedgehogs don't run
    target: null,
  };
}

export async function createAnimals(scene) {
  buildTreeGrid();
  const [deerG, stagG, rabbitG, jackG, hedgeG] = await Promise.all([
    loadGLB('/models/deer.glb'),
    loadGLB('/models/stag.glb'),
    loadGLB('/models/rabbit.glb'),
    loadGLB('/models/jackrabbit.glb'),
    loadGLB('/models/hedgehog.glb'),
  ]);

  // 5x population (user request 2026-06-11: "add more life into the
  // forest"). Deer roam in loose groups from near-spawn out to deep
  // forest; stags run deeper. Rings widened so the bigger herd spreads
  // instead of clumping, with the inner edges pulled IN for findability.
  for (let i = 0; i < 10; i++) {
    // the first three are guaranteed CLOSE (findability — wheat field and
    // beach disqualify most of the near ring, so fall back to wide)
    const spot =
      (i < 3 && findSpot(SPAWN.x, SPAWN.z, 40, 130, 15)) ||
      findSpot(SPAWN.x, SPAWN.z, 50, 260, 18);
    if (spot) animals.push(makeDeer(scene, deerG, spot, 1.55, 1.2, 6.0));
  }
  for (let i = 0; i < 4; i++) {
    const spot = findSpot(SPAWN.x, SPAWN.z, 90, 300, 25);
    if (spot) animals.push(makeDeer(scene, stagG, spot, 1.95, 1.1, 6.4));
  }

  // Rabbits: closer in — field edges and clearings.
  for (let i = 0; i < 30; i++) {
    const spot = findSpot(SPAWN.x, SPAWN.z, 20, 170, 7);
    if (spot)
      animals.push(makeRabbit(scene, i % 2 ? jackG : rabbitG, spot, i % 2 ? 0.34 : 0.28, !!(i % 2)));
  }

  // Hedgehogs: forest floor wanderers (first three guaranteed close).
  for (let i = 0; i < 10; i++) {
    const spot =
      (i < 3 && findSpot(SPAWN.x, SPAWN.z, 25, 100, 10)) ||
      findSpot(SPAWN.x, SPAWN.z, 25, 190, 10);
    if (spot) animals.push(makeHedgehog(scene, hedgeG, spot, 0.22));
  }

  window.__animals = animals; // debug/verification handle
}

// --- per-frame -----------------------------------------------------------
const _push = new THREE.Vector2();

function setDeerAction(a, name) {
  if (a.current === name || !a.actions[name]) return;
  const from = a.actions[a.current];
  const to = a.actions[name];
  if (from) from.fadeOut(0.25);
  to.reset().fadeIn(0.25).play();
  a.current = name;
}

function steer(a, dt, desired, turnRate) {
  a.heading += shortestAngle(desired - a.heading) * Math.min(1, turnRate * dt);
}

function tryMove(a, dt) {
  const pos = a.root.position;
  let nx = pos.x + Math.sin(a.heading) * a.speed * dt;
  let nz = pos.z + Math.cos(a.heading) * a.speed * dt;

  // trunk avoidance: push out + bend the heading
  if (nearestTrunkPush(nx, nz, _push)) {
    nx += _push.x;
    nz += _push.y;
    a.heading += shortestAngle(Math.atan2(_push.x, _push.y) - a.heading) * Math.min(1, 4 * dt);
  }

  if (!habitatOk(nx, nz)) {
    // blocked: bounce the heading away and stand still this frame
    a.heading += Math.PI * (0.6 + Math.random() * 0.4);
    a.target = null;
    return false;
  }
  pos.x = nx;
  pos.z = nz;
  pos.y = getHeight(nx, nz);
  return true;
}

function updateGrounded(a, dt, playerPos, elapsed) {
  const pos = a.root.position;
  const dPlayer = pos.distanceTo(playerPos);

  // --- state transitions ------------------------------------------------
  if (a.kind !== 'hedgehog' && dPlayer < a.fleeRadius && a.state !== 'flee') {
    a.state = 'flee';
  }

  switch (a.state) {
    case 'flee': {
      const away = Math.atan2(pos.x - playerPos.x, pos.z - playerPos.z);
      steer(a, dt, away, 5);
      a.speed += (a.fleeSpeed - a.speed) * Math.min(1, 6 * dt);
      tryMove(a, dt);
      if (dPlayer > a.calmRadius) {
        a.state = 'idle';
        a.stateTimer = 1 + Math.random() * 3;
      }
      break;
    }
    case 'walk': {
      if (!a.target) {
        a.state = 'idle';
        a.stateTimer = 2;
        break;
      }
      const desired = Math.atan2(a.target.x - pos.x, a.target.z - pos.z);
      steer(a, dt, desired, 2.5);
      a.speed += (a.walkSpeed - a.speed) * Math.min(1, 3 * dt);
      // tryMove NULLS the target when the step is blocked (habitat edge) —
      // re-check before the arrival test or this crashes on null.x
      tryMove(a, dt);
      if (!a.target) {
        a.state = 'idle';
        a.stateTimer = 1 + Math.random() * 3;
      } else if (Math.hypot(a.target.x - pos.x, a.target.z - pos.z) < 1.2) {
        a.state = 'idle';
        a.stateTimer = 2 + Math.random() * 6;
        a.target = null;
      }
      break;
    }
    case 'graze': {
      a.speed += (0 - a.speed) * Math.min(1, 5 * dt);
      a.stateTimer -= dt;
      if (a.stateTimer <= 0) {
        a.state = 'idle';
        a.stateTimer = 1 + Math.random() * 4;
      }
      break;
    }
    default: {
      // idle: stand, breathe, occasionally pick a new errand
      a.speed += (0 - a.speed) * Math.min(1, 5 * dt);
      a.stateTimer -= dt;
      if (a.stateTimer <= 0) {
        if (a.kind === 'deer' && Math.random() < 0.45) {
          a.state = 'graze';
          a.stateTimer = 4 + Math.random() * 6;
          break;
        }
        const t = findSpot(pos.x, pos.z, 6, 24);
        if (t) {
          a.target = t;
          a.state = 'walk';
        } else {
          a.stateTimer = 3;
        }
      }
    }
  }

  a.root.rotation.y = a.heading;
  // Ground snap EVERY frame (not only on successful tryMove) — presentation
  // offsets below (rabbit hop) are additive and must start from the ground.
  pos.y = getHeight(pos.x, pos.z);

  // --- per-kind presentation ---------------------------------------------
  if (a.kind === 'deer') {
    if (a.state === 'flee') setDeerAction(a, 'flee');
    else if (a.state === 'walk') setDeerAction(a, 'walk');
    else if (a.state === 'graze') setDeerAction(a, 'graze');
    else setDeerAction(a, 'idle');
  } else if (a.kind === 'rabbit') {
    // Procedural hop: the whole body rides a parabolic arc per hop while
    // moving; sitting still between errands.
    if (a.speed > 0.05) {
      a.hopPhase += (a.speed / a.hopLen) * dt;
      const f = a.hopPhase % 1;
      const arc = Math.sin(Math.PI * f);
      a.root.position.y += a.hopH * arc;
      a.root.rotation.x = (0.5 - f) * 0.5 * Math.min(1, a.speed / a.fleeSpeed + 0.4);
      // squash on landing, stretch mid-air
      const sq = 1 + 0.12 * arc - 0.08 * (1 - arc);
      a.rig.scale.y = a.rig.scale.x * sq;
    } else {
      a.root.rotation.x = 0;
      a.rig.scale.y = a.rig.scale.x;
      // idle nibble twitch every few seconds
      if (Math.sin(elapsed * 2.1 + a.hopPhase * 37) > 0.93) a.root.rotation.x = -0.12;
    }
  } else if (a.kind === 'hedgehog') {
    // freeze (curl) while the player looms
    if (dPlayer < a.fleeRadius) {
      a.speed = 0;
      a.state = 'idle';
      a.stateTimer = Math.max(a.stateTimer, 2);
    }
  }
}

export function updateAnimals(elapsed, dt, playerPos) {
  if (!animals.length) return;
  for (const a of animals) {
    const d = a.root.position.distanceTo(playerPos);
    const hidden = d > HIDE_DIST;
    a.root.visible = !hidden;
    if (hidden) continue; // frozen past the fog cutoff

    updateGrounded(a, dt, playerPos, elapsed);

    if (a.mixer && d < MIXER_DIST) {
      if (a.kind === 'deer') {
        const base = a.current === 'flee' ? a.speed / a.fleeSpeed : 1;
        a.mixer.timeScale = THREE.MathUtils.clamp(base, 0.6, 1.3);
      }
      a.mixer.update(dt);
    }
  }
}
