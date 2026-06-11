import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  getHeight,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
  SPAWN,
} from './terrain.js';
import {
  getWheat,
  getDeepForest,
  getWorldTreeClearing,
  WORLD_TREE_X,
  WORLD_TREE_Z,
} from './biomes.js';
import { bakeTreeImpostor, getImpostorQuad, IMPOSTOR_DIST } from './impostors.js';

const TREE_COUNT = 3200;     // 900 m world (Phase 38 compaction); deep-forest headroom included
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
const CELL_SIZE = 66;   // ~14x14 cells over the ±450 m world (Phase 38)
const GRID_HALF = 450;
// At FogExp2 density 0.026, transmittance at 110 m is ~0.1% — cells beyond
// this are invisible, not "barely visible".
const VIEW_CUTOFF = 110;

const cellMeshes = []; // {center, radius, meshes: [branchesIM, leavesIM], impostor, leafFull, leafSparse}

// Leaf LOD (perf batch, 2026-06-11): leaves are ~77% of a tree's triangles.
// Cells beyond this distance swap to a sparse leaf geometry (1 of every 3
// cards, scaled up to keep canopy coverage) — ~2.1x fewer tree triangles at
// distance, invisible through the atmospheric haze.
const LEAF_LOD_DIST = 140;

// Water pre-passes (refraction/reflection) render half-res and heavily
// distorted/mirrored — beyond this distance even FULL-GEOMETRY cells switch
// to their impostor quads for those two renders (perf batch 2026-06-11:
// tree vertices were being paid in 4 passes; this removes them from 2).
// Closer than this, reflected trees keep real geometry (shoreline trees
// reflect at close range where a 128 px impostor tile would read blobby).
const PREPASS_GEO_DIST = 80;

// LOD hysteresis (perf batch): enter/exit distances differ so a cell
// sitting exactly on a boundary doesn't flip representation every frame
// while the player strafes along it (state churn + visible popping).
const IMPOSTOR_HYST = 15;
const LEAF_LOD_HYST = 12;

// Collider data consumed by core/physics.js (Phase 8).
export const treeColliders = []; // trunks: {x, z, r, halfH?} (halfH: world tree only)
export const logColliders = [];  // fallen logs: {x, y, z, yaw, tilt, halfLen, r}
// Root flares of the world tree (Phase 39) — ball colliders, fed through the
// same path as rock colliders in main.js. v11: EMPTY (the standard oak
// needs no root colliders) but the export stays for main.js's concat.
export const worldTreeFlares = []; // {x, y, z, r}

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

// Build the sparse leaf geometry: keep every Nth leaf card, scaled up about
// its centroid so the canopy keeps its visual coverage. ez-tree leaves are
// indexed quads (4 unique verts + 6 indices per card, no sharing across
// cards) — verified live; vert ids are derived from the index so any
// per-card layout works.
function buildSparseLeaves(geo, keepEvery = 3, scale = 1.75) {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const index = geo.index;
  const quadCount = index.count / 6;
  const keptMax = Math.ceil(quadCount / keepEvery);

  const p = new Float32Array(keptMax * 4 * 3);
  const nr = new Float32Array(keptMax * 4 * 3);
  const u = new Float32Array(keptMax * 4 * 2);
  const idx = new Uint32Array(keptMax * 6);

  let q = 0;
  const local = new Map();
  for (let i = 0; i < quadCount; i += keepEvery) {
    // Unique source verts of this card, in first-seen order.
    local.clear();
    for (let k = 0; k < 6; k++) {
      const v = index.getX(i * 6 + k);
      if (!local.has(v)) local.set(v, local.size);
    }
    if (local.size !== 4) continue; // not a quad — skip defensively

    let cx = 0, cy = 0, cz = 0;
    for (const v of local.keys()) {
      cx += pos.getX(v); cy += pos.getY(v); cz += pos.getZ(v);
    }
    cx /= 4; cy /= 4; cz /= 4;

    const base = q * 4;
    for (const [v, li] of local) {
      const o = base + li;
      p[o * 3 + 0] = cx + (pos.getX(v) - cx) * scale;
      p[o * 3 + 1] = cy + (pos.getY(v) - cy) * scale;
      p[o * 3 + 2] = cz + (pos.getZ(v) - cz) * scale;
      nr[o * 3 + 0] = norm.getX(v);
      nr[o * 3 + 1] = norm.getY(v);
      nr[o * 3 + 2] = norm.getZ(v);
      u[o * 2 + 0] = uv.getX(v);
      u[o * 2 + 1] = uv.getY(v);
    }
    for (let k = 0; k < 6; k++) {
      idx[q * 6 + k] = base + local.get(index.getX(i * 6 + k));
    }
    q++;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(p.subarray(0, q * 12), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nr.subarray(0, q * 12), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(u.subarray(0, q * 8), 2));
  out.setIndex(new THREE.BufferAttribute(idx.subarray(0, q * 6), 1));
  return out;
}

export function createTrees(scene, renderer) {
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
    // Beach ring stays open (v7: the lake vista reads from the field edge);
    // the island keeps its trees.
    if (getLakeDistance(x, z) < 102 && Math.hypot(x - 128, z - 32) > 22)
      continue;
    const h = getHeight(x, z);
    if (h < -0.4) continue;
    if (h > 15) continue; // Phase 17 treeline — the range above is bare rock
    if (h > 11 && rng() > 0.35) continue; // sparse near the treeline
    if (getSlope(x, z) > 0.65) continue;  // too steep for roots

    // Wheat field (Phase 18): no scattered trees inside the field proper
    // (the lone oaks are placed explicitly below); the soft mask edge
    // still blends the forest boundary naturally.
    if (rng() < getWheat(x, z) * 1.15) continue;
    // World-tree clearing (Phase 39): nothing competes under the canopy.
    if (getWorldTreeClearing(x, z) > 0.02) continue;

    // Density noise carves natural clearings and groves; the deep-forest
    // east closes most clearings (denser, darker woodland).
    if (densityNoise.noise(x / 75, z / 75) < -0.45 + getDeepForest(x, z) * -0.35)
      continue;

    // Deep forest packs tighter (Phase 18 fix): the blue-noise MIN_DIST is
    // what actually caps density — clearings-closure alone wasn't enough.
    // Shrinking it east gives ~1.6x density (hash grid stays valid since
    // the effective distance only ever shrinks).
    const minDist = MIN_DIST * (1 - getDeepForest(x, z) * 0.38);
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
          if (ddx * ddx + ddz * ddz < minDist * minDist) {
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

  // Lone oaks (Phase 18 → trimmed by Phase 39): 2 supporting-cast oaks near
  // the field edges — the world tree owns the center now.
  const oakVariant = variants.find((v) => v.species.preset === 'Oak Medium');
  for (const [lx, lz] of [[-205, 130], [-78, -118]]) {
    oakVariant.points.push({ x: lx, z: lz, loneOak: true });
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

    const leafFull = tree.leavesMesh.geometry;
    const leafSparse = buildSparseLeaves(leafFull);

    // Phase 35 (pulled forward): bake this variant's view atlas once — far
    // cells render one quad per tree instead of the full geometry.
    const imp = bakeTreeImpostor(renderer, tree.branchesMesh, tree.leavesMesh);

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

      const impostorIM = new THREE.InstancedMesh(
        getImpostorQuad(),
        imp.material,
        pts.length
      );
      impostorIM.castShadow = false; // shadow window ends where impostors start
      impostorIM.receiveShadow = false;

      pts.forEach((p, i) => {
        // Lone field oaks stand full-size; forest trees vary ±30%.
        const scale = p.loneOak ? 1.45 : 0.7 + rng() * 0.6;
        dummy.position.set(p.x, getHeight(p.x, p.z) - 0.08, p.z);
        dummy.rotation.set(0, rng() * Math.PI * 2, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        branchesIM.setMatrixAt(i, dummy.matrix);
        leavesIM.setMatrixAt(i, dummy.matrix);
        impostorIM.setMatrixAt(i, dummy.matrix);

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
      // The impostor quads expand to 2x the baked radius IN THE SHADER —
      // three.js culls by the raw unit-quad bounds, so inflate manually.
      impostorIM.boundingSphere = branchesIM.boundingSphere.clone();
      impostorIM.boundingSphere.radius += imp.radius * 1.6;
      impostorIM.frustumCulled = true;
      impostorIM.visible = false; // updateTrees flips it past IMPOSTOR_DIST

      scene.add(branchesIM);
      scene.add(leavesIM);
      scene.add(impostorIM);

      cellMeshes.push({
        center: branchesIM.boundingSphere.center,
        radius: Math.max(branchesIM.boundingSphere.radius, leavesIM.boundingSphere.radius),
        meshes: [branchesIM, leavesIM],
        impostor: impostorIM,
        leafFull,
        leafSparse,
      });
    }
  }

  createWorldTree(scene);
  createFallenLogs(scene, rng);
}

// ---------------------------------------------------------------------------
// Phase 39 v14 — the lone oak is the user-supplied Sketchfab model:
// "Old Oak Tree" (https://sketchfab.com/3d-models/old-oak-tree-810208743d0e4cffadb15e77211b3a60)
// by BazukaliKartal, CC-BY-4.0 — credit required; license.txt ships next to
// the model in public/models/old_oak_tree/. 315k faces, full PBR bark +
// leaf textures. GOTCHA: the export required KHR_materials_pbrSpecular-
// Glossiness, which three.js GLTFLoader no longer supports — scene.gltf
// was converted to metallic-roughness offline (see PLAN v14).
// Loaded async; the collider is pushed synchronously so physics init
// never waits. Still a plain scene-level object, never in cellMeshes —
// skips the distance cutoff and pre-pass culling, anchors the field.
// ---------------------------------------------------------------------------
const WORLD_TREE_TARGET_H = 24;

function createWorldTree(scene) {
  // Physics first (sync): sturdy old-oak trunk at this scale.
  treeColliders.push({ x: WORLD_TREE_X, z: WORLD_TREE_Z, r: 1.1 });

  const baseY = getHeight(WORLD_TREE_X, WORLD_TREE_Z);

  new GLTFLoader().load('/models/old_oak_tree/scene.gltf', (gltf) => {
    const root = gltf.scene;

    // Scale by the MEASURED bbox (Sketchfab exports carry arbitrary node
    // scales); seat the bbox bottom slightly below the terrain.
    const bb = new THREE.Box3().setFromObject(root);
    const scale = WORLD_TREE_TARGET_H / (bb.max.y - bb.min.y);
    root.scale.multiplyScalar(scale);
    root.position.set(
      WORLD_TREE_X,
      baseY - bb.min.y * scale - 0.2,
      WORLD_TREE_Z
    );

    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      if (!m) return;
      // Leaves ship as alphaMode BLEND — transparent sorting falls apart
      // inside a dense canopy and BLEND skips the depth the AO / godrays /
      // water passes read. Alpha-tested cutout is the correct foliage mode
      // and makes the leaf shadows work for free.
      if (m.transparent) {
        m.transparent = false;
        m.depthWrite = true;
        m.alphaTest = Math.max(m.alphaTest || 0, 0.45);
        m.needsUpdate = true;
      }
    });

    scene.add(root);
  });

  createWorldTreeWeeds(scene);
}

// ---------------------------------------------------------------------------
// v11 weeds: scruffy tufts under and around the oak. Same recipe as the
// grass field (grass.js: tapered 3-tri blade, root->tip gradient,
// instancing-aware sway) but tuft-bundled, taller, and in dry olive/straw
// tones so the patch reads as weeds, not lawn. Static one-shot scatter —
// the patch is small and the wheat mask already owns the field beyond it.
// ---------------------------------------------------------------------------
const WEED_COUNT = 700;
const WEED_RADIUS = 16;

function createWorldTreeWeeds(scene) {
  const rng = mulberry32(46368);

  // Tuft: 3 tapered blades fanned around the root (15 verts, 9 tris).
  const w = 0.045;
  const blade = [
    [-w, 0, 0], [w, 0, 0], [-w * 0.5, 0.5, 0.07], [w * 0.5, 0.5, 0.07], [0, 1.0, 0.2],
  ];
  const positions = [];
  const indices = [];
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const lean = 0.16 + (b % 2) * 0.1; // blades splay outward
    const base = b * 5;
    for (const [bx, by, bz] of blade) {
      const x = bx + by * lean * 0.5;
      const z = bz;
      positions.push(ca * x - sa * z, by, sa * x + ca * z);
    }
    indices.push(
      base, base + 1, base + 2,
      base + 2, base + 1, base + 3,
      base + 2, base + 3, base + 4
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1; // lit as ground
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  patchWeedMaterial(material);
  leafMaterials.push(material); // updateTrees drives uTime for the sway

  const mesh = new THREE.InstancedMesh(geometry, material, WEED_COUNT);
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < WEED_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 0.8 + Math.sqrt(rng()) * WEED_RADIUS;
    const x = WORLD_TREE_X + Math.cos(ang) * rad;
    const z = WORLD_TREE_Z + Math.sin(ang) * rad;
    dummy.position.set(x, getHeight(x, z) - 0.02, z);
    dummy.rotation.set((rng() - 0.5) * 0.2, rng() * Math.PI * 2, (rng() - 0.5) * 0.2);
    const tall = 0.45 + rng() * 0.65; // 0.45-1.1 m — scruffier than the lawn
    dummy.scale.set(0.8 + rng() * 0.5, tall, 0.8 + rng() * 0.5);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    // Dry weed palette: olive greens with straw-brown strays.
    if (rng() < 0.25) color.setHSL(0.12 + rng() * 0.04, 0.45 + rng() * 0.2, 0.38 + rng() * 0.14);
    else color.setHSL(0.2 + rng() * 0.06, 0.35 + rng() * 0.25, 0.32 + rng() * 0.16);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
}

// Same wind/gradient treatment as the grass field (grass.js), tuned to
// weeds: stronger sway on the taller stems, dry straw-tipped gradient.
function patchWeedMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };

    shader.vertexShader =
      `
      uniform float uTime;
      varying float vBladeY;
      varying vec3 vUpViewNormal;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vBladeY = position.y;
      vUpViewNormal = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));

      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif

      float phase = mvPosition.x * 0.9 + mvPosition.z * 0.8;
      float sway = position.y * position.y * (
        0.09 * sin(uTime * 1.2 + phase) +
        0.04 * sin(uTime * 2.7 + phase * 1.6)
      );
      mvPosition.x += sway;
      mvPosition.z += sway * 0.7;

      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    shader.fragmentShader =
      `
      varying float vBladeY;
      varying vec3 vUpViewNormal;
      ` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      /* glsl */ `
      #include <normal_fragment_begin>
      normal = normalize(vUpViewNormal);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `
      #include <color_fragment>
      diffuseColor.rgb *= mix(
        vec3(0.3, 0.33, 0.2),
        vec3(1.05, 1.0, 0.78),
        pow(clamp(vBladeY, 0.0, 1.0), 1.3)
      );
      `
    );

    mat.userData.shader = shader;
  };
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
    const d2 = dx * dx + dz * dz;
    const limit = viewCutoff + cell.radius;
    const inView = d2 < limit * limit;

    // Phase 35: three states — full geometry near, ONE QUAD PER TREE beyond
    // IMPOSTOR_DIST, nothing past the fog cutoff (fog on only; with fog off
    // viewCutoff is Infinity and the far field is all impostors).
    // Hysteresis: a full-geo cell stays full until IMPOSTOR_DIST; an
    // impostor cell only promotes back inside IMPOSTOR_DIST - HYST.
    const wasGeo = cell._fullGeo !== false; // first frame counts as full
    const geoLimit =
      (wasGeo ? IMPOSTOR_DIST : IMPOSTOR_DIST - IMPOSTOR_HYST) + cell.radius;
    const fullGeo = inView && d2 < geoLimit * geoLimit;
    cell._fullGeo = fullGeo;
    cell.meshes[0].visible = fullGeo;
    cell.meshes[1].visible = fullGeo;
    cell.impostor.visible = inView && !fullGeo;

    // Leaf LOD: distant cells render the sparse leaf set (geometry swap is
    // just a reference change; instance matrices live on the mesh). Same
    // hysteresis idea: demote at LEAF_LOD_DIST, promote at -HYST.
    if (fullGeo) {
      const wasSparse = cell.meshes[1].geometry === cell.leafSparse;
      const lodLimit =
        (wasSparse ? LEAF_LOD_DIST - LEAF_LOD_HYST : LEAF_LOD_DIST) +
        cell.radius;
      const target = d2 > lodLimit * lodLimit ? cell.leafSparse : cell.leafFull;
      if (cell.meshes[1].geometry !== target) cell.meshes[1].geometry = target;
    }
  }
}

// ---------------------------------------------------------------------------
// Water pre-pass culling: prepareWater (water.js) brackets its refraction +
// reflection renders with these — distant tree cells contribute nothing to
// a half-res distorted/mirrored image. Restores exactly what it hid, so the
// state set by updateTrees above survives.
// ---------------------------------------------------------------------------
const _prePassSwapped = [];

export function beginWaterPrePass(cameraPos) {
  for (const cell of cellMeshes) {
    // Cells hidden by the fog cutoff stay hidden; cells already showing
    // impostors stay impostors (one quad per tree is pre-pass noise).
    // Full-geometry cells beyond PREPASS_GEO_DIST swap to their impostor
    // for the two half-res water renders — tree vertices stop being paid
    // in the refraction/reflection passes, and (bonus) the far shore now
    // ACTUALLY REFLECTS past the old 200 m pre-pass cutoff instead of
    // showing empty terrain in the mirror.
    if (!cell.meshes[0].visible) continue;
    const dx = cell.center.x - cameraPos.x;
    const dz = cell.center.z - cameraPos.z;
    const limit = PREPASS_GEO_DIST + cell.radius;
    if (dx * dx + dz * dz > limit * limit) {
      cell.meshes[0].visible = false;
      cell.meshes[1].visible = false;
      cell.impostor.visible = true;
      _prePassSwapped.push(cell);
    }
  }
}

export function endWaterPrePass() {
  // Only full-geo cells were swapped (see above), so restore is exact.
  for (const cell of _prePassSwapped) {
    cell.meshes[0].visible = true;
    cell.meshes[1].visible = true;
    cell.impostor.visible = false;
  }
  _prePassSwapped.length = 0;
}

// ---------------------------------------------------------------------------
// Phase 23 — Natural logs: tapered cross-section swept along a bent spine,
// low-frequency surface noise, jagged broken ends, moss on the up-facing
// bark. Local X runs along the log; vertex colors tint the shared ez-tree
// bark texture (white = bark, green = moss, pale = broken end-grain).
// ---------------------------------------------------------------------------
function buildLogGeometry(rng, noise) {
  const L = 4.4 + rng() * 2.2;          // length
  const rBase = 0.26 + rng() * 0.1;     // thick end radius
  const rTip = rBase * (0.5 + rng() * 0.2);
  const bendY = 0.08 + rng() * 0.12;    // spine sag/arch
  const bendZ = (rng() - 0.5) * 0.3;    // sideways drift
  const seed = rng() * 100;
  const mossiness = 0.55 + rng() * 0.45;
  const RINGS = 15;
  const SEGS = 10;

  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const isEnd = i === 0 || i === RINGS;
    const x = (t - 0.5) * L;
    const cy = bendY * Math.sin(t * Math.PI);            // arch off the ground
    const cz = bendZ * Math.sin(t * Math.PI + 1.3);
    // Low-frequency thickness variation + taper (swells read as knots).
    const rRing =
      (rBase + (rTip - rBase) * t) *
      (1 + 0.14 * noise.noise(t * 2.6 + seed, seed * 1.7));

    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Per-vertex bark lumpiness; end rings also get jagged X so the
      // silhouette of the break is irregular, not a clean circle.
      const lump = 1 + 0.09 * noise.noise(a * 1.1 + seed * 3.1, t * 5.0 + seed);
      const r = rRing * lump;
      const jag = isEnd ? (noise.noise(a * 2.3 + seed * 7.7, seed) * 0.5) * 0.3 : 0;
      positions.push(x + jag * (i === 0 ? -1 : 1), cy + sa * r, cz + ca * r);
      uvs.push((j / SEGS) * 2, t * (L / 1.6)); // bark tiles along the trunk

      // Moss creeps over the upper surface in patches; >1 channels are fine
      // (vertex color multiplies the bark map).
      const up = sa; // local +Y component of the radial direction
      const patch = 0.5 + 0.5 * noise.noise(a * 1.5 + seed * 11, t * 3.2 + seed * 5);
      const moss = THREE.MathUtils.smoothstep(up, 0.25, 0.9) * mossiness * patch;
      colors.push(
        1 - moss * 0.55,
        1 + moss * 0.5,
        1 - moss * 0.65
      );
    }
  }

  const vw = SEGS + 1;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * vw + j;
      // Winding chosen so computeVertexNormals points OUTWARD (the first
      // attempt rendered the log inside-out: black top, lit interior).
      indices.push(a, a + vw, a + 1, a + 1, a + vw, a + vw + 1);
    }
  }

  // Broken end caps: fan from each jagged end ring to a center point inset
  // INTO the log — pale end-grain against the bark.
  for (const end of [0, RINGS]) {
    const ci = positions.length / 3;
    const t = end / RINGS;
    const inset = end === 0 ? 0.12 : -0.12;
    positions.push(
      (t - 0.5) * L + inset,
      bendY * Math.sin(t * Math.PI),
      bendZ * Math.sin(t * Math.PI + 1.3)
    );
    uvs.push(0.5, 0.5);
    colors.push(1.7, 1.45, 1.05); // pale split wood
    const ringStart = end * vw;
    for (let j = 0; j < SEGS; j++) {
      if (end === 0) indices.push(ci, ringStart + j + 1, ringStart + j);
      else indices.push(ci, ringStart + j, ringStart + j + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, halfLen: L / 2 - 0.2, r: rBase * 0.95 };
}

function createFallenLogs(scene, rng) {
  // Reuse ez-tree's oak bark so logs match the standing trees; vertex
  // colors carry the moss/end-grain tinting on top of it.
  const barkSource = new Tree();
  barkSource.loadPreset('Oak Small');
  const logMat = barkSource.branchesMesh.material;
  logMat.vertexColors = true;
  logMat.needsUpdate = true;

  const logNoise = new SimplexNoise({ random: mulberry32(8181) });
  const variants = [];
  for (let i = 0; i < 4; i++) variants.push(buildLogGeometry(rng, logNoise));

  // 18 forest logs (Phase 38 compacted area) + 5 shore logs lying roughly
  // parallel to the waterline (ring centered on the MOVED lake).
  let placed = 0;
  let tries = 0;
  while (placed < 23 && tries < 900) {
    tries++;
    const shoreLog = placed >= 18;
    let ang = rng() * Math.PI * 2;
    let rad = shoreLog
      ? 52 + rng() * 38
      : 15 + rng() * (WORLD_RADIUS - 25);
    const cx = shoreLog ? 90 : 0; // shore ring follows the lake center
    const x = cx + Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (getRiverDistance(x, z).d < 12) continue;
    const lh = getHeight(x, z);
    if (shoreLog) {
      if (lh < -0.9 || lh > 0.4) continue;
    } else if (lh < -0.4 || lh > 30 || getSlope(x, z) > 0.5) {
      continue;
    }
    placed++;

    const variant = variants[Math.floor(rng() * variants.length)];
    const log = new THREE.Mesh(variant.geometry, logMat);
    log.position.set(x, getHeight(x, z) + variant.r * 0.55, z);
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
      halfLen: variant.halfLen,
      r: variant.r,
    });
  }
}
