import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import {
  getHeight,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
  SPAWN,
} from './terrain.js';

const TREE_COUNT = 5000;     // 1200 m world (Phase 16): same density as 2200/800 m
const MIN_DIST = 5.5;        // closest two trees can stand (m)
const SPAWN_CLEARING = 13;   // tree-free radius around the player spawn

// Mixed forest like the reference shots: dark-barked oaks, white birch-like
// aspens, pines filling the background. Two seeds per species so the forest
// doesn't look copy-pasted.
const SPECIES = [
  { preset: 'Oak Medium', weight: 0.4, seeds: [101, 202], trunkR: 0.5 },
  { preset: 'Aspen Medium', weight: 0.35, seeds: [303, 404], trunkR: 0.35 },
  { preset: 'Pine Medium', weight: 0.25, seeds: [505, 606], trunkR: 0.4 },
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

// Spatial chunking (Phase 9): trees are grouped into grid cells, one
// InstancedMesh per (variant, cell). Cells get real bounding spheres so
// three.js frustum-culls them, plus a distance cutoff — beyond ~150 m the
// fog has fully swallowed everything, so drawing it is pure waste.
const CELL_SIZE = 66;   // ~18x18 cells over the ±600 m world (Phase 16)
const GRID_HALF = 600;
// At FogExp2 density 0.026, transmittance at 110 m is ~0.1% — cells beyond
// this are invisible, not "barely visible".
const VIEW_CUTOFF = 110;

const cellMeshes = []; // {center, radius, meshes: [branchesIM, leavesIM]}

// Collider data consumed by core/physics.js (Phase 8).
export const treeColliders = []; // trunks: {x, z, r}
export const logColliders = [];  // fallen logs: {x, y, z, yaw, tilt, halfLen, r}

const leafMaterials = [];

// ez-tree's built-in leaf wind shader replaces three's project_vertex chunk
// WITHOUT the instanceMatrix multiply, so under InstancedMesh every leaf
// renders at the world origin. This is the same sway, instancing-aware:
// instance transform first, then world-space wind.
function patchLeafMaterialForInstancing(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWindStrength = { value: new THREE.Vector3(0.4, 0, 0.4) };
    shader.uniforms.uWindFrequency = { value: 0.6 };

    shader.vertexShader =
      `
      uniform float uTime;
      uniform vec3 uWindStrength;
      uniform float uWindFrequency;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif

      // Phase varies smoothly with world position so trees don't sway in sync.
      float windOffset =
        mvPosition.x * 0.21 + mvPosition.z * 0.17 + mvPosition.y * 0.11;
      vec3 windSway = uv.y * uWindStrength * (
        0.6 * sin(uTime * uWindFrequency + windOffset) +
        0.4 * sin(2.3 * uTime * uWindFrequency + 1.3 * windOffset)
      );
      mvPosition.xyz += windSway;

      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    mat.userData.shader = shader;
  };
  mat.needsUpdate = true;
}

export function createTrees(scene) {
  const rng = mulberry32(7777);
  const densityNoise = new SimplexNoise({ random: mulberry32(4242) });

  // --- Scatter points: blue-noise-ish rejection sampling with a hash grid
  const points = [];
  const cell = MIN_DIST;
  const grid = new Map();
  let attempts = 0;

  while (points.length < TREE_COUNT && attempts < TREE_COUNT * 40) {
    attempts++;
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * (WORLD_RADIUS + 12);
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < SPAWN_CLEARING) continue;

    // Terrain v2 masks: trees need DRY ground (above the waterline with
    // margin — covers the lake and any wet dip), stay out of the river,
    // off cliffs, and below the treeline (thinning band first).
    if (getRiverDistance(x, z).d < 13) continue;
    const h = getHeight(x, z);
    if (h < -0.4) continue;
    if (h > 40) continue;
    if (h > 28 && rng() > 0.35) continue; // sparse near the treeline
    if (getSlope(x, z) > 0.65) continue;  // too steep for roots

    // Density noise carves natural clearings and groves.
    if (densityNoise.noise(x / 75, z / 75) < -0.45) continue;

    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    let ok = true;
    for (let dx = -1; dx <= 1 && ok; dx++) {
      for (let dz = -1; dz <= 1 && ok; dz++) {
        const bucket = grid.get((gx + dx) + ',' + (gz + dz));
        if (!bucket) continue;
        for (const p of bucket) {
          const ddx = p.x - x;
          const ddz = p.z - z;
          if (ddx * ddx + ddz * ddz < MIN_DIST * MIN_DIST) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;

    const p = { x, z };
    points.push(p);
    const key = gx + ',' + gz;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  // --- Assign each point to a species variant
  const variants = [];
  for (const s of SPECIES) {
    for (const seed of s.seeds) {
      variants.push({ species: s, seed, points: [] });
    }
  }
  for (const p of points) {
    let pick = rng();
    let si = 0;
    for (let i = 0; i < SPECIES.length; i++) {
      if (pick < SPECIES[i].weight) {
        si = i;
        break;
      }
      pick -= SPECIES[i].weight;
    }
    const variantsOfSpecies = variants.filter((v) => v.species === SPECIES[si]);
    variantsOfSpecies[Math.floor(rng() * variantsOfSpecies.length)].points.push(p);
  }

  // --- Build one Tree per variant, then instance it over its points
  // GROUPED BY GRID CELL (Phase 9): one InstancedMesh per (variant, cell)
  // with computed bounds, so three.js frustum-culls whole forest cells and
  // the distance cutoff drops cells the fog hides anyway. Geometry and
  // materials are shared across cells — only the instance buffers differ.
  const dummy = new THREE.Object3D();

  for (const variant of variants) {
    if (variant.points.length === 0) continue;

    const tree = new Tree();
    tree.loadPreset(variant.species.preset);
    tree.options.seed = variant.seed;
    tree.generate();

    patchLeafMaterialForInstancing(tree.leavesMesh.material);
    leafMaterials.push(tree.leavesMesh.material);

    // Group this variant's points into grid cells.
    const cells = new Map();
    for (const p of variant.points) {
      const cx = Math.floor((p.x + GRID_HALF) / CELL_SIZE);
      const cz = Math.floor((p.z + GRID_HALF) / CELL_SIZE);
      const key = cx + ',' + cz;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(p);
    }

    for (const pts of cells.values()) {
      const branchesIM = new THREE.InstancedMesh(
        tree.branchesMesh.geometry,
        tree.branchesMesh.material,
        pts.length
      );
      const leavesIM = new THREE.InstancedMesh(
        tree.leavesMesh.geometry,
        tree.leavesMesh.material,
        pts.length
      );

      branchesIM.castShadow = true;
      branchesIM.receiveShadow = true;
      // Deliberate: leaves do NOT cast shadows. At this tree density the
      // ~800k leaf-cluster cards are effectively opaque in the shadow map
      // and blanket the entire ground in darkness. The dense branch networks
      // alone produce the dappled light pools of the reference shots.
      leavesIM.castShadow = false;
      leavesIM.receiveShadow = true;

      pts.forEach((p, i) => {
        const scale = 0.7 + rng() * 0.6; // ±30%
        dummy.position.set(p.x, getHeight(p.x, p.z) - 0.08, p.z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        branchesIM.setMatrixAt(i, dummy.matrix);
        leavesIM.setMatrixAt(i, dummy.matrix);

        treeColliders.push({
          x: p.x,
          z: p.z,
          r: variant.species.trunkR * scale,
        });
      });

      // Real bounds (world-space, since instances carry world positions) —
      // this is what makes per-cell frustum culling work.
      branchesIM.computeBoundingSphere();
      leavesIM.computeBoundingSphere();

      scene.add(branchesIM);
      scene.add(leavesIM);

      cellMeshes.push({
        center: branchesIM.boundingSphere.center,
        radius: Math.max(branchesIM.boundingSphere.radius, leavesIM.boundingSphere.radius),
        meshes: [branchesIM, leavesIM],
      });
    }
  }

  createFallenLogs(scene, rng);
}

// Wind uniforms + distance culling: cells fully beyond the fog's reach are
// switched off entirely (frustum culling handles the rest per-frame).
// The cutoff is fog-dependent: with fog disabled the caller passes Infinity
// so distant cells don't visibly pop (frustum culling still applies).
export function updateTrees(elapsedTime, cameraPos, viewCutoff = VIEW_CUTOFF) {
  for (const mat of leafMaterials) {
    const shader = mat.userData.shader;
    if (shader) shader.uniforms.uTime.value = elapsedTime;
  }

  if (!cameraPos) return;
  for (const cell of cellMeshes) {
    const dx = cell.center.x - cameraPos.x;
    const dz = cell.center.z - cameraPos.z;
    const limit = viewCutoff + cell.radius;
    const visible = dx * dx + dz * dz < limit * limit;
    cell.meshes[0].visible = visible;
    cell.meshes[1].visible = visible;
  }
}

function createFallenLogs(scene, rng) {
  // Reuse ez-tree's oak bark so logs match the standing trees.
  const barkSource = new Tree();
  barkSource.loadPreset('Oak Small');
  const logMat = barkSource.branchesMesh.material;

  const logGeo = new THREE.CylinderGeometry(0.22, 0.32, 5.5, 9);
  logGeo.rotateZ(Math.PI / 2); // lie on the ground along local X

  // 31 forest logs (scaled with the Phase 16 forest area) + 5 shore logs
  // lying roughly parallel to the waterline (the lake didn't grow).
  let placed = 0;
  let tries = 0;
  while (placed < 36 && tries < 900) {
    tries++;
    const shoreLog = placed >= 31;
    let ang = rng() * Math.PI * 2;
    let rad = shoreLog
      ? 52 + rng() * 38
      : 15 + rng() * (WORLD_RADIUS - 25);
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (getRiverDistance(x, z).d < 12) continue;
    const lh = getHeight(x, z);
    if (shoreLog) {
      if (lh < -0.9 || lh > 0.4) continue;
    } else if (lh < -0.4 || lh > 30 || getSlope(x, z) > 0.5) {
      continue;
    }
    placed++;

    const log = new THREE.Mesh(logGeo, logMat);
    log.position.set(x, getHeight(x, z) + 0.16, z);
    log.rotation.y = rng() * Math.PI * 2;
    log.rotation.x = (rng() - 0.5) * 0.15; // slight tilt into the ground
    log.castShadow = true;
    log.receiveShadow = true;
    scene.add(log);

    logColliders.push({
      x,
      y: log.position.y,
      z,
      yaw: log.rotation.y,
      tilt: log.rotation.x,
      halfLen: 2.75,
      r: 0.3,
    });
  }
}
