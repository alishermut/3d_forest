import * as THREE from 'three';
import { getHeight, getTint, getSlope, getLakeDistance, LAKE_X, LAKE_Z } from './terrain.js';
import { nightGlowFade } from './atmosphere.js';

// Fireflies (Phase 32): glowing wandering points near the water and the
// grassy clearings, fading in as the creatures of the day fade out
// (nightGlowFade is the SHARED live curve scalar from atmosphere.js).
// Additive points — bloom makes them pop for free. Deliberately on the
// default layer: fireflies reflecting in the night lake is the shot.

const SHORE_COUNT = 150;
const CLEARING_COUNT = 60;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let material = null;

export function createFireflies(scene) {
  const rng = mulberry32(333111);
  const homes = [];

  // Lakeshore band — the postcard cluster.
  let placed = 0;
  for (let i = 0; i < SHORE_COUNT * 40 && placed < SHORE_COUNT; i++) {
    const a = rng() * Math.PI * 2;
    const d = 55 + rng() * 50;
    const x = LAKE_X + Math.cos(a) * d;
    const z = LAKE_Z + Math.sin(a) * d;
    const h = getHeight(x, z);
    if (h < -0.6 || h > 2.5) continue;
    homes.push({ x, z, h });
    placed++;
  }
  // Grassy clearings across the forest floor.
  placed = 0;
  for (let i = 0; i < CLEARING_COUNT * 40 && placed < CLEARING_COUNT; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 400;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = getHeight(x, z);
    if (h < -0.4 || h > 14 || getSlope(x, z) > 0.4) continue;
    if (getTint(x, z) < 0.5) continue;
    if (getLakeDistance(x, z) < 55) continue; // shore band owns those
    homes.push({ x, z, h });
    placed++;
  }

  const positions = new Float32Array(homes.length * 3);
  const seeds = new Float32Array(homes.length * 4);
  homes.forEach((hm, i) => {
    positions[i * 3 + 0] = hm.x;
    positions[i * 3 + 1] = hm.h;
    positions[i * 3 + 2] = hm.z;
    seeds[i * 4 + 0] = rng() * 6.28;        // phase
    seeds[i * 4 + 1] = 0.5 + rng() * 0.9;   // blink speed
    seeds[i * 4 + 2] = 2.2 + rng() * 3.2;   // wander radius
    seeds[i * 4 + 3] = 0.35 + rng() * 1.1;  // hover height
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uFade: nightGlowFade, // SHARED live curve object
      uPx: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uPx;
      varying float vBlink;
      void main() {
        float ph = aSeed.x;
        float t = uTime;
        // Slow meandering drift around home + gentle vertical bob.
        vec3 p = position;
        p.x += (sin(t * 0.31 + ph * 5.0) + 0.5 * sin(t * 0.73 + ph * 11.0)) * aSeed.z * 0.5;
        p.z += (cos(t * 0.27 + ph * 7.0) + 0.5 * cos(t * 0.61 + ph * 3.0)) * aSeed.z * 0.5;
        p.y += aSeed.w + sin(t * 0.9 + ph * 9.0) * 0.3;

        // Firefly blink: a soft gate, not a sine — pulses with real off-time.
        float b = 0.5 + 0.5 * sin(t * aSeed.y + ph * 20.0);
        vBlink = smoothstep(0.42, 0.72, b);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(190.0 * uPx / -mv.z, 2.0, 30.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vBlink;
      uniform float uFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float glow = exp(-d * d * 14.0) - 0.02;
        float a = glow * vBlink * uFade;
        if (a <= 0.002) discard;
        // Warm green-yellow; >1 channels feed the bloom pass.
        gl_FragColor = vec4(vec3(0.95, 1.35, 0.5) * glow * 1.4, a);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // spread over the whole shore ring
  scene.add(points);
}

export function updateFireflies(elapsedTime) {
  if (material) material.uniforms.uTime.value = elapsedTime;
}
