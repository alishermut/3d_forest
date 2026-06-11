import * as THREE from 'three';
import { getHeight, LAKE_X, LAKE_Z } from './terrain.js';
import { WORLD_TREE_X, WORLD_TREE_Z } from './biomes.js';
import { dayCreatureFade } from './atmosphere.js';

// Birds (Phase 27): life in the sky — flocks and lone soarers.
//
// Flocks: an INVISIBLE ANCHOR wanders a smooth sum-of-sines path; members
// hold noise-jittered formation offsets around it with banked turns. The
// boids LOOK without per-bird simulation: CPU work is 3 anchor updates per
// frame (one getHeight each so no flock ever clips a mountain), everything
// per-bird lives in the vertex shader.
//
// Hawks: fully GPU — thermal circles from per-vertex (center, radius,
// speed) attributes, wings extended in a glide with occasional flap bouts.
//
// Birds stay OFF the water-excluded layer on purpose: a flock crossing the
// lake reflects, and at ~8 triangles per bird the pre-pass cost is noise.
//
// Part D forward note: birds roost at dusk — fade these with timeOfDay and
// hand the night sky to stars and fireflies.

const FLOCKS = [
  // cx, cz: region center; rx/rz: wander extents; n: birds
  { cx: 90, cz: 0, rx: 120, rz: 100, n: 26, seed: 1.3, speed: 0.34 },   // over the lake
  { cx: 230, cz: -90, rx: 100, rz: 110, n: 18, seed: 4.1, speed: 0.30 }, // deep forest
  { cx: -20, cz: 170, rx: 110, rz: 90, n: 22, seed: 7.7, speed: 0.38 },  // north woods
];

const HAWKS = [
  // Circling the lone oak (v11: a standard ~30 m tree) — wide lazy circles
  // above the field landmark.
  // speed is REVOLUTIONS/s: a soaring hawk glides 10-14 m/s (the first
  // build used 0.10+ here = 49 m/s fighter-jet circles, verified live).
  { cx: WORLD_TREE_X, cz: WORLD_TREE_Z, r: 48, speed: 0.04, alt: 45 },
  { cx: -270, cz: 70, r: 55, speed: 0.030, alt: 35 },
  { cx: LAKE_X + 20, cz: LAKE_Z - 30, r: 60, speed: 0.026, alt: 38 },
];

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- One bird = 8 triangles (diamond body + two 2-tri wings), +Z forward,
// non-indexed so per-bird attributes replicate per vertex. Wing verts sit
// at |x| > shoulder and flap about the shoulder line in the shader.
const SHOULDER = 0.12;
const BIRD_TRIS = [
  // body top
  [0, 0.02, 0.42], [-SHOULDER, 0, 0.05], [0, 0.03, -0.45],
  [0, 0.02, 0.42], [0, 0.03, -0.45], [SHOULDER, 0, 0.05],
  // body bottom
  [0, 0.02, 0.42], [0, -0.07, 0], [-SHOULDER, 0, 0.05],
  [0, 0.02, 0.42], [SHOULDER, 0, 0.05], [0, -0.07, 0],
  // left wing
  [-SHOULDER, 0, 0.05], [-0.34, 0, 0.16], [-0.30, 0, -0.18],
  [-0.34, 0, 0.16], [-0.58, 0, -0.05], [-0.30, 0, -0.18],
  // right wing
  [SHOULDER, 0, 0.05], [0.30, 0, -0.18], [0.34, 0, 0.16],
  [0.34, 0, 0.16], [0.30, 0, -0.18], [0.58, 0, -0.05],
];

function appendBird(arrays, scale, offset, phase, circle) {
  for (const [x, y, z] of BIRD_TRIS) {
    arrays.position.push(x * scale, y * scale, z * scale);
    arrays.aOffset.push(offset.x, offset.y, offset.z);
    arrays.aPhase.push(phase[0], phase[1]);
    if (circle) arrays.aCircle.push(circle[0], circle[1], circle[2], circle[3]);
  }
}

function buildGeometry(arrays) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arrays.position), 3));
  g.setAttribute('aOffset', new THREE.BufferAttribute(new Float32Array(arrays.aOffset), 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(arrays.aPhase), 2));
  if (arrays.aCircle.length) {
    g.setAttribute('aCircle', new THREE.BufferAttribute(new Float32Array(arrays.aCircle), 4));
  }
  return g;
}

const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform float uDayFade;
attribute vec3 aOffset;
attribute vec2 aPhase;
mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}
mat3 rotZ(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}
vec3 flapWings(vec3 p, float flapA) {
  float lat = abs(p.x) - ${SHOULDER.toFixed(2)};
  if (lat > 0.0) {
    p.y += lat * sin(flapA);
    p.x = sign(p.x) * (${SHOULDER.toFixed(2)} + lat * cos(flapA));
  }
  return p;
}
`;

const materials = [];
const flockStates = [];

function makeFlockMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x23262b, // distant-silhouette grey
    side: THREE.DoubleSide,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uDayFade = dayCreatureFade; // shared live (Phase 32)
    shader.uniforms.uAnchor = { value: new THREE.Vector3(0, 60, 0) };
    shader.uniforms.uYaw = { value: 0 };
    shader.uniforms.uBank = { value: 0 };
    shader.vertexShader =
      GLSL_COMMON +
      `
      uniform vec3 uAnchor;
      uniform float uYaw;
      uniform float uBank;
      ` +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      // Flap (per-bird phase), then bank into the turn, then face the
      // flock heading.
      // Phase 32: birds roost at dusk — shrink to nothing as night falls.
      vec3 p = flapWings(position * uDayFade, sin(uTime * 9.0 + aPhase.x * 21.0) * 0.7);
      p = rotY(uYaw) * (rotZ(uBank) * p);

      // Formation offset rotates with the heading; gentle per-bird drift
      // keeps the formation alive.
      vec3 off = aOffset + vec3(
        sin(uTime * 0.9 + aPhase.y * 7.0),
        0.55 * sin(uTime * 1.3 + aPhase.y * 3.0),
        sin(uTime * 0.7 + aPhase.y * 5.0)
      ) * 1.1;
      vec3 world = uAnchor + rotY(uYaw) * off + p;

      vec4 mvPosition = viewMatrix * vec4(world, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      `
    );
    mat.userData.shader = shader;
  };
  materials.push(mat);
  return mat;
}

function makeHawkMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x2e2419, // warm raptor brown
    side: THREE.DoubleSide,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uDayFade = dayCreatureFade; // shared live (Phase 32)
    shader.vertexShader =
      GLSL_COMMON +
      `
      attribute vec4 aCircle; // cx, cz, radius, angular speed
      ` +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      // Thermal circle, fully GPU. aOffset.y carries the soar altitude.
      float ang = uTime * aCircle.w + aPhase.x * 6.2831;
      vec3 center = vec3(aCircle.x, aOffset.y, aCircle.y);
      vec3 pos = center + vec3(cos(ang), 0.0, sin(ang)) * aCircle.z;

      // Wings extended; occasional flap bouts (raised-to-the-6th gate).
      float bout = pow(max(0.0, sin(uTime * 0.13 + aPhase.y * 11.0)), 6.0);
      float flapA = sin(uTime * 7.0 + aPhase.y * 9.0) * (0.08 + 0.6 * bout);
      vec3 p = flapWings(position * uDayFade, flapA); // roosts at dusk too

      // Heading = tangent of the circle; constant inward bank.
      float yaw = -ang;
      p = rotY(yaw) * (rotZ(0.32) * p);

      // Slow altitude breathing on the thermal.
      pos.y += sin(uTime * 0.21 + aPhase.x * 8.0) * 4.0;

      vec4 mvPosition = viewMatrix * vec4(pos + p, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      `
    );
    mat.userData.shader = shader;
  };
  materials.push(mat);
  return mat;
}

export function createBirds(scene) {
  const rng = mulberry32(272727);

  // --- Flocks: one merged mesh per flock (own anchor uniforms).
  for (const f of FLOCKS) {
    const arrays = { position: [], aOffset: [], aPhase: [], aCircle: [] };
    for (let i = 0; i < f.n; i++) {
      // Loose lens-shaped formation: wide in X/Z, shallow in Y.
      const off = new THREE.Vector3(
        (rng() - 0.5) * 26,
        (rng() - 0.5) * 7,
        (rng() - 0.5) * 34
      );
      // Wingspan ~1.5-2 m: at the 100-300 m distances flocks live at,
      // smaller birds vanish into single pixels (verified live).
      appendBird(arrays, 1.3 + rng() * 0.45, off, [rng(), rng() * 10], null);
    }
    const mesh = new THREE.Mesh(buildGeometry(arrays), makeFlockMaterial());
    mesh.frustumCulled = false; // anchor moves in the shader's uniforms
    scene.add(mesh);

    flockStates.push({
      ...f,
      mesh,
      yaw: 0,
      bank: 0,
      y: 60,
      lastX: f.cx,
      lastZ: f.cz,
    });
  }

  // --- Hawks: one mesh, everything in attributes.
  const arrays = { position: [], aOffset: [], aPhase: [], aCircle: [] };
  for (const h of HAWKS) {
    // Soar altitude clears the highest terrain under the whole circle.
    let maxH = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      maxH = Math.max(maxH, getHeight(h.cx + Math.cos(a) * h.r, h.cz + Math.sin(a) * h.r));
    }
    maxH = Math.max(maxH, getHeight(h.cx, h.cz));
    appendBird(
      arrays,
      1.7, // hawks read bigger
      new THREE.Vector3(0, maxH + h.alt, 0),
      [rng(), rng() * 10],
      [h.cx, h.cz, h.r, h.speed * Math.PI * 2]
    );
  }
  const hawkMesh = new THREE.Mesh(buildGeometry(arrays), makeHawkMaterial());
  hawkMesh.frustumCulled = false;
  scene.add(hawkMesh);
}

// ---------------------------------------------------------------------------
// Per-frame: 3 anchor updates (the only CPU work) + uTime.
// ---------------------------------------------------------------------------
const _shortestAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function updateBirds(elapsed, dt, cameraPos) {
  for (const mat of materials) {
    const shader = mat.userData.shader;
    if (shader) shader.uniforms.uTime.value = elapsed;
  }

  for (const f of flockStates) {
    const t = elapsed * f.speed;
    const ax =
      f.cx +
      Math.sin(t * 0.31 + f.seed) * f.rx * 0.7 +
      Math.sin(t * 0.127 + f.seed * 2.3) * f.rx * 0.4;
    const az =
      f.cz +
      Math.cos(t * 0.273 + f.seed * 1.7) * f.rz * 0.7 +
      Math.sin(t * 0.113 + f.seed) * f.rz * 0.4;

    // Heading from motion; banked smoothly into turns.
    const dx = ax - f.lastX;
    const dz = az - f.lastZ;
    if (dx * dx + dz * dz > 1e-6) {
      const target = Math.atan2(dx, dz);
      const delta = _shortestAngle(target - f.yaw);
      f.yaw += delta * Math.min(1, dt * 3);
      f.bank += (THREE.MathUtils.clamp(-delta * 6, -0.55, 0.55) - f.bank) * Math.min(1, dt * 2);
    }
    f.lastX = ax;
    f.lastZ = az;

    // Ride the terrain with margin — climb fast, descend lazily. Cruise
    // HIGH: at +30 the flocks sat below the treeline silhouette from the
    // ground (dark birds against dark forest = invisible); +55 keeps them
    // against the sky from any open vantage.
    const targetY = Math.max(getHeight(ax, az) + 55, 42);
    f.y += (targetY - f.y) * Math.min(1, dt * (targetY > f.y ? 2.2 : 0.3));

    const shader = f.mesh.material.userData.shader;
    if (shader) {
      shader.uniforms.uAnchor.value.set(ax, f.y, az);
      shader.uniforms.uYaw.value = f.yaw;
      shader.uniforms.uBank.value = f.bank;
    }
  }

  updateBirdCalls(elapsed, cameraPos);
}

// ---------------------------------------------------------------------------
// Distant bird-call one-shots — PROCEDURAL WebAudio (no asset exists):
// three chirp recipes, soft random pan, 7-18 s apart. Enabled on first
// pointer lock (autoplay rules), same gesture that starts the ambience.
// ---------------------------------------------------------------------------
let audioCtx = null;
let nextCall = 0;
const callRng = mulberry32(909090);

export function enableBirdCalls() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioCtx = null;
    }
  }
}

function chirpNote(t0, freq0, freq1, dur, gainPeak, pan) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const panner = audioCtx.createStereoPanner();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq0, t0);
  osc.frequency.exponentialRampToValueAtTime(freq1, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + dur * 0.25);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  panner.pan.value = pan;
  osc.connect(gain).connect(panner).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function playChirp() {
  const t0 = audioCtx.currentTime + 0.05;
  const pan = (callRng() - 0.5) * 1.6;
  const loud = 0.055 + callRng() * 0.055; // distant but noticeable over the ambience
  const kind = Math.floor(callRng() * 3);
  if (kind === 0) {
    // descending whistle
    chirpNote(t0, 3600 + callRng() * 600, 2300, 0.4, loud, pan);
  } else if (kind === 1) {
    // double chip
    chirpNote(t0, 3000, 3400, 0.07, loud, pan);
    chirpNote(t0 + 0.16, 3100, 3500, 0.07, loud, pan);
  } else {
    // trill
    for (let i = 0; i < 5; i++) {
      chirpNote(t0 + i * 0.075, i % 2 ? 3600 : 3100, i % 2 ? 3400 : 3300, 0.05, loud * 0.8, pan);
    }
  }
}

function updateBirdCalls(elapsed, cameraPos) {
  if (!audioCtx || !cameraPos) return;
  if (elapsed < nextCall) return;
  nextCall = elapsed + 7 + callRng() * 11;
  // Calls belong to the forest and the lake — quiet on the bare range,
  // and silent at night (Phase 32: birds roost; the night is crickets'
  // when audio v2 lands).
  if (cameraPos.x < -240) return;
  if (dayCreatureFade.value < 0.4) return;
  playChirp();
}
