import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import {
  mergeGeometries,
  mergeVertices,
} from 'three/addons/utils/BufferGeometryUtils.js';
import { loadTexture } from '../core/assets.js';
import {
  getHeight,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
  LAKE_X,
  LAKE_Z,
} from './terrain.js';
import { getDeepForest, getWorldTreeClearing } from './biomes.js';

// Rocks v2 (Phase 24): procedural archetypes instead of the three GLB
// models — seeded noise-displaced icospheres, one InstancedMesh per
// archetype, scattered by biome so each zone reads differently:
//   - mountain base: angular scree chunks + flat slabs (flat-shaded)
//   - lakeshore: rounded water-worn stones + pebble clusters
//   - deep forest: big mossy boulders (vertex-color moss on top)
//   - open forest: small strays + pebbles
// Rapier still gets one ball collider per rock via rockColliders.

const MOUNTAIN_COUNT = 140;
const SHORE_COUNT = 45;
const PEBBLE_CLUSTERS = 26; // shore + forest, no colliders (ankle height)
const DEEP_BOULDERS = 35;
const FOREST_COUNT = 28;

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

const noise = new SimplexNoise({ random: mulberry32(424242) });

// Displace an icosphere with seeded noise. sharp=true splits faces for
// faceted normals (angular rock); smooth keeps the welded sphere normals
// (water-worn). flatten squashes Y BEFORE displacement so slabs stay slabs.
function rockBlob({ detail, amp, freq, seed, flatten = 1, sharp = false, mossy = 0 }) {
  // IcosahedronGeometry is NON-indexed (every face split) — that gives the
  // faceted look the angular archetypes want for free. Smooth (water-worn)
  // archetypes weld the vertices first so computeVertexNormals averages
  // across faces.
  let geometry = new THREE.IcosahedronGeometry(0.5, detail);
  if (!sharp) {
    // mergeVertices hashes EVERY attribute — the per-face normals would
    // block all welding. Drop them (recomputed below); UV-seam verts stay
    // split, which is correct.
    geometry.deleteAttribute('normal');
    geometry = mergeVertices(geometry, 1e-4);
  }
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      noise.noise(v.x * freq + seed, v.y * freq - seed) * 0.6 +
      noise.noise(v.y * freq * 2.3 - seed, v.z * freq * 2.3 + seed) * 0.4;
    v.multiplyScalar(1 + n * amp);
    pos.setXYZ(i, v.x, v.y * flatten, v.z);
  }
  geometry.computeVertexNormals();

  // Moss settles on the up-facing surfaces in noisy patches (vertex color
  // multiplies the rock texture; >1 channels brighten).
  const colors = new Float32Array(pos.count * 3);
  const nor = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const up = nor.getY(i);
    const patch = 0.5 + 0.5 * noise.noise(v.x * 3.1 + seed * 7, v.z * 3.1 - seed * 3);
    const m = mossy * THREE.MathUtils.smoothstep(up, 0.3, 0.9) * patch;
    colors[i * 3 + 0] = 1 - m * 0.5;
    colors[i * 3 + 1] = 1 + m * 0.55;
    colors[i * 3 + 2] = 1 - m * 0.6;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Rebase to REST ON y=0 (blobs are built centered — without this, half
  // the rock is underground at placement). Keep ~8% buried for contact.
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox.min.y * 0.92, 0);
  return geometry;
}

// Pebble cluster: a handful of small worn stones merged into one geometry,
// scattered around the origin and resting on y=0.
function pebbleCluster(seed) {
  const rng = mulberry32(seed);
  const parts = [];
  const count = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const g = rockBlob({
      detail: 1,
      amp: 0.18,
      freq: 2.2,
      seed: seed + i * 13.7,
      flatten: 0.75,
    });
    const s = 0.1 + rng() * 0.16;
    const ang = rng() * Math.PI * 2;
    const d = rng() * 0.45;
    g.scale(s, s, s);
    g.rotateY(rng() * Math.PI * 2);
    g.translate(Math.cos(ang) * d, 0, Math.sin(ang) * d); // parts rest on y=0
    parts.push(g);
  }
  return mergeGeometries(parts);
}

export async function createRocks(scene, renderer) {
  const rng = mulberry32(515151);
  const rockTex = await loadTexture('/textures/rock_diff.jpg', renderer);
  rockTex.colorSpace = THREE.SRGBColorSpace; // matches the terrain's copy
  rockTex.wrapS = rockTex.wrapT = THREE.RepeatWrapping;

  const material = new THREE.MeshStandardMaterial({
    map: rockTex,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
  });

  // --- Archetypes (Phase 24): keyed scatter targets below.
  const archetypes = {
    scree: rockBlob({ detail: 1, amp: 0.42, freq: 1.6, seed: 3.1, sharp: true }),
    slab: rockBlob({ detail: 1, amp: 0.3, freq: 1.9, seed: 9.4, flatten: 0.42, sharp: true }),
    worn: rockBlob({ detail: 2, amp: 0.14, freq: 1.7, seed: 5.8, flatten: 0.8 }),
    boulder: rockBlob({ detail: 2, amp: 0.26, freq: 1.4, seed: 7.2, mossy: 0.9 }),
    pebbles: pebbleCluster(616161),
  };

  const placements = { scree: [], slab: [], worn: [], boulder: [], pebbles: [] };
  const tryAdd = (key, x, z, scaleMin, scaleMax, collider = true) => {
    placements[key].push({
      x,
      z,
      scale: scaleMin + rng() * (scaleMax - scaleMin),
      rot: rng() * Math.PI * 2,
      squash: 0.8 + rng() * 0.45, // per-instance vertical variety
      collider,
    });
  };

  // Mountain slopes: angular scree + slabs where it's high, off cliff walls.
  let placed = 0;
  for (let i = 0; i < MOUNTAIN_COUNT * 30 && placed < MOUNTAIN_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * WORLD_RADIUS;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (h < 16 || h > 62) continue;
    if (getSlope(x, z) > 0.85) continue;
    tryAdd(rng() < 0.35 ? 'slab' : 'scree', x, z, 0.7, 3.2);
    placed++;
  }

  // Lakeshore: rounded water-worn stones just above the waterline.
  placed = 0;
  for (let i = 0; i < SHORE_COUNT * 40 && placed < SHORE_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 50 + rng() * 60;
    const x = LAKE_X + Math.cos(ang) * rad;
    const z = LAKE_Z + Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (h < -1.1 || h > 0.6) continue;
    if (getRiverDistance(x, z).d < 12) continue;
    tryAdd('worn', x, z, 0.4, 1.4);
    placed++;
  }

  // Deep forest: big mossy boulders between the trees.
  placed = 0;
  for (let i = 0; i < DEEP_BOULDERS * 40 && placed < DEEP_BOULDERS; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * WORLD_RADIUS;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (getDeepForest(x, z) < 0.45) continue;
    const h = getHeight(x, z);
    if (h < -0.3 || h > 14) continue;
    if (getSlope(x, z) > 0.5 || getLakeDistance(x, z) < 95) continue;
    tryAdd('boulder', x, z, 0.9, 2.4);
    placed++;
  }

  // Open forest strays: small worn stones.
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
    if (getWorldTreeClearing(x, z) > 0.02) continue;
    tryAdd(rng() < 0.6 ? 'worn' : 'boulder', x, z, 0.5, 1.6);
    placed++;
  }

  // Pebble clusters: shore band + forest floor, walk-over decoration.
  placed = 0;
  for (let i = 0; i < PEBBLE_CLUSTERS * 40 && placed < PEBBLE_CLUSTERS; i++) {
    const shore = placed < PEBBLE_CLUSTERS * 0.6;
    const ang = rng() * Math.PI * 2;
    const rad = shore ? 45 + rng() * 65 : Math.sqrt(rng()) * WORLD_RADIUS;
    const x = (shore ? LAKE_X : 0) + Math.cos(ang) * rad;
    const z = (shore ? LAKE_Z : 0) + Math.sin(ang) * rad;
    const h = getHeight(x, z);
    if (shore ? h < -1.0 || h > 0.7 : h < -0.3 || h > 12) continue;
    if (!shore && (getSlope(x, z) > 0.4 || getWorldTreeClearing(x, z) > 0.02)) continue;
    tryAdd('pebbles', x, z, 0.8, 1.6, false);
    placed++;
  }

  // --- One InstancedMesh per archetype.
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (const [key, list] of Object.entries(placements)) {
    if (list.length === 0) continue;
    const im = new THREE.InstancedMesh(archetypes[key], material, list.length);
    im.castShadow = key !== 'pebbles';
    im.receiveShadow = true;

    list.forEach((p, i) => {
      const sy = p.scale * p.squash;
      const y = getHeight(p.x, p.z) - sy * (key === 'pebbles' ? 0.02 : 0.05);
      dummy.position.set(p.x, y, p.z);
      dummy.rotation.set(0, p.rot, (rng() - 0.5) * 0.2);
      dummy.scale.set(p.scale, sy, p.scale * (0.85 + rng() * 0.3));
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      // Per-instance grey tint: scree pale, shore stones cool, boulders warm.
      const g = 0.8 + rng() * 0.35;
      if (key === 'worn') color.setRGB(g * 0.92, g * 0.96, g);
      else if (key === 'scree' || key === 'slab') color.setRGB(g, g, g * 0.94);
      else color.setRGB(g * 0.98, g, g * 0.9);
      im.setColorAt(i, color);

      if (p.collider) {
        rockColliders.push({
          x: p.x,
          y: y + sy * 0.3,
          z: p.z,
          r: Math.min(p.scale, sy) * 0.4,
        });
      }
    });

    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    scene.add(im);
  }
}
