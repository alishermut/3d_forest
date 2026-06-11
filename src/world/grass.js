import * as THREE from 'three';
import {
  getHeight,
  getTint,
  getSlope,
  getLakeDistance,
  getRiverDistance,
  WORLD_RADIUS,
} from './terrain.js';
import { WATER_EXCLUDED_LAYER } from './water.js';

// Dense blade field like reference screenshot 1: thin tapered blades, dark
// at the root and bright yellow-green at the tip, swaying in wind, patchy so
// bare dirt shows through where the terrain tint is "earthy".
//
// The field lives in a ~RADIUS circle that follows the player: each frame a
// contiguous block of instances is checked, and blades left too far behind
// are relocated near the player. Contiguous blocks keep the GPU re-upload
// to one small updateRange per frame, and the fog hides the swaps.

const COUNT = 260000;
const RADIUS = 70;            // grass lives within this distance of the player
const BLADES_PER_FRAME = 6000; // relocation scan block size
const BLADE_HEIGHT = 0.5;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(31337);

let grassMesh = null;
let grassMaterial = null;
let scanCursor = 0;
const dummy = new THREE.Object3D();
const color = new THREE.Color();

// Pick a spot near (cx, cz) that the density mask accepts; lush where the
// terrain tint is high (mossy), bare where it's earthy — grass and ground
// agree because both read getTint.
function pickSpot(cx, cz) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * RADIUS;
    const x = cx + Math.cos(ang) * rad;
    const z = cz + Math.sin(ang) * rad;
    if (x * x + z * z > WORLD_RADIUS * WORLD_RADIUS) continue;

    // Terrain v2 masks: grass grows right down to just above the waterline
    // (reeds-at-the-shore look), but not underwater, in the river, on
    // cliffs, or high on the mountains.
    if (getRiverDistance(x, z).d < 9) continue;
    const h = getHeight(x, z);
    if (h < -1.2 || h > 14 || getSlope(x, z) > 0.7) continue; // Phase 17 treeline

    const density = THREE.MathUtils.smoothstep(getTint(x, z), 0.42, 0.72);
    if (rng() < density * 0.95 + 0.02) return { x, z };
  }
  return null;
}

function placeBlade(i, cx, cz) {
  const spot = pickSpot(cx, cz);
  if (!spot) {
    // Nothing accepted nearby (deep dirt patch) — park the blade underground.
    dummy.position.set(cx, -50, cz);
    dummy.scale.setScalar(0.001);
    dummy.updateMatrix();
    grassMesh.setMatrixAt(i, dummy.matrix);
    return;
  }

  const groundY = getHeight(spot.x, spot.z);
  dummy.position.set(spot.x, groundY - 0.02, spot.z);
  dummy.rotation.set(
    (rng() - 0.5) * 0.3,
    rng() * Math.PI * 2,
    (rng() - 0.5) * 0.3
  );
  // Reeds: blades in the wet shore band grow noticeably taller.
  const reedBoost = groundY < -0.55 ? 1.6 : 1.0;
  const h = BLADE_HEIGHT * (0.55 + rng() * 0.8) * reedBoost;
  dummy.scale.set(0.85 + rng() * 0.4, h, 1);
  dummy.updateMatrix();
  grassMesh.setMatrixAt(i, dummy.matrix);

  color.setHSL(
    0.22 + rng() * 0.07,
    0.5 + rng() * 0.25,
    0.4 + rng() * 0.2
  );
  grassMesh.setColorAt(i, color);
}

export function createGrass(scene, origin = { x: 0, z: 8 }) {
  // --- Blade: base quad + tip triangle (5 verts, 3 tris), thin, curved.
  const w = 0.018; // half-width at the base (~3.6 cm full width)
  const positions = new Float32Array([
    -w, 0, 0,
    w, 0, 0,
    -w * 0.5, 0.55, 0.05,
    w * 0.5, 0.55, 0.05,
    0, 1.0, 0.16,
  ]);
  const normals = new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);

  grassMaterial = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  patchGrassMaterial(grassMaterial);

  grassMesh = new THREE.InstancedMesh(geometry, grassMaterial, COUNT);
  grassMesh.receiveShadow = true;
  grassMesh.castShadow = false;
  grassMesh.frustumCulled = false;
  // 260k blades are pure waste in the water refraction/reflection renders;
  // this layer is skipped there (main camera enables it — see main.js).
  grassMesh.layers.set(WATER_EXCLUDED_LAYER);
  grassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  for (let i = 0; i < COUNT; i++) placeBlade(i, origin.x, origin.z);
  grassMesh.instanceMatrix.needsUpdate = true;
  grassMesh.instanceColor.needsUpdate = true;

  scene.add(grassMesh);
  return grassMesh;
}

export function updateGrass(elapsedTime, playerPos) {
  const shader = grassMaterial?.userData.shader;
  if (shader) shader.uniforms.uTime.value = elapsedTime;
  if (!playerPos || !grassMesh) return;

  // Scan one contiguous block per frame; relocate blades that fell behind.
  const start = scanCursor;
  const end = Math.min(start + BLADES_PER_FRAME, COUNT);
  const m = new THREE.Matrix4();
  let relocated = 0;

  for (let i = start; i < end; i++) {
    grassMesh.getMatrixAt(i, m);
    const dx = m.elements[12] - playerPos.x;
    const dz = m.elements[14] - playerPos.z;
    if (dx * dx + dz * dz > RADIUS * RADIUS * 1.1) {
      placeBlade(i, playerPos.x, playerPos.z);
      relocated++;
    }
  }

  if (relocated > 0) {
    const ranges = [{ start: start * 16, count: (end - start) * 16 }];
    grassMesh.instanceMatrix.clearUpdateRanges();
    grassMesh.instanceMatrix.addUpdateRange(ranges[0].start, ranges[0].count);
    grassMesh.instanceMatrix.needsUpdate = true;
    grassMesh.instanceColor.clearUpdateRanges();
    grassMesh.instanceColor.addUpdateRange(start * 3, (end - start) * 3);
    grassMesh.instanceColor.needsUpdate = true;
  }

  scanCursor = end >= COUNT ? 0 : end;
}

// Lambert keeps shadows/fog/hemisphere for free; we inject instancing-aware
// wind sway in the vertex stage, force the lighting normal to world-up (so
// backfaces aren't black), and add the root->tip gradient in the fragment.
function patchGrassMaterial(mat) {
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
      vBladeY = position.y; // 0 at root, 1 at tip (pre-transform)
      vUpViewNormal = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));

      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif

      // Tip sways, root stays planted. Phase drifts across the field so the
      // wind reads as gusts rolling through, not a uniform metronome.
      float phase = mvPosition.x * 0.8 + mvPosition.z * 0.7;
      float sway = position.y * position.y * (
        0.06 * sin(uTime * 1.4 + phase) +
        0.03 * sin(uTime * 3.1 + phase * 1.7)
      );
      mvPosition.x += sway;
      mvPosition.z += sway * 0.6;

      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    shader.fragmentShader =
      `
      varying float vBladeY;
      varying vec3 vUpViewNormal;
      ` + shader.fragmentShader;

    // Light every fragment as if it were the ground plane: no black
    // backfaces, and the field blends into the terrain lighting.
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
      // Root->tip gradient: dark earthy base to bright sunlit tip.
      diffuseColor.rgb *= mix(
        vec3(0.30, 0.36, 0.22),
        vec3(1.08, 1.12, 0.92),
        pow(clamp(vBladeY, 0.0, 1.0), 1.35)
      );
      `
    );

    mat.userData.shader = shader;
  };
}
