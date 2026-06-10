import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  getHeight,
  getTint,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
} from './terrain.js';
import { WATER_EXCLUDED_LAYER } from './water.js';

// Small white/yellow flower clumps in the open grassy patches, like
// reference screenshot 2. Models ship inside the ez-tree package (same
// flowers as the original demo). Each GLB is a 6-submesh plant (stems,
// leaves, petals) — all submeshes are merged into one geometry with
// material groups so a single InstancedMesh draws the complete flower.

const CLUMPS_PER_TYPE = 200; // Phase 16: scaled with the 1200 m forest area
const CLUMPS_NEAR_SPAWN = 3;   // guaranteed findable ones, per type
const FLOWERS_PER_CLUMP_MAX = 9;
const FLOWER_HEIGHT = 0.32;    // meters after normalization

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createFlowers(scene, spawn = { x: 0, z: 8 }) {
  const loader = new GLTFLoader();
  const rng = mulberry32(2024);

  const urls = ['/models/flower_white.glb', '/models/flower_yellow.glb'];
  const gltfs = await Promise.all(urls.map((u) => loader.loadAsync(u)));

  for (const gltf of gltfs) {
    // --- Collect ALL submeshes, transforms baked in.
    gltf.scene.updateWorldMatrix(true, true);
    const geometries = [];
    const materials = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // Keep only the attributes every submesh shares, so merge succeeds.
      for (const name of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      }
      geometries.push(g);
      materials.push(o.material);
    });
    if (geometries.length === 0) continue;

    const merged = mergeGeometries(geometries, true); // true = material groups

    // --- Normalize: base at y=0, centered in XZ, ~FLOWER_HEIGHT tall.
    merged.computeBoundingBox();
    const bb = merged.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    const s = FLOWER_HEIGHT / size.y;
    merged.translate(
      -(bb.min.x + size.x / 2),
      -bb.min.y,
      -(bb.min.z + size.z / 2)
    );
    merged.scale(s, s, s);

    // --- Clump placement: a few guaranteed near spawn, the rest in open
    // mossy patches across the world.
    const positions = [];
    const addClump = (cx, cz) => {
      const n = 3 + Math.floor(rng() * (FLOWERS_PER_CLUMP_MAX - 2));
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = rng() * 1.6;
        positions.push({
          x: cx + Math.cos(a) * r,
          z: cz + Math.sin(a) * r,
          rot: rng() * Math.PI * 2,
          scale: 0.8 + rng() * 0.6,
        });
      }
    };

    for (let c = 0; c < CLUMPS_NEAR_SPAWN; c++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 14;
      addClump(spawn.x + Math.cos(a) * r, spawn.z + Math.sin(a) * r);
    }

    for (let c = 0; c < CLUMPS_PER_TYPE - CLUMPS_NEAR_SPAWN; c++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * (WORLD_RADIUS - 5);
        const cx = Math.cos(ang) * rad;
        const cz = Math.sin(ang) * rad;
        const fh = getHeight(cx, cz);
        if (
          getTint(cx, cz) > 0.55 &&
          fh > -0.5 &&
          fh < 25 &&
          getRiverDistance(cx, cz).d > 12 &&
          getSlope(cx, cz) < 0.4
        ) {
          addClump(cx, cz);
          break;
        }
      }
    }

    const im = new THREE.InstancedMesh(merged, materials, positions.length);
    im.castShadow = false;
    im.receiveShadow = true;
    // Skipped by the water pre-passes (invisible through ripple distortion).
    im.layers.set(WATER_EXCLUDED_LAYER);

    const dummy = new THREE.Object3D();
    positions.forEach((p, i) => {
      dummy.position.set(p.x, getHeight(p.x, p.z) - 0.01, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });

    scene.add(im);
  }
}
