import * as THREE from 'three';
import { getHeight } from './terrain.js';
import { getWheat, getWorldTreeClearing } from './biomes.js';
import { WATER_EXCLUDED_LAYER } from './water.js';

// Wheat rendering (Phase 19): the golden field. ~250k STATIC stalks over the
// Phase 18 wheat mask — instanced per grid cell with real bounding spheres so
// three.js frustum-culls whole cells (tree pattern; the field never moves, so
// no grass-style relocation). Each stalk = thin stem quad + two crossed
// seed-head quads (6 tris). The signature look is the GUST: one shared
// large-wavelength wind wave travels across the whole field, leaning stalks
// and brightening the gust front, plus small per-stalk flutter.

const COUNT = 620000; // v7 field is ~1.3x larger — keeps the Phase 19 density
const CELL = 55; // m — field is ~250x350, so ~5x7 cells
const STALK_H = 1.25; // chest-height like the reference (scaled 1.0-1.5 m)

// --- Near-field densifier (2026-06-11, user request: denser wheat). A
// player-following pool of EXTRA stalks inside a 55 m circle — density is
// only perceptible up close (past ~60 m a stalk is sub-pixel), so the field
// reads DENSE_LAYERS+1 times denser everywhere you can tell while the
// global stalk budget stays flat. Same relocation pattern as grass.js:
// scan a block per frame, move stalks the player left behind. Costs zero
// outside the field (mesh hidden, scan skipped).
const DENSE_LAYERS = 2;        // extra layers on top of the base field = 3x
                               // total near density; set 3 for 4x
const DENSE_PER_LAYER = 95000; // base density (~9.3/m^2) x pi*55^2, rounded up
const DENSE_POOL = DENSE_PER_LAYER * DENSE_LAYERS;
const DENSIFY_RADIUS = 55;     // m around the player
const DENSE_PER_FRAME = 8000;  // full pool sweep every ~24 frames (~0.4 s)

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

// --- Stalk geometry: stem quad (y 0..0.82) + crossed head quads (y 0.78..1).
// Heights are normalized 0..1; per-instance scale stretches the whole stalk.
function buildStalkGeometry() {
  const w = 0.016;  // stem half-width
  const hw = 0.028; // head half-width — real heads are narrow; wide quads read as flags up close
  const positions = [
    // stem (XY plane)
    -w, 0, 0,   w, 0, 0,   -w * 0.7, 0.82, 0.02,   w * 0.7, 0.82, 0.02,
    // head quad A (XY plane), slightly tapered top
    -hw, 0.78, 0.02,   hw, 0.78, 0.02,   -hw * 0.45, 1.0, 0.05,   hw * 0.45, 1.0, 0.05,
    // head quad B (ZY plane)
    0.02, 0.78, -hw,   0.02, 0.78, hw,   0.05, 1.0, -hw * 0.45,   0.05, 1.0, hw * 0.45,
  ];
  const indices = [
    0, 1, 2, 2, 1, 3,
    4, 5, 6, 6, 5, 7,
    8, 9, 10, 10, 9, 11,
  ];
  const normals = [];
  for (let i = 0; i < 12; i++) normals.push(0, 1, 0); // lit as ground plane
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  return geometry;
}

// Lambert keeps shadows/fog/hemisphere for free (grass.js pattern):
// instancing-aware gust+flutter sway in the vertex stage, world-up lighting
// normal, root->tip gradient + gust-front brightening in the fragment.
function patchWheatMaterial(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };

    shader.vertexShader =
      `
      uniform float uTime;
      varying float vStalkY;
      varying float vGust;
      varying vec3 vUpViewNormal;
      ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vStalkY = position.y; // 0 root -> 1 tip (pre-transform)
      vUpViewNormal = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));

      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif

      // THE GUST: one wave shared by the whole field, traveling along
      // GUST_DIR. Harmonics keep the front from reading as a metronome.
      const vec2 GUST_DIR = vec2(0.916, 0.4);
      float gp = dot(mvPosition.xz, GUST_DIR) / 26.0 - uTime * 1.05;
      float gust = sin(gp) * 0.55
                 + sin(gp * 0.37 + 1.7) * 0.3
                 + sin(gp * 2.31 + uTime * 0.35) * 0.15;
      // Small per-stalk flutter on top.
      float flutter = sin(uTime * 3.2 + mvPosition.x * 0.9 + mvPosition.z * 0.8);

      float tip = position.y * position.y; // roots planted, tips ride
      vec2 lean = GUST_DIR * (gust * 0.26 + flutter * 0.045) * tip;
      mvPosition.x += lean.x;
      mvPosition.z += lean.y;
      vGust = gust;

      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    shader.fragmentShader =
      `
      varying float vStalkY;
      varying float vGust;
      varying vec3 vUpViewNormal;
      ` + shader.fragmentShader;

    // Light every fragment as if it were the ground plane — no black
    // backfaces, the field blends into the terrain lighting.
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
      // Root->tip: straw stems to warm ripe-gold heads (reference photo:
      // bright continuous gold, not olive), brightened along the gust
      // front (the rolling shimmer real wheat fields have).
      float tipT = pow(clamp(vStalkY, 0.0, 1.0), 1.1);
      diffuseColor.rgb *= mix(
        vec3(0.58, 0.49, 0.25),
        vec3(1.38, 1.10, 0.54),
        tipT
      );
      diffuseColor.rgb *= 1.0 + vGust * 0.08 * tipT;
      `
    );

    mat.userData.shader = shader;
  };
}

export function createWheat(scene) {
  const rng = mulberry32(190919);
  const geometry = buildStalkGeometry();

  material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  patchWheatMaterial(material);

  // --- Scatter into grid cells over the field bbox.
  const cells = new Map(); // key -> array of matrices-ish
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  let placed = 0;
  let attempts = 0;
  const placements = [];
  while (placed < COUNT && attempts < COUNT * 6) {
    attempts++;
    const x = -300 + rng() * 345; // v7 field bbox (+ soft edge margin)
    const z = -200 + rng() * 425;
    const wheat = getWheat(x, z);
    if (wheat <= 0.05) continue;
    // Density follows the mask: full inside, thinning at the warped edges.
    if (rng() > Math.pow(wheat, 1.3)) continue;
    // World-tree clearing (Phase 39): the field fades out under the canopy.
    if (rng() < getWorldTreeClearing(x, z) * 1.25) continue;
    const h = getHeight(x, z);
    if (h < -0.5) continue; // stay on dry ground
    // Height backstop (2026-06-11): wheat stops at the hill feet — the
    // flattened field tops out ~3.7 m, foothill slopes blow past 5 m.
    // Ramped (3.8-5.0) so the cutoff reads as natural thinning, not a line.
    if (h > 3.8 + rng() * 1.2) continue;
    placements.push({ x, z, h });
    placed++;
  }

  for (const p of placements) {
    const key = Math.floor((p.x + 600) / CELL) + ',' + Math.floor((p.z + 600) / CELL);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }

  for (const pts of cells.values()) {
    const im = new THREE.InstancedMesh(geometry, material, pts.length);
    pts.forEach((p, i) => {
      dummy.position.set(p.x, p.h - 0.02, p.z);
      dummy.rotation.set((rng() - 0.5) * 0.16, rng() * Math.PI * 2, (rng() - 0.5) * 0.16);
      dummy.scale.set(1, STALK_H * (0.78 + rng() * 0.42), 1);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      // Per-stalk jitter around gold (multiplies the shader gradient).
      // Tight range — wide jitter produced scattered dark-olive outliers.
      color.setHSL(0.112 + rng() * 0.024, 0.5 + rng() * 0.15, 0.58 + rng() * 0.12);
      im.setColorAt(i, color);
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = true;
    im.computeBoundingSphere(); // real bounds -> per-cell frustum culling
    // Skipped by the water pre-passes, same as grass (main camera enables
    // this layer).
    im.layers.set(WATER_EXCLUDED_LAYER);
    scene.add(im);
  }

  createDensifier(scene, geometry);

  return placements.length;
}

// ---------------------------------------------------------------------------
// Densifier pool: one dynamic InstancedMesh sharing the stalk geometry and
// the gust material. Stalks not currently placeable are "parked" — zero
// scale, 1 km underground — which also puts them outside the keep radius so
// the round-robin scan retries them automatically next sweep.
// ---------------------------------------------------------------------------
let denseMesh = null;
let denseCursor = 0;
let denseLive = 0; // placed (non-parked) stalk count
let densePlaced = null; // Uint8Array(DENSE_POOL)
let denseRng = null;
const _denseDummy = new THREE.Object3D();
const _denseColor = new THREE.Color();
const _denseM = new THREE.Matrix4();
const _parkM = new THREE.Matrix4().set(
  0, 0, 0, 0,
  0, 0, 0, -1000,
  0, 0, 0, 0,
  0, 0, 0, 1
);
const DENSE_KEEP_R2 = DENSIFY_RADIUS * DENSIFY_RADIUS * 1.15;

function createDensifier(scene, geometry) {
  denseRng = mulberry32(771177);
  densePlaced = new Uint8Array(DENSE_POOL);
  denseMesh = new THREE.InstancedMesh(geometry, material, DENSE_POOL);
  denseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < DENSE_POOL; i++) {
    denseMesh.setMatrixAt(i, _parkM);
    denseMesh.setColorAt(i, _denseColor.setRGB(1, 1, 1)); // allocates buffer
  }
  denseMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  denseMesh.instanceMatrix.needsUpdate = true;
  denseMesh.instanceColor.needsUpdate = true;
  denseMesh.castShadow = false;
  denseMesh.receiveShadow = true;
  // Always hugs the player when visible — frustum culling can't help, and
  // the bounding sphere would be stale anyway.
  denseMesh.frustumCulled = false;
  denseMesh.layers.set(WATER_EXCLUDED_LAYER);
  denseMesh.visible = false;
  scene.add(denseMesh);
}

// Try to place stalk i near the player; park it if no spot qualifies.
// Returns true when the instance buffers changed.
function placeDense(i, px, pz, inField) {
  if (inField) {
    for (let t = 0; t < 8; t++) {
      const ang = denseRng() * Math.PI * 2;
      const rad = DENSIFY_RADIUS * Math.sqrt(denseRng());
      const x = px + Math.cos(ang) * rad;
      const z = pz + Math.sin(ang) * rad;
      const wheat = getWheat(x, z);
      if (wheat <= 0.05) continue;
      // Same acceptance rules as the base scatter — the densifier follows
      // the mask edges and the world-tree clearing exactly.
      if (denseRng() > Math.pow(wheat, 1.3)) continue;
      if (denseRng() < getWorldTreeClearing(x, z) * 1.25) continue;
      const h = getHeight(x, z);
      if (h < -0.5) continue;
      if (h > 3.8 + denseRng() * 1.2) continue; // same hill-feet backstop
      _denseDummy.position.set(x, h - 0.02, z);
      _denseDummy.rotation.set(
        (denseRng() - 0.5) * 0.16,
        denseRng() * Math.PI * 2,
        (denseRng() - 0.5) * 0.16
      );
      _denseDummy.scale.set(1, STALK_H * (0.78 + denseRng() * 0.42), 1);
      _denseDummy.updateMatrix();
      denseMesh.setMatrixAt(i, _denseDummy.matrix);
      _denseColor.setHSL(
        0.112 + denseRng() * 0.024,
        0.5 + denseRng() * 0.15,
        0.58 + denseRng() * 0.12
      );
      denseMesh.setColorAt(i, _denseColor);
      if (!densePlaced[i]) {
        densePlaced[i] = 1;
        denseLive++;
      }
      return true;
    }
  }
  if (densePlaced[i]) {
    denseMesh.setMatrixAt(i, _parkM);
    densePlaced[i] = 0;
    denseLive--;
    return true;
  }
  return false; // already parked — no buffer write
}

export function updateWheat(elapsedTime, playerPos) {
  const shader = material?.userData.shader;
  if (shader) shader.uniforms.uTime.value = elapsedTime;
  if (!playerPos || !denseMesh) return;

  // Cheap gate: outside the field with an empty pool there is nothing to
  // scan, place, or draw (one mask sample per frame).
  const inField = getWheat(playerPos.x, playerPos.z) > 0.02;
  if (!inField && denseLive === 0) {
    denseMesh.visible = false;
    return;
  }
  denseMesh.visible = true;

  const start = denseCursor;
  const end = Math.min(start + DENSE_PER_FRAME, DENSE_POOL);
  let changed = false;
  for (let i = start; i < end; i++) {
    if (densePlaced[i]) {
      denseMesh.getMatrixAt(i, _denseM);
      const dx = _denseM.elements[12] - playerPos.x;
      const dz = _denseM.elements[14] - playerPos.z;
      if (dx * dx + dz * dz <= DENSE_KEEP_R2) continue; // still near — keep
    } else if (!inField) {
      continue; // parked, and nowhere to put it
    }
    if (placeDense(i, playerPos.x, playerPos.z, inField)) changed = true;
  }

  if (changed) {
    denseMesh.instanceMatrix.clearUpdateRanges();
    denseMesh.instanceMatrix.addUpdateRange(start * 16, (end - start) * 16);
    denseMesh.instanceMatrix.needsUpdate = true;
    denseMesh.instanceColor.clearUpdateRanges();
    denseMesh.instanceColor.addUpdateRange(start * 3, (end - start) * 3);
    denseMesh.instanceColor.needsUpdate = true;
  }
  denseCursor = end >= DENSE_POOL ? 0 : end;
}
