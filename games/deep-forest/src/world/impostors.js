import * as THREE from 'three';
import { sunDirection, SUN_COLOR, impostorTint } from './atmosphere.js';

// Tree impostors (Phase 35, pulled forward): the frame is VERTEX-BOUND on
// tree geometry drawn across 4 passes — beyond ~170 m every tree becomes a
// single camera-facing quad sampling a pre-baked view atlas. 16 azimuths x
// 2 elevation rings per variant, baked ONCE at startup with the game's real
// (static) sun + hemisphere light, so the baked shading matches the live
// trees. Tone mapping stays correct for free: three.js skips tone mapping
// when rendering into a render target, and the composer's final pass tone
// maps the whole frame exactly once.

export const IMPOSTOR_DIST = 170; // cells beyond this swap to impostors

const AZ_FRAMES = 16; // 22.5 degree steps
const EL_RINGS = [THREE.MathUtils.degToRad(8), THREE.MathUtils.degToRad(45)];
const EL_SPLIT = 0.45; // view elevation (rad) where we jump to the high ring
const TILE = 128;

// Lit colors exceed 1.0 (sun intensity 5.5) but the atlas is 8-bit (half
// float mip generation is driver roulette) — store at 1/3, restore in the
// impostor shader.
const BAKE_SCALE = 1 / 3;

// Unit quad (+-0.5, pivot at center); the shader scales it to the tree's
// bounding sphere and billboards it about the canopy center.
const quadGeometry = new THREE.PlaneGeometry(1, 1);

// ---------------------------------------------------------------------------
// Bake one variant (its branches + leaves meshes) into a view atlas.
// Returns everything trees.js needs to build per-cell impostor meshes.
// ---------------------------------------------------------------------------
export function bakeTreeImpostor(renderer, branchesMesh, leavesMesh) {
  // Bounding sphere around the vertical trunk axis: center height from the
  // union bbox, radius = the farthest any vertex sits from that center.
  branchesMesh.geometry.computeBoundingBox();
  leavesMesh.geometry.computeBoundingBox();
  const bb = branchesMesh.geometry.boundingBox
    .clone()
    .union(leavesMesh.geometry.boundingBox);
  const centerY = (bb.min.y + bb.max.y) / 2;
  const center = new THREE.Vector3(0, centerY, 0);
  let radius = 0;
  for (const x of [bb.min.x, bb.max.x])
    for (const y of [bb.min.y, bb.max.y])
      for (const z of [bb.min.z, bb.max.z])
        radius = Math.max(radius, center.distanceTo(new THREE.Vector3(x, y, z)));

  // Isolated bake scene with the game's exact light rig (no fog, no
  // shadows), intensities pre-scaled by BAKE_SCALE so lit values fit the
  // 8-bit atlas; the impostor shader multiplies the sample back up.
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(SUN_COLOR, 5.5 * BAKE_SCALE);
  sun.position.copy(sunDirection).multiplyScalar(200);
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xa9c1b8, 0x36402e, 0.95 * BAKE_SCALE));
  scene.add(new THREE.Mesh(branchesMesh.geometry, branchesMesh.material));
  scene.add(new THREE.Mesh(leavesMesh.geometry, leavesMesh.material));

  const camera = new THREE.OrthographicCamera(
    -radius, radius, radius, -radius, 0.1, radius * 8
  );

  const target = new THREE.WebGLRenderTarget(AZ_FRAMES * TILE, EL_RINGS.length * TILE, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });

  // Save renderer state. Tiling goes through the TARGET's viewport/scissor
  // (re-applied by setRenderTarget) — renderer.setViewport would scale by
  // devicePixelRatio and corrupt the canvas viewport.
  const prevTarget = renderer.getRenderTarget();
  const prevClearColor = new THREE.Color();
  renderer.getClearColor(prevClearColor);
  const prevClearAlpha = renderer.getClearAlpha();

  // Mid-foliage green behind alpha-0 texels so mip downsampling bleeds
  // green at the cutout edges instead of black halos.
  renderer.setClearColor(0x42513a, 0);
  renderer.setRenderTarget(target);
  renderer.clear();
  target.scissorTest = true;

  for (let row = 0; row < EL_RINGS.length; row++) {
    const el = EL_RINGS[row];
    for (let a = 0; a < AZ_FRAMES; a++) {
      const az = (a / AZ_FRAMES) * Math.PI * 2;
      camera.position.set(
        Math.sin(az) * Math.cos(el),
        Math.sin(el),
        Math.cos(az) * Math.cos(el)
      ).multiplyScalar(radius * 4).add(center);
      camera.lookAt(center);
      camera.updateMatrixWorld();

      target.viewport.set(a * TILE, row * TILE, TILE, TILE);
      target.scissor.set(a * TILE, row * TILE, TILE, TILE);
      renderer.setRenderTarget(target); // re-applies viewport + scissor
      renderer.render(scene, camera);
    }
  }

  target.scissorTest = false;
  target.viewport.set(0, 0, AZ_FRAMES * TILE, EL_RINGS.length * TILE);
  target.scissor.set(0, 0, AZ_FRAMES * TILE, EL_RINGS.length * TILE);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);

  const material = buildImpostorMaterial(target.texture, radius, centerY);
  return { material, radius, centerY };
}

// ---------------------------------------------------------------------------
// Impostor material: Basic (lighting is baked) + spherical billboard +
// view-direction frame selection in the vertex stage.
// ---------------------------------------------------------------------------
function buildImpostorMaterial(atlas, radius, centerY) {
  const material = new THREE.MeshBasicMaterial({
    map: atlas,
    alphaTest: 0.3,
    fog: true,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    // Phase 28: the atlas bakes DAY lighting; this SHARED live color
    // (mutated by the timeOfDay curves) approximates current/baked light.
    shader.uniforms.uImpTint = { value: impostorTint };
    shader.defines = shader.defines || {};
    shader.defines.IMP_AZ = AZ_FRAMES.toFixed(1);
    shader.defines.IMP_RADIUS = radius.toFixed(4);
    shader.defines.IMP_CENTER_Y = centerY.toFixed(4);
    shader.defines.IMP_EL_SPLIT = EL_SPLIT.toFixed(4);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      /* glsl */ `
      // Instance pivot (trunk base) + uniform scale from the instance matrix.
      vec3 impPivot = instanceMatrix[3].xyz;
      float impScale = length(instanceMatrix[0].xyz);
      vec3 impCenter = impPivot + vec3(0.0, IMP_CENTER_Y * impScale, 0.0);

      vec3 impToCam = cameraPosition - impCenter;
      vec3 impFwd = normalize(impToCam);

      // Frame selection: nearest baked azimuth (instance yaw deliberately
      // IGNORED — every impostor shows the unrotated tree, which keeps the
      // baked sun direction consistent across the whole forest).
      float impAz = atan(impFwd.x, impFwd.z); // -pi..pi
      float impFrame = mod(
        floor(impAz / 6.2831853 * IMP_AZ + 0.5) + IMP_AZ, IMP_AZ
      );
      float impEl = asin(clamp(impFwd.y, -1.0, 1.0));
      float impRow = impEl > IMP_EL_SPLIT ? 1.0 : 0.0;

      vMapUv = vec2(
        (impFrame + uv.x) / IMP_AZ,
        (impRow + uv.y) / 2.0
      );
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      /* glsl */ `
      // Spherical billboard about the canopy center, sized to the baked
      // bounding sphere (the bake camera framed +-radius).
      vec3 impRight = normalize(cross(vec3(0.0, 1.0, 0.0), impFwd));
      vec3 impUp = cross(impFwd, impRight);
      vec3 impWorld = impCenter +
        (impRight * position.x + impUp * position.y) * (2.0 * IMP_RADIUS * impScale);
      vec4 mvPosition = viewMatrix * vec4(impWorld, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    // Restore the bake's 1/3 brightness scale + the live time-of-day tint.
    shader.fragmentShader = shader.fragmentShader.replace(
      'uniform vec3 diffuse;',
      'uniform vec3 diffuse;\nuniform vec3 uImpTint;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #include <map_fragment>
      diffuseColor.rgb *= ${(1 / BAKE_SCALE).toFixed(1)} * uImpTint;
      `
    );
  };

  return material;
}

// Shared unit quad for all impostor InstancedMeshes.
export function getImpostorQuad() {
  return quadGeometry;
}
