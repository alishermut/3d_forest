import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  getHeight,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
} from './terrain.js';

// Rocks & boulders (Phase 14): dense on the mountain slopes, a scattering
// along the lake shore, a few strays in the forest. Models from the ez-tree
// package (same source as the flowers). Rapier gets a ball collider per
// rock via the exported list.

const MOUNTAIN_COUNT = 140;
const SHORE_COUNT = 45;
const FOREST_COUNT = 35;

// {x, y, z, r} consumed by physics.js
export const rockColliders = [];

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createRocks(scene) {
  const loader = new GLTFLoader();
  // The ez-tree rock GLBs are Draco-compressed.
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);
  const rng = mulberry32(515151);

  const urls = ['/models/rock1.glb', '/models/rock2.glb', '/models/rock3.glb'];
  const gltfs = await Promise.all(urls.map((u) => loader.loadAsync(u)));

  // Normalize each rock: centered in XZ, sitting on y=0, ~1 m across.
  const sources = [];
  for (const gltf of gltfs) {
    let mesh = null;
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((o) => {
      if (!mesh && o.isMesh) mesh = o;
    });
    if (!mesh) continue;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    const s = 1 / Math.max(size.x, size.z);
    geometry.translate(
      -(bb.min.x + size.x / 2),
      -bb.min.y,
      -(bb.min.z + size.z / 2)
    );
    geometry.scale(s, s, s);
    sources.push({ geometry, material: mesh.material });
  }
  if (sources.length === 0) return;

  // --- Gather placements
  const placements = []; // {x, z, scale, rot, sourceIdx}
  const tryAdd = (x, z, scaleMin, scaleMax) => {
    placements.push({
      x,
      z,
      scale: scaleMin + rng() * (scaleMax - scaleMin),
      rot: rng() * Math.PI * 2,
      sourceIdx: Math.floor(rng() * sources.length),
    });
  };

  // Mountain slopes: where it's high or steep, but not on cliffs walls.
  let placed = 0;
  for (let i = 0; i < MOUNTAIN_COUNT * 30 && placed < MOUNTAIN_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * WORLD_RADIUS;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (h < 16 || h > 62) continue;
    if (getSlope(x, z) > 0.85) continue;
    tryAdd(x, z, 0.7, 3.2);
    placed++;
  }

  // Lake shore: a ring just above the waterline.
  placed = 0;
  for (let i = 0; i < SHORE_COUNT * 40 && placed < SHORE_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 50 + rng() * 45;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (h < -1.1 || h > 0.6) continue;
    if (getRiverDistance(x, z).d < 12) continue;
    tryAdd(x, z, 0.4, 1.4);
    placed++;
  }

  // Forest strays.
  placed = 0;
  for (let i = 0; i < FOREST_COUNT * 30 && placed < FOREST_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * WORLD_RADIUS;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (h < -0.3 || h > 14) continue;
    if (getSlope(x, z) > 0.5) continue;
    if (getLakeDistance(x, z) < 95 || getRiverDistance(x, z).d < 12) continue;
    tryAdd(x, z, 0.5, 1.8);
    placed++;
  }

  // --- Build one InstancedMesh per rock model
  const dummy = new THREE.Object3D();
  sources.forEach((src, idx) => {
    const mine = placements.filter((p) => p.sourceIdx === idx);
    if (mine.length === 0) return;
    const im = new THREE.InstancedMesh(src.geometry, src.material, mine.length);
    im.castShadow = true;
    im.receiveShadow = true;

    mine.forEach((p, i) => {
      const y = getHeight(p.x, p.z) - p.scale * 0.12; // settle into the soil
      dummy.position.set(p.x, y, p.z);
      dummy.rotation.set(0, p.rot, (rng() - 0.5) * 0.2);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);

      rockColliders.push({
        x: p.x,
        y: y + p.scale * 0.32,
        z: p.z,
        r: p.scale * 0.42,
      });
    });

    im.computeBoundingSphere();
    scene.add(im);
  });
}
