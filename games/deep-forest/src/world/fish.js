import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLB, measureRestBox } from '../core/assets.js';
import {
  getHeight,
  getLakeDistance,
  LAKE_WATER_Y,
  LAKE_X,
  LAKE_Z,
} from './terrain.js';

// Pond fish (Phase 47): ~10 ambient swimmers from the Quaternius animated
// fish pack. All motion is CPU steering on the root object (cheap — the
// skinned swim clip does the visual work); wander stays inside the lake
// mask and below the wave surface. Mixers throttle by camera distance.

const SPECIES = [
  { file: 'fish_a', length: 0.42, count: 4, speed: [0.35, 0.7], tint: 0xffffff },
  { file: 'fish_b', length: 0.34, count: 3, speed: [0.45, 0.85], tint: 0xffffff },
  { file: 'fish_c', length: 0.58, count: 3, speed: [0.3, 0.55], tint: 0xffffff },
];

const SWIM_MAX_LAKE_D = 78; // steer home beyond this circle-equivalent dist
const SURFACE_CLEAR = 0.35; // keep below the waterline by at least this
const MIXER_DIST = 90; // no skeletal animation past this
const HIDE_DIST = 130; // fully hidden past this (fog cutoff territory)

const fishes = [];
let rippleMesh = null;
const ripples = []; // { x, z, age } — up to 4 live ripple rings

function shortestAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Random point in the lake with at least ~1.2 m of water under the surface.
function pickSwimSpot(rng) {
  for (let i = 0; i < 40; i++) {
    const ang = rng() * Math.PI * 2;
    const d = 15 + rng() * 55;
    const x = LAKE_X + Math.cos(ang) * d;
    const z = LAKE_Z + Math.sin(ang) * d;
    if (getLakeDistance(x, z) > SWIM_MAX_LAKE_D) continue;
    if (getHeight(x, z) > LAKE_WATER_Y - 1.2) continue;
    return { x, z };
  }
  return { x: LAKE_X, z: LAKE_Z };
}

export async function createFish(scene) {
  const rng = Math.random;

  for (const spec of SPECIES) {
    const gltf = await loadGLB(`/models/${spec.file}.glb`);

    // Normalize to species length from the REST-POSE bbox (raw packs are
    // ~8 m long; setFromObject on skinned rigs is unreliable — see
    // measureRestBox).
    const box = measureRestBox(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const rawLen = Math.max(size.x, size.y, size.z);
    const clip = gltf.animations[0];

    for (let i = 0; i < spec.count; i++) {
      const rig = cloneSkinned(gltf.scene);
      rig.scale.setScalar(spec.length / rawLen);

      const root = new THREE.Group();
      root.add(rig);
      rig.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });

      const { x, z } = pickSwimSpot(rng);
      const floor = getHeight(x, z);
      const yMin = floor + 0.3;
      const yMax = LAKE_WATER_Y - SURFACE_CLEAR;
      root.position.set(x, THREE.MathUtils.lerp(yMin, yMax, 0.5 + rng() * 0.3), z);
      root.rotation.y = rng() * Math.PI * 2;
      scene.add(root);

      const mixer = new THREE.AnimationMixer(rig);
      mixer.clipAction(clip).play();
      mixer.update(rng() * 2); // desync swim phases

      fishes.push({
        root,
        mixer,
        heading: root.rotation.y,
        speed: THREE.MathUtils.lerp(spec.speed[0], spec.speed[1], rng()),
        speedLo: spec.speed[0],
        speedHi: spec.speed[1],
        wanderPhase: rng() * 100,
        depthPhase: rng() * 100,
        riseTimer: 15 + rng() * 45, // seconds until the next surface rise
        rising: 0, // > 0 while heading for the surface
        vy: 0,
      });
    }
  }

  // Ripple rings for surface rises: one small instanced pool, additive-free
  // soft white fade. Sits just above the wave crest band.
  window.__fish = fishes; // debug/verification handle

  const ringGeo = new THREE.RingGeometry(0.42, 0.5, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xdfeef2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  rippleMesh = new THREE.InstancedMesh(ringGeo, ringMat, 4);
  rippleMesh.count = 0;
  rippleMesh.frustumCulled = false;
  scene.add(rippleMesh);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export function updateFish(elapsed, dt, cameraPos) {
  if (!fishes.length) return;

  for (const f of fishes) {
    const pos = f.root.position;
    const dCam = pos.distanceTo(cameraPos);
    const hidden = dCam > HIDE_DIST;
    f.root.visible = !hidden;
    if (hidden) continue;

    // --- steering -----------------------------------------------------
    const lakeD = getLakeDistance(pos.x, pos.z);
    const floor = getHeight(pos.x, pos.z);
    let desired = null;

    if (lakeD > SWIM_MAX_LAKE_D || floor > LAKE_WATER_Y - 0.9) {
      // Too close to shore/shallows: head back toward open water.
      desired = Math.atan2(LAKE_X - pos.x, LAKE_Z - pos.z);
    }

    if (desired === null) {
      // Lazy wander: slow sinusoid heading drift, per-fish phase.
      f.heading +=
        Math.sin(elapsed * 0.27 + f.wanderPhase) * 0.45 * dt +
        Math.sin(elapsed * 0.061 + f.wanderPhase * 1.7) * 0.3 * dt;
    } else {
      f.heading += shortestAngle(desired - f.heading) * Math.min(1, 2.2 * dt);
    }

    // Speed breathes a little; bursts while returning home.
    const cruise = desired === null ? 0.5 : 1;
    const targetSpeed = THREE.MathUtils.lerp(
      f.speedLo,
      f.speedHi,
      cruise * (0.5 + 0.5 * Math.sin(elapsed * 0.13 + f.wanderPhase))
    );
    f.speed += (targetSpeed - f.speed) * Math.min(1, dt);

    // --- depth --------------------------------------------------------
    f.riseTimer -= dt;
    if (f.riseTimer <= 0 && f.rising <= 0 && lakeD < 60) {
      f.rising = 2.4; // head up, kiss the surface, dip back
      f.riseTimer = 20 + Math.random() * 50;
    }

    const yMin = floor + 0.3;
    const yMax = LAKE_WATER_Y - SURFACE_CLEAR;
    let targetY;
    if (f.rising > 0) {
      f.rising -= dt;
      targetY = LAKE_WATER_Y - 0.08;
      // Spawn the ripple right at the apex moment (~mid-rise).
      if (f.rising < 1.3 && f.rising + dt >= 1.3 && ripples.length < 4) {
        ripples.push({ x: pos.x, z: pos.z, age: 0 });
      }
    } else {
      targetY = THREE.MathUtils.lerp(
        yMin,
        yMax,
        0.5 + 0.45 * Math.sin(elapsed * 0.09 + f.depthPhase)
      );
    }
    targetY = THREE.MathUtils.clamp(targetY, yMin, Math.max(yMin, LAKE_WATER_Y - 0.06));

    // --- integrate ------------------------------------------------------
    const vyTarget = THREE.MathUtils.clamp((targetY - pos.y) * 1.5, -0.4, 0.4);
    f.vy += (vyTarget - f.vy) * Math.min(1, 3 * dt);
    pos.x += Math.sin(f.heading) * f.speed * dt;
    pos.z += Math.cos(f.heading) * f.speed * dt;
    pos.y += f.vy * dt;

    f.root.rotation.y = f.heading;
    // Nose pitches with vertical motion (clamped — fish, not dolphins).
    f.root.rotation.x = THREE.MathUtils.clamp(-f.vy / Math.max(f.speed, 0.2), -0.5, 0.5) * 0.6;

    // --- skeletal animation, throttled ----------------------------------
    if (dCam < MIXER_DIST) {
      f.mixer.timeScale = 0.6 + f.speed * 1.3;
      f.mixer.update(dt);
    }
  }

  // --- ripples ----------------------------------------------------------
  if (rippleMesh) {
    let n = 0;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age += dt;
      if (r.age > 2.2) {
        ripples.splice(i, 1);
        continue;
      }
      const k = r.age / 2.2;
      _p.set(r.x, LAKE_WATER_Y + 0.18, r.z);
      _q.identity();
      _s.setScalar(0.5 + k * 3.2);
      _m.compose(_p, _q, _s);
      rippleMesh.setMatrixAt(n++, _m);
    }
    rippleMesh.count = n;
    if (n) rippleMesh.instanceMatrix.needsUpdate = true;
    rippleMesh.material.opacity = ripples.length
      ? 0.5 * (1 - ripples[0].age / 2.2)
      : 0;
  }
}
