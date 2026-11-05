import * as THREE from 'three';
import { WATER_EXCLUDED_LAYER } from './water.js';

// Drifting dust/pollen motes around the player. Catch the light, sell the
// god rays, cost nothing. Points wrap inside a box that follows the camera.

const COUNT = 350;
const BOX = 28;     // half-extent of the mote volume around the player
const BOX_Y = 10;

let points = null;
let velocities = null;

export function createDust(scene) {
  const positions = new Float32Array(COUNT * 3);
  velocities = new Float32Array(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * BOX * 2;
    positions[i * 3 + 1] = Math.random() * BOX_Y;
    positions[i * 3 + 2] = (Math.random() - 0.5) * BOX * 2;
    velocities[i * 3 + 0] = (Math.random() - 0.5) * 0.12;
    velocities[i * 3 + 1] = -0.03 - Math.random() * 0.05; // slow fall
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    map: makeMoteTexture(),
    color: 0xfff3d8,
    size: 0.05,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // Additive sparkles have no business in the water pre-pass renders.
  points.layers.set(WATER_EXCLUDED_LAYER);
  scene.add(points);
  return points;
}

export function updateDust(dt, playerPos) {
  if (!points) return;
  const pos = points.geometry.attributes.position;

  // The volume is anchored to the player; particle coords are local.
  points.position.set(playerPos.x, playerPos.y - 2, playerPos.z);

  for (let i = 0; i < COUNT; i++) {
    let x = pos.getX(i) + velocities[i * 3 + 0] * dt;
    let y = pos.getY(i) + velocities[i * 3 + 1] * dt;
    let z = pos.getZ(i) + velocities[i * 3 + 2] * dt;

    // Gentle wandering.
    velocities[i * 3 + 0] += (Math.random() - 0.5) * 0.02 * dt;
    velocities[i * 3 + 2] += (Math.random() - 0.5) * 0.02 * dt;

    // Wrap inside the box.
    if (x > BOX) x -= BOX * 2;
    if (x < -BOX) x += BOX * 2;
    if (z > BOX) z -= BOX * 2;
    if (z < -BOX) z += BOX * 2;
    if (y < 0) y += BOX_Y;

    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true;
}

function makeMoteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
