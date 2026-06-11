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
  LAKE_X,
  LAKE_Z,
} from './terrain.js';
import { getWheat, getWorldTreeClearing } from './biomes.js';
import { WATER_EXCLUDED_LAYER } from './water.js';

// Flower colonies (Phase 25): meadow PATCHES instead of uniform sprinkles —
// each patch is one species (colonies read as colonies), placed where
// flowers belong: the wheat-field edges, the lakeshore band, and open
// forest clearings. Two GLB plants x two petal palettes = 4 species.
// Patch positions are exported for Phase 26's butterflies.

const PATCH_COUNT = 130; // was 390 (5x), reduced 3x (user request 2026-06-11)
const PATCHES_NEAR_SPAWN = 8; // guaranteed findable
const FLOWERS_MIN = 12;
const FLOWERS_MAX = 26;
const FLOWER_HEIGHT = 0.32; // meters after normalization

// {x, z, r} per patch — Phase 26 anchors butterflies here.
export const flowerPatches = [];

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tint a cloned material set: petals are the LIGHT materials (stems/leaves
// stay green). Lightness threshold separates them reliably on these models.
function tintedMaterials(materials, petalColor) {
  const hsl = {};
  return materials.map((m) => {
    const clone = m.clone();
    m.color.getHSL(hsl);
    if (hsl.l > 0.45) clone.color.set(petalColor);
    return clone;
  });
}

export async function createFlowers(scene, spawn = { x: 0, z: 8 }) {
  const loader = new GLTFLoader();
  const rng = mulberry32(2024);

  const urls = ['/models/flower_white.glb', '/models/flower_yellow.glb'];
  const gltfs = await Promise.all(urls.map((u) => loader.loadAsync(u)));

  // --- Build the merged geometry + material set per GLB (as before).
  const bases = [];
  for (const gltf of gltfs) {
    gltf.scene.updateWorldMatrix(true, true);
    const geometries = [];
    const materials = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      }
      geometries.push(g);
      materials.push(o.material);
    });
    if (geometries.length === 0) continue;

    const merged = mergeGeometries(geometries, true); // material groups
    merged.computeBoundingBox();
    const bb = merged.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    const s = FLOWER_HEIGHT / size.y;
    merged.translate(-(bb.min.x + size.x / 2), -bb.min.y, -(bb.min.z + size.z / 2));
    merged.scale(s, s, s);
    bases.push({ geometry: merged, materials });
  }
  if (bases.length === 0) return;

  // --- 4 species: white, violet (tinted white), yellow, poppy (tinted
  // yellow). Weights keep the wild white/yellow look dominant.
  const species = [
    { geometry: bases[0].geometry, materials: bases[0].materials, weight: 0.3 },
    {
      geometry: bases[0].geometry,
      materials: tintedMaterials(bases[0].materials, 0x8b6fd0),
      weight: 0.2,
    },
    { geometry: bases[1].geometry, materials: bases[1].materials, weight: 0.3 },
    {
      geometry: bases[1].geometry,
      materials: tintedMaterials(bases[1].materials, 0xc8472a),
      weight: 0.2,
    },
  ];
  const pickSpecies = () => {
    let p = rng();
    for (let i = 0; i < species.length; i++) {
      if (p < species[i].weight) return i;
      p -= species[i].weight;
    }
    return 0;
  };

  // --- Patch centers: favored zones, each patch ONE species.
  const perSpecies = species.map(() => []);
  const addPatch = (cx, cz) => {
    const r = 2.5 + rng() * 3.5;
    const n = FLOWERS_MIN + Math.floor(rng() * (FLOWERS_MAX - FLOWERS_MIN + 1));
    const list = perSpecies[pickSpecies()];
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      // Center-biased radius: dense heart, ragged edge.
      const d = Math.pow(rng(), 0.65) * r;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (getHeight(x, z) < -0.45) continue; // stay off the waterline
      list.push({ x, z, rot: rng() * Math.PI * 2, scale: 0.8 + rng() * 0.6 });
    }
    flowerPatches.push({ x: cx, z: cz, r });
  };

  // A patch center qualifies if it sits in one of the favored zones.
  const qualifies = (x, z) => {
    const h = getHeight(x, z);
    if (h < -0.4 || h > 25) return false;
    if (getSlope(x, z) > 0.4) return false;
    if (getRiverDistance(x, z).d < 12) return false;
    if (getWorldTreeClearing(x, z) > 0.25) return false;
    const wheat = getWheat(x, z);
    if (wheat > 0.5) return false; // inside the field proper wheat owns it
    const wheatEdge = wheat > 0.04; // the field's ragged border
    const shore =
      getLakeDistance(x, z) > 58 && getLakeDistance(x, z) < 100 && h < 3;
    const clearing = getTint(x, z) > 0.55;
    return wheatEdge || shore || clearing;
  };

  // Guaranteed findable patches: nearest QUALIFYING spots to spawn (the
  // spawn itself is deep in the wheat field, where flowers drown under the
  // stalks — search outward until we're clear of it).
  let nearPlaced = 0;
  for (let ring = 12; ring <= 90 && nearPlaced < PATCHES_NEAR_SPAWN; ring += 7) {
    for (let k = 0; k < 14 && nearPlaced < PATCHES_NEAR_SPAWN; k++) {
      const a = rng() * Math.PI * 2;
      const cx = spawn.x + Math.cos(a) * ring;
      const cz = spawn.z + Math.sin(a) * ring;
      if (!qualifies(cx, cz)) continue;
      addPatch(cx, cz);
      nearPlaced++;
    }
  }

  let placed = PATCHES_NEAR_SPAWN;
  for (let i = 0; i < PATCH_COUNT * 40 && placed < PATCH_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * (WORLD_RADIUS - 5);
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    if (!qualifies(cx, cz)) continue;
    addPatch(cx, cz);
    placed++;
  }

  // --- One InstancedMesh per species.
  const dummy = new THREE.Object3D();
  species.forEach((sp, idx) => {
    const list = perSpecies[idx];
    if (list.length === 0) return;
    const im = new THREE.InstancedMesh(sp.geometry, sp.materials, list.length);
    im.castShadow = false;
    im.receiveShadow = true;
    // Skipped by the water pre-passes (invisible through ripple distortion).
    im.layers.set(WATER_EXCLUDED_LAYER);

    list.forEach((p, i) => {
      dummy.position.set(p.x, getHeight(p.x, p.z) - 0.01, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });

    im.computeBoundingSphere();
    scene.add(im);
  });
}
