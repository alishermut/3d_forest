// ===========================================================================
// Fluid scene SPIKE — standalone WebGPU MLS-MPM particle water.
//
// Purpose: de-risk the second scene BEFORE touching main.js. It proves
//   (1) WebGPURenderer boots on this machine,
//   (2) the MLS-MPM compute sim runs, and
//   (3) what FPS we get at what particle count on THIS GPU.
//
// The simulation core (buffers, uniforms, the five compute kernels, the
// indirect-dispatch workgroup trick) is the official three.js r184 example
// `webgpu_compute_particles_fluid` kept VERBATIM — it's correct and tuned,
// and copying it faithfully is the point of a spike. Only the shell is ours:
// procedural RoomEnvironment lighting (no external HDR asset), a WebGPU
// capability gate, and an FPS / live particle-count HUD.
//
// Throwaway: nothing here is imported by the game. Delete src/spike + the two
// _ files once we commit to the architecture.
// ===========================================================================

import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, instancedArray, instanceIndex, uniform, attribute, float,
  clamp, struct, atomicStore, int, ivec3, array, vec3, atomicAdd, Loop,
  atomicLoad, max, pow, mat3, vec4, cross, step, storage,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// --- HUD elements -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const fpsEl = $('fps'), msEl = $('ms'), pcountEl = $('pcount'),
  gpuEl = $('gpu'), sliderEl = $('pslider');

// Show a real, readable reason on screen instead of a silent black canvas.
// navigator.gpu can EXIST while no usable adapter is behind it (driver
// blocklist, headless, disabled flag) — that's the classic "black screen"
// trap, so we surface whatever actually went wrong.
function showError(title, detail) {
  const fb = $('fallback');
  fb.querySelector('h1').textContent = title;
  fb.querySelector('p').innerHTML =
    (detail ? '<span style="color:#ff9a9a">' + detail + '</span><br><br>' : '') +
    'WebGPU works in current <b>Chrome</b> or <b>Edge</b> on a supported GPU.<br>' +
    'Check <code>chrome://gpu</code> (look for "WebGPU: Hardware accelerated").<br>' +
    '<span style="opacity:.5">The forest scene (<code>index.html</code>) runs on WebGL and is unaffected.</span>';
  fb.style.display = 'flex';
  $('hud').style.display = 'none';
}
window.addEventListener('error', (e) => showError('Fluid spike crashed', String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => showError('Fluid spike failed to start', String(e.reason?.message || e.reason)));

let renderer, scene, camera, controls;

const timer = new THREE.Timer();
timer.connect(document);

const maxParticles = 8192 * 16; // 131072
const gridSize1d = 64;
const workgroupSize = 64;
const gridSize = new THREE.Vector3(gridSize1d, gridSize1d, gridSize1d);
const fixedPointMultiplier = 1e7;

let particleCountUniform, stiffnessUniform, restDensityUniform,
  dynamicViscosityUniform, dtUniform, gravityUniform, gridSizeUniform;
let particleBuffer, cellBuffer, cellBufferFloat;
let clearGridKernel, p2g1Kernel, p2g2Kernel, updateGridKernel, g2pKernel, workgroupKernel;
let p2g1KernelWorkgroupBuffer, p2g2KernelWorkgroupBuffer, g2pKernelWorkgroupBuffer;
let particleMesh;
const mouseCoord = new THREE.Vector3();
const prevMouseCoord = new THREE.Vector3();
let mouseRayOriginUniform, mouseRayDirectionUniform, mouseForceUniform;

const params = {
  particleCount: 8192 * 4, // 32768
};

init();

async function init() {
  // Real capability probe: requestAdapter() returning null is the actual
  // "no WebGPU" case (navigator.gpu existing is not enough).
  if (!navigator.gpu) { showError('WebGPU not available', 'navigator.gpu is undefined in this browser.'); return; }
  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (e) {
    showError('WebGPU adapter request failed', String(e?.message || e)); return;
  }
  if (!adapter) { showError('No WebGPU GPU adapter', 'navigator.gpu exists but requestAdapter() returned null (GPU blocklisted, disabled, or headless).'); return; }

  // The particle mesh reads positions from a storage buffer in the VERTEX
  // stage — needs maxStorageBuffersInVertexStage >= 1. Only request it if the
  // adapter actually supports it, so an unsupported limit can't fail device
  // creation (which would black-screen).
  const requiredLimits = {};
  if ((adapter.limits.maxStorageBuffersInVertexStage ?? 0) >= 1) {
    requiredLimits.maxStorageBuffersInVertexStage = 1;
  }

  renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  document.body.appendChild(renderer.domElement);

  try {
    await renderer.init();
  } catch (e) {
    showError('WebGPU renderer init failed', String(e?.message || e)); return;
  }
  reportGPU();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d12);

  // Procedural studio environment for reflections on the water spheres —
  // replaces the example's external UltraHDR file so the spike needs no asset.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 10);
  camera.position.set(-1.3, 1.3, -1.3);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 1;
  controls.maxDistance = 3;
  controls.maxPolarAngle = Math.PI * 0.35;
  controls.touches = { TWO: THREE.TOUCH.DOLLY_ROTATE };

  setupParticles();
  setupHud();

  const numWorkgroups = Math.ceil(params.particleCount / workgroupSize);
  p2g1KernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
  p2g2KernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);
  g2pKernelWorkgroupBuffer = new THREE.IndirectStorageBufferAttribute(new Uint32Array([numWorkgroups, 1, 1]), 1);

  const p2g1WorkgroupStorage = storage(p2g1KernelWorkgroupBuffer, 'uint', 3);
  const p2g2WorkgroupStorage = storage(p2g2KernelWorkgroupBuffer, 'uint', 3);
  const g2pWorkgroupStorage = storage(g2pKernelWorkgroupBuffer, 'uint', 3);

  workgroupKernel = Fn(() => {
    const workgroupsToDispatch = particleCountUniform.sub(1).div(workgroupSize).add(1);
    p2g1WorkgroupStorage.element(0).assign(workgroupsToDispatch);
    p2g2WorkgroupStorage.element(0).assign(workgroupsToDispatch);
    g2pWorkgroupStorage.element(0).assign(workgroupsToDispatch);
  })().compute(1);

  window.addEventListener('resize', onWindowResize);
  controls.update();
  renderer.setAnimationLoop(render);

  // Spike-only: lets headless verification pump frames by hand when the
  // preview tab is backgrounded (requestAnimationFrame is throttled to 0 Hz
  // while hidden). Harmless; removed when this spike is deleted.
  window.__fluid = { renderer, scene, camera, step: render };
}

function setupBuffers() {
  const particleStruct = struct({
    position: { type: 'vec3' },
    velocity: { type: 'vec3' },
    C: { type: 'mat3' },
  });
  const particleStructSize = 20; // vec3 -> 4 floats, mat3 -> 12 floats (webgpu alignment)
  const particleArray = new Float32Array(maxParticles * particleStructSize);
  for (let i = 0; i < maxParticles; i++) {
    particleArray[i * particleStructSize] = Math.random() * 0.8 + 0.1;
    particleArray[i * particleStructSize + 1] = Math.random() * 0.8 + 0.1;
    particleArray[i * particleStructSize + 2] = Math.random() * 0.8 + 0.1;
  }
  particleBuffer = instancedArray(particleArray, particleStruct);

  const cellCount = gridSize.x * gridSize.y * gridSize.z;
  const cellStruct = struct({
    x: { type: 'int', atomic: true },
    y: { type: 'int', atomic: true },
    z: { type: 'int', atomic: true },
    mass: { type: 'int', atomic: true },
  });
  cellBuffer = instancedArray(cellCount, cellStruct);
  cellBufferFloat = instancedArray(cellCount, 'vec4');
}

function setupUniforms() {
  gridSizeUniform = uniform(gridSize);
  particleCountUniform = uniform(params.particleCount, 'uint');
  stiffnessUniform = uniform(50);
  restDensityUniform = uniform(1.5);
  dynamicViscosityUniform = uniform(0.1);
  dtUniform = uniform(1 / 60);
  gravityUniform = uniform(new THREE.Vector3(0, -(9.81 * 9.81), 0));
  mouseRayOriginUniform = uniform(new THREE.Vector3(0, 0, 0));
  mouseRayDirectionUniform = uniform(new THREE.Vector3(0, 0, 0));
  mouseForceUniform = uniform(new THREE.Vector3(0, 0, 0));
}

function setupComputeShaders() {
  // MLS-MPM: clearGrid -> p2g1 -> p2g2 -> updateGrid -> g2p. WebGPU only has
  // int atomics, so float accumulation uses fixed point (x1e7). Follows
  // https://github.com/matsuoka-601/WebGPU-Ocean
  const encodeFixedPoint = (f32) => int(f32.mul(fixedPointMultiplier));
  const decodeFixedPoint = (i32) => float(i32).div(fixedPointMultiplier);

  const cellCount = gridSize.x * gridSize.y * gridSize.z;
  clearGridKernel = Fn(() => {
    atomicStore(cellBuffer.element(instanceIndex).get('x'), 0);
    atomicStore(cellBuffer.element(instanceIndex).get('y'), 0);
    atomicStore(cellBuffer.element(instanceIndex).get('z'), 0);
    atomicStore(cellBuffer.element(instanceIndex).get('mass'), 0);
  })().compute(cellCount).setName('clearGridKernel');

  p2g1Kernel = Fn(() => {
    const particlePosition = particleBuffer.element(instanceIndex).get('position').toConst('particlePosition');
    const particleVelocity = particleBuffer.element(instanceIndex).get('velocity').toConst('particleVelocity');
    const C = particleBuffer.element(instanceIndex).get('C').toConst('C');

    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
    const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
    const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');
    const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst('weights');

    Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
          const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
          const Q = C.mul(cellDist);
          const massContrib = weight; // particle mass = 1.0
          const velContrib = massContrib.mul(particleVelocity.add(Q)).toConst('velContrib');
          const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
          const cell = cellBuffer.element(cellPtr);
          atomicAdd(cell.get('x'), encodeFixedPoint(velContrib.x));
          atomicAdd(cell.get('y'), encodeFixedPoint(velContrib.y));
          atomicAdd(cell.get('z'), encodeFixedPoint(velContrib.z));
          atomicAdd(cell.get('mass'), encodeFixedPoint(massContrib));
        });
      });
    });
  })().compute(params.particleCount, [workgroupSize, 1, 1]).setName('p2g1Kernel');

  p2g2Kernel = Fn(() => {
    const particlePosition = particleBuffer.element(instanceIndex).get('position').toConst('particlePosition');
    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
    const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
    const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');
    const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst('weights');

    const density = float(0).toVar('density');
    Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
          const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
          const cell = cellBuffer.element(cellPtr);
          const mass = decodeFixedPoint(atomicLoad(cell.get('mass')));
          density.addAssign(mass.mul(weight));
        });
      });
    });

    const volume = float(1).div(density);
    const pressure = max(0.0, pow(density.div(restDensityUniform), 5.0).sub(1).mul(stiffnessUniform)).toConst('pressure');
    const stress = mat3(pressure.negate(), 0, 0, 0, pressure.negate(), 0, 0, 0, pressure.negate()).toVar('stress');
    const dudv = particleBuffer.element(instanceIndex).get('C').toConst('C');
    const strain = dudv.add(dudv.transpose());
    stress.addAssign(strain.mul(dynamicViscosityUniform));
    const eq16Term0 = volume.mul(-4).mul(stress).mul(dtUniform);

    Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
          const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
          const momentum = eq16Term0.mul(weight).mul(cellDist).toConst('momentum');
          const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
          const cell = cellBuffer.element(cellPtr);
          atomicAdd(cell.get('x'), encodeFixedPoint(momentum.x));
          atomicAdd(cell.get('y'), encodeFixedPoint(momentum.y));
          atomicAdd(cell.get('z'), encodeFixedPoint(momentum.z));
        });
      });
    });
  })().compute(params.particleCount, [workgroupSize, 1, 1]).setName('p2g2Kernel');

  updateGridKernel = Fn(() => {
    const cell = cellBuffer.element(instanceIndex);
    const mass = decodeFixedPoint(atomicLoad(cell.get('mass'))).toConst();
    If(mass.lessThanEqual(0), () => { Return(); });

    const vx = decodeFixedPoint(atomicLoad(cell.get('x'))).div(mass).toVar();
    const vy = decodeFixedPoint(atomicLoad(cell.get('y'))).div(mass).toVar();
    const vz = decodeFixedPoint(atomicLoad(cell.get('z'))).div(mass).toVar();

    const x = int(instanceIndex).div(int(gridSize.z * gridSize.y));
    const y = int(instanceIndex).div(int(gridSize.z)).mod(int(gridSize.y));
    const z = int(instanceIndex).mod(int(gridSize.z));
    If(x.lessThan(int(1)).or(x.greaterThan(int(gridSize.x).sub(int(2)))), () => { vx.assign(0); });
    If(y.lessThan(int(1)).or(y.greaterThan(int(gridSize.y).sub(int(2)))), () => { vy.assign(0); });
    If(z.lessThan(int(1)).or(z.greaterThan(int(gridSize.z).sub(int(2)))), () => { vz.assign(0); });

    cellBufferFloat.element(instanceIndex).assign(vec4(vx, vy, vz, mass));
  })().compute(cellCount).setName('updateGridKernel');

  const clampToRoundedBox = (pos, box, radius) => {
    const result = pos.sub(0.5).toVar();
    const pp = step(box, result.abs()).mul(result.add(box.negate().mul(result.sign())));
    const ppLen = pp.length().toVar();
    const dist = ppLen.sub(radius);
    If(dist.greaterThan(0.0), () => {
      result.subAssign(pp.normalize().mul(dist).mul(1.3));
    });
    result.addAssign(0.5);
    return result;
  };

  g2pKernel = Fn(() => {
    const particlePosition = particleBuffer.element(instanceIndex).get('position').toVar('particlePosition');
    const gridPosition = particlePosition.mul(gridSizeUniform).toVar();
    const particleVelocity = vec3(0).toVar();

    const cellIndex = ivec3(gridPosition).sub(1).toConst('cellIndex');
    const cellDiff = gridPosition.fract().sub(0.5).toConst('cellDiff');
    const w0 = float(0.5).mul(float(0.5).sub(cellDiff)).mul(float(0.5).sub(cellDiff));
    const w1 = float(0.75).sub(cellDiff.mul(cellDiff));
    const w2 = float(0.5).mul(float(0.5).add(cellDiff)).mul(float(0.5).add(cellDiff));
    const weights = array([w0, w1, w2]).toConst('weights');

    const B = mat3(0).toVar('B');
    Loop({ start: 0, end: 3, type: 'int', name: 'gx', condition: '<' }, ({ gx }) => {
      Loop({ start: 0, end: 3, type: 'int', name: 'gy', condition: '<' }, ({ gy }) => {
        Loop({ start: 0, end: 3, type: 'int', name: 'gz', condition: '<' }, ({ gz }) => {
          const weight = weights.element(gx).x.mul(weights.element(gy).y).mul(weights.element(gz).z);
          const cellX = cellIndex.add(ivec3(gx, gy, gz)).toConst();
          const cellDist = vec3(cellX).add(0.5).sub(gridPosition).toConst('cellDist');
          const cellPtr = cellX.x.mul(int(gridSize.y * gridSize.z)).add(cellX.y.mul(int(gridSize.z))).add(cellX.z).toConst();
          const weightedVelocity = cellBufferFloat.element(cellPtr).xyz.mul(weight).toConst('weightedVelocity');
          const term = mat3(
            weightedVelocity.mul(cellDist.x),
            weightedVelocity.mul(cellDist.y),
            weightedVelocity.mul(cellDist.z),
          );
          B.addAssign(term);
          particleVelocity.addAssign(weightedVelocity);
        });
      });
    });

    particleBuffer.element(instanceIndex).get('C').assign(B.mul(4));
    particleVelocity.addAssign(gravityUniform.mul(dtUniform)); // gravity
    particleVelocity.divAssign(gridSizeUniform); // scale grid -> unit

    // mouse interaction
    const dist = cross(mouseRayDirectionUniform, particlePosition.sub(mouseRayOriginUniform)).length();
    const force = dist.mul(3.0).oneMinus().max(0.0).pow(2);
    particleVelocity.addAssign(mouseForceUniform.mul(force));

    particlePosition.addAssign(particleVelocity.mul(dtUniform));
    particlePosition.assign(clamp(particlePosition, vec3(1).div(gridSizeUniform), vec3(gridSize).sub(1).div(gridSizeUniform)));

    // keep particles inside a rounded box
    const innerBox = gridSizeUniform.mul(0.5).sub(9.0).div(gridSizeUniform).toVar();
    const innerRadius = float(6.0).div(gridSizeUniform.x);
    const posNext = particlePosition.add(particleVelocity.mul(dtUniform).mul(2.0)).toConst('posNext');
    const posNextClamped = clampToRoundedBox(posNext, innerBox, innerRadius);
    particleVelocity.addAssign(posNextClamped.sub(posNext));

    particleVelocity.mulAssign(gridSizeUniform); // scale unit -> grid

    particleBuffer.element(instanceIndex).get('position').assign(particlePosition);
    particleBuffer.element(instanceIndex).get('velocity').assign(particleVelocity);
  })().compute(params.particleCount, [workgroupSize, 1, 1]).setName('g2pKernel');
}

function setupMesh() {
  const geometry = BufferGeometryUtils.mergeVertices(
    new THREE.IcosahedronGeometry(0.008, 1).deleteAttribute('uv'),
  );
  const material = new THREE.MeshStandardNodeMaterial({ color: '#0066FF', metalness: 0.0, roughness: 0.25 });
  material.positionNode = Fn(() => {
    const particlePosition = particleBuffer.element(instanceIndex).get('position');
    return attribute('position').add(particlePosition);
  })();
  particleMesh = new THREE.Mesh(geometry, material);
  particleMesh.count = params.particleCount;
  particleMesh.position.set(-0.5, 0, -0.5);
  particleMesh.frustumCulled = false;
  scene.add(particleMesh);
}

function setupMouse() {
  const raycaster = new THREE.Raycaster();
  const raycastPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0));
  const onMove = (event) => {
    const pointer = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    raycaster.ray.origin.x += 0.5;
    raycaster.ray.origin.z += 0.5;
    mouseRayOriginUniform.value.copy(raycaster.ray.origin);
    mouseRayDirectionUniform.value.copy(raycaster.ray.direction);
    raycaster.ray.intersectPlane(raycastPlane, mouseCoord);
  };
  renderer.domElement.addEventListener('pointermove', onMove);
}

function setupParticles() {
  setupBuffers();
  setupUniforms();
  setupComputeShaders();
  setupMesh();
  setupMouse();
}

// --- HUD: FPS + live particle-count slider ---------------------------------
let frames = 0, accum = 0, lastMs = 0;
function setupHud() {
  sliderEl.min = 4096;
  sliderEl.max = maxParticles;
  sliderEl.step = 4096;
  sliderEl.value = params.particleCount;
  pcountEl.textContent = params.particleCount.toLocaleString();
  sliderEl.addEventListener('input', () => {
    const v = parseInt(sliderEl.value, 10);
    params.particleCount = v;
    particleMesh.count = v;
    p2g1Kernel.count = v;
    p2g2Kernel.count = v;
    g2pKernel.count = v;
    particleCountUniform.value = v;
    pcountEl.textContent = v.toLocaleString();
  });
}

function reportGPU() {
  try {
    const info = renderer.backend?.adapter?.info;
    const name = info && (info.description || info.vendor || info.architecture);
    gpuEl.textContent = name || 'WebGPU';
    gpuEl.title = name || '';
  } catch {
    gpuEl.textContent = 'WebGPU';
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function render() {
  timer.update();
  const deltaTime = THREE.MathUtils.clamp(timer.getDelta(), 0.00001, 1 / 60);
  dtUniform.value = deltaTime;

  mouseForceUniform.value.copy(mouseCoord).sub(prevMouseCoord).multiplyScalar(2);
  const mouseForceLength = mouseForceUniform.value.length();
  if (mouseForceLength > 0.3) mouseForceUniform.value.multiplyScalar(0.3 / mouseForceLength);
  prevMouseCoord.copy(mouseCoord);

  renderer.compute(workgroupKernel);
  renderer.compute(clearGridKernel);
  renderer.compute(p2g1Kernel, p2g1KernelWorkgroupBuffer);
  renderer.compute(p2g2Kernel, p2g2KernelWorkgroupBuffer);
  renderer.compute(updateGridKernel);
  renderer.compute(g2pKernel, g2pKernelWorkgroupBuffer);

  renderer.render(scene, camera);

  // FPS HUD (rolling, updated ~4x/sec).
  const now = performance.now();
  if (lastMs) { accum += now - lastMs; frames++; }
  lastMs = now;
  if (accum >= 250) {
    const avg = accum / frames;
    fpsEl.textContent = String(Math.round(1000 / avg));
    msEl.textContent = avg.toFixed(1) + ' ms';
    accum = 0; frames = 0;
  }
}
