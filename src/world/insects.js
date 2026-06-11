import * as THREE from 'three';
import { getHeight, LAKE_X, LAKE_Z } from './terrain.js';
import { flowerPatches } from './flowers.js';
import { logColliders } from './trees.js';
import { WATER_EXCLUDED_LAYER } from './water.js';
import { dayCreatureFade } from './atmosphere.js';

// Insects (Phase 26): localized motion ANCHORED to features — butterflies
// flutter over flower patches, flies buzz around fallen logs and the
// shoreline. All animation is GPU-side (uTime in the vertex shader: wing
// flap + noise-wander around the home point baked into each instance
// matrix), so the per-frame CPU cost is two uniform writes.

// Butterfly count rides the 5x flower-patch increase automatically (they
// anchor to patches); flies got their own bump since the log count is fixed.
const BUTTERFLIES_PER_PATCH = 5;
const PATCH_FRACTION = 0.62; // not every patch gets a swarm
const FLIES_PER_ANCHOR = 12;
const LOG_ANCHOR_FRACTION = 0.9;
const SHORE_FLY_ANCHORS = 12;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const materials = []; // uTime consumers

// Shared wander/flap shader patch. Per-instance aFlight = (phase,
// flapSpeed, wanderRadius, flightHeight); the instance matrix holds the
// HOME point at ground level.
function patchInsectMaterial(mat, { flap, jitter }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    // Phase 32: SHARED live scalar — insects shrink away at dusk as the
    // fireflies rise (zero-size tris rasterize to nothing).
    shader.uniforms.uDayFade = dayCreatureFade;
    shader.vertexShader =
      `
      uniform float uTime;
      uniform float uDayFade;
      attribute vec4 aFlight;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      float ph = aFlight.x;
      float t = uTime;
      vec3 p = transformed * uDayFade;

      ${
        flap
          ? /* glsl */ `
      // Wing flap: rotate each wing about the body hinge (x = lateral).
      float flapA = sin(t * aFlight.y + ph * 17.0) * 1.05 + 0.15;
      float lat = p.x;
      p.x = lat * cos(flapA);
      p.y += abs(lat) * sin(flapA);
      `
          : ''
      }

      vec4 world = instanceMatrix * vec4(p, 1.0);

      ${
        jitter
          ? /* glsl */ `
      // Fly buzz: fast erratic orbit in a tight ball.
      world.x += (sin(t * 7.3 + ph * 11.0) + 0.4 * sin(t * 13.7 + ph * 5.0)) * aFlight.z * 0.5;
      world.z += (cos(t * 8.1 + ph * 7.0) + 0.4 * cos(t * 11.3 + ph * 3.0)) * aFlight.z * 0.5;
      world.y += aFlight.w + (sin(t * 9.7 + ph * 13.0) * 0.5 + 0.5) * 0.45;
      `
          : /* glsl */ `
      // Butterfly wander: slow figure-eights around home + altitude bob.
      world.x += (sin(t * 0.43 + ph * 3.1) + 0.5 * sin(t * 0.81 + ph * 7.0)) * aFlight.z * 0.6;
      world.z += (cos(t * 0.37 + ph * 5.3) + 0.5 * sin(t * 0.67 + ph * 2.0)) * aFlight.z * 0.6;
      world.y += aFlight.w + sin(t * 1.7 + ph * 9.0) * 0.3 + sin(t * 0.9 + ph) * 0.25;
      `
      }

      vec4 mvPosition = viewMatrix * world;
      gl_Position = projectionMatrix * mvPosition;
      `
    );
    mat.userData.shader = shader;
  };
  materials.push(mat);
}

// Butterfly: two trapezoid wings hinged at x=0 (4 tris). Unit-ish size,
// scaled per instance.
function buildButterflyGeometry() {
  const positions = [
    // left wing (x negative)
    0, 0, -0.35,   0, 0, 0.35,   -1, 0, 0.62,   -1, 0, -0.5,
    // right wing
    0, 0, -0.35,   0, 0, 0.35,   1, 0, 0.62,   1, 0, -0.5,
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length / 3; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

export function createInsects(scene) {
  const rng = mulberry32(626262);

  // ---------------------------------------------------------------- butterflies
  const homes = [];
  for (const patch of flowerPatches) {
    if (rng() > PATCH_FRACTION) continue;
    for (let i = 0; i < BUTTERFLIES_PER_PATCH; i++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * patch.r * 0.7;
      const x = patch.x + Math.cos(a) * d;
      const z = patch.z + Math.sin(a) * d;
      homes.push({ x, z, wr: 1.2 + rng() * 1.6, h: 0.5 + rng() * 1.1 });
    }
  }

  if (homes.length > 0) {
    const geometry = buildButterflyGeometry();
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      fog: true,
    });
    patchInsectMaterial(mat, { flap: true, jitter: false });

    const im = new THREE.InstancedMesh(geometry, mat, homes.length);
    const flight = new Float32Array(homes.length * 4);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const palette = [0xfdfdf2, 0xf6e27a, 0xe89b3c, 0xb9d1f0, 0xead5f4];

    homes.forEach((hm, i) => {
      dummy.position.set(hm.x, getHeight(hm.x, hm.z), hm.z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.055 + rng() * 0.045);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      color.set(palette[Math.floor(rng() * palette.length)]);
      color.multiplyScalar(0.75); // unlit material: keep below full white
      im.setColorAt(i, color);
      flight[i * 4 + 0] = rng() * 6.28;
      flight[i * 4 + 1] = 9 + rng() * 6; // flap speed
      flight[i * 4 + 2] = hm.wr;
      flight[i * 4 + 3] = hm.h;
    });
    geometry.setAttribute('aFlight', new THREE.InstancedBufferAttribute(flight, 4));

    im.castShadow = false;
    im.receiveShadow = false;
    im.layers.set(WATER_EXCLUDED_LAYER);
    im.computeBoundingSphere();
    im.boundingSphere.radius += 4; // wander reach
    scene.add(im);
  }

  // ---------------------------------------------------------------- flies
  const anchors = [];
  for (const log of logColliders) {
    if (rng() > LOG_ANCHOR_FRACTION) continue;
    anchors.push({ x: log.x, z: log.z });
  }
  let placedShore = 0;
  for (let i = 0; i < SHORE_FLY_ANCHORS * 40 && placedShore < SHORE_FLY_ANCHORS; i++) {
    const a = rng() * Math.PI * 2;
    const d = 55 + rng() * 55;
    const x = LAKE_X + Math.cos(a) * d;
    const z = LAKE_Z + Math.sin(a) * d;
    const h = getHeight(x, z);
    if (h < -0.9 || h > 0.4) continue; // right at the waterline
    anchors.push({ x, z });
    placedShore++;
  }

  if (anchors.length > 0) {
    // A tiny diamond — at gnat size orientation is irrelevant.
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0.9, 0]),
        3
      )
    );
    g.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
    );
    g.setIndex([0, 1, 2]);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x14120c,
      side: THREE.DoubleSide,
      fog: true,
    });
    patchInsectMaterial(mat, { flap: false, jitter: true });

    const count = anchors.length * FLIES_PER_ANCHOR;
    const im = new THREE.InstancedMesh(g, mat, count);
    const flight = new Float32Array(count * 4);
    const dummy = new THREE.Object3D();

    let i = 0;
    for (const anc of anchors) {
      for (let k = 0; k < FLIES_PER_ANCHOR; k++) {
        const x = anc.x + (rng() - 0.5) * 1.2;
        const z = anc.z + (rng() - 0.5) * 1.2;
        dummy.position.set(x, getHeight(x, z), z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.setScalar(0.022 + rng() * 0.014);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        flight[i * 4 + 0] = rng() * 6.28;
        flight[i * 4 + 1] = 0;
        flight[i * 4 + 2] = 0.5 + rng() * 0.5; // buzz ball radius
        flight[i * 4 + 3] = 0.35 + rng() * 0.7; // hover height
        i++;
      }
    }
    g.setAttribute('aFlight', new THREE.InstancedBufferAttribute(flight, 4));

    im.castShadow = false;
    im.receiveShadow = false;
    im.layers.set(WATER_EXCLUDED_LAYER);
    im.computeBoundingSphere();
    im.boundingSphere.radius += 2;
    scene.add(im);
  }
}

export function updateInsects(elapsedTime) {
  for (const mat of materials) {
    const shader = mat.userData.shader;
    if (shader) shader.uniforms.uTime.value = elapsedTime;
  }
}
