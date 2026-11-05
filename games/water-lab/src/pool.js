// ===========================================================================
// Pool water SPIKE — WebGL, the Evan Wallace "webgl-water" approach,
// reimplemented from technique (not copied) in Three.js.
//
// Pieces, in render order each frame:
//   1. SIM    — height-field wave equation, ping-pong RG float texture
//               (R = height, G = velocity). Click/drag injects drops.
//   2. NORMAL — derive surface normals from the height field into a texture
//               (used by BOTH the caustics pass and the water surface).
//   3. CAUSTIC— render the water grid into a floor-space texture: each cell's
//               triangle is drawn where its REFRACTED sun ray lands on the
//               floor, brightness = area compression (old/new). This is the
//               dancing light pattern.
//   4. SCENE  — tiled pool (floor+walls, floor lit by the caustic texture) +
//               the water surface (per-pixel refraction of the floor/walls,
//               sky reflection, Fresnel, sun glint).
//
// Pure WebGL2 (your existing renderer family). Throwaway spike.
// ===========================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);

// Pool occupies x,z in [-1,1]; floor at y=-1, water surface at y=0.
const SIM_RES = 256;
const CAUSTIC_RES = 512;
const GRID_SEG = 200;          // tessellation of the water + caustic grids
const IOR = 1.0 / 1.33;
const LIGHT_DIR = new THREE.Vector3(-0.2, -1.0, -0.25).normalize(); // sun into pool

const SUN_DIR = new THREE.Vector3(0.2, 1.0, 0.25).normalize();      // up toward sun
const SUN_COLOR = new THREE.Color(1.0, 0.95, 0.82);
const HORIZON = new THREE.Color(0.78, 0.86, 0.92);
const ZENITH = new THREE.Color(0.20, 0.46, 0.74);
const WATER_TINT = new THREE.Color(0.10, 0.34, 0.42);

let renderer, scene, camera, controls, clock;
let simA, simB, simUpdateMat, dropMat, normalRT, normalMat, fsQuad, fsScene, fsCam;
let causticRT, causticScene, causticCam, causticGrid;
let waterMat, tileTex;

const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 dir){
    dir = normalize(dir);
    float h = smoothstep(-0.1, 0.6, dir.y);
    vec3 sky = mix(uHorizon, uZenith, clamp(h,0.0,1.0));
    float s = max(dot(dir, uSunDir), 0.0);
    sky += uSunColor * pow(s, 800.0) * 2.0;
    sky += uSunColor * pow(s, 6.0) * 0.25;
    return sky;
  }
`;

// ---------------------------------------------------------------------------
// Tiled pool texture (procedural — no asset needed).
// ---------------------------------------------------------------------------
function makeTileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const tiles = 6, s = 512 / tiles;
  for (let j = 0; j < tiles; j++) {
    for (let i = 0; i < tiles; i++) {
      const v = 206 + ((Math.sin(i * 12.9 + j * 78.2) * 0.5 + 0.5) * 24 | 0);
      x.fillStyle = `rgb(${v - 55}, ${v - 18}, ${v})`;
      x.fillRect(i * s, j * s, s, s);
    }
  }
  x.strokeStyle = 'rgba(30, 55, 80, 0.55)';
  x.lineWidth = 5;
  for (let i = 0; i <= tiles; i++) {
    x.beginPath(); x.moveTo(i * s, 0); x.lineTo(i * s, 512); x.stroke();
    x.beginPath(); x.moveTo(0, i * s); x.lineTo(512, i * s); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------
// Simulation (ping-pong)
// ---------------------------------------------------------------------------
function makeRT(res) {
  return new THREE.WebGLRenderTarget(res, res, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  });
}

function initSim() {
  simA = makeRT(SIM_RES);
  simB = makeRT(SIM_RES);
  normalRT = makeRT(SIM_RES);

  const quadVert = /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  // Wave equation: velocity accelerates toward the neighbor average; integrate.
  simUpdateMat = new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uTexel: { value: 1 / SIM_RES } },
    vertexShader: quadVert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; uniform sampler2D uState; uniform float uTexel;
      void main(){
        vec2 d = vec2(uTexel, 0.0);
        vec2 st = texture2D(uState, vUv).rg;   // r=height, g=velocity
        float h = st.r, v = st.g;
        float hl = texture2D(uState, vUv - d.xy).r;
        float hr = texture2D(uState, vUv + d.xy).r;
        float hd = texture2D(uState, vUv - d.yx).r;
        float hu = texture2D(uState, vUv + d.yx).r;
        float avg = (hl + hr + hd + hu) * 0.25;
        v += (avg - h) * 1.4;     // wave stiffness
        v *= 0.992;               // damping
        h += v;
        vec2 e = min(vUv, 1.0 - vUv);
        h *= smoothstep(0.0, 0.015, min(e.x, e.y)); // settle at walls
        gl_FragColor = vec4(h, v, 0.0, 1.0);
      }
    `,
  });

  // Additive drop (cosine bump) injected at a uv.
  dropMat = new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: null },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uRadius: { value: 0.03 },
      uStrength: { value: 0.5 },
    },
    vertexShader: quadVert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; uniform sampler2D uState;
      uniform vec2 uCenter; uniform float uRadius, uStrength;
      void main(){
        vec4 s = texture2D(uState, vUv);
        float d = length(vUv - uCenter);
        float drop = max(0.0, 1.0 - d / uRadius);
        drop = 0.5 - cos(drop * 3.14159265) * 0.5;
        s.r += uStrength * drop;
        gl_FragColor = s;
      }
    `,
  });

  // Normal from height central differences.
  normalMat = new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uTexel: { value: 1 / SIM_RES } },
    vertexShader: quadVert,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; uniform sampler2D uState; uniform float uTexel;
      void main(){
        vec2 d = vec2(uTexel, 0.0);
        float hl = texture2D(uState, vUv - d.xy).r;
        float hr = texture2D(uState, vUv + d.xy).r;
        float hd = texture2D(uState, vUv - d.yx).r;
        float hu = texture2D(uState, vUv + d.yx).r;
        float dx = 2.0 * uTexel; // world units per texel (pool spans 2)
        vec3 n = normalize(vec3(-(hr - hl) / (2.0 * dx), 1.0, -(hu - hd) / (2.0 * dx)));
        gl_FragColor = vec4(n, 1.0);
      }
    `,
  });

  fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simUpdateMat);
  fsScene = new THREE.Scene();
  fsScene.add(fsQuad);
  fsCam = new THREE.Camera();

  // clear to zero
  const clear = new THREE.MeshBasicMaterial({ color: 0x000000 });
  fsQuad.material = clear;
  for (const rt of [simA, simB, normalRT]) { renderer.setRenderTarget(rt); renderer.render(fsScene, fsCam); }
  renderer.setRenderTarget(null);
}

function runPass(mat, target, srcTexture) {
  fsQuad.material = mat;
  if (srcTexture !== undefined) mat.uniforms.uState.value = srcTexture;
  renderer.setRenderTarget(target);
  renderer.render(fsScene, fsCam);
  renderer.setRenderTarget(null);
}

const _dropQueue = [];
function stepSim() {
  // drops first (each reads simA -> writes simB -> swap)
  while (_dropQueue.length) {
    const dr = _dropQueue.shift();
    dropMat.uniforms.uCenter.value.set(dr.x, dr.y);
    dropMat.uniforms.uStrength.value = dr.s;
    dropMat.uniforms.uRadius.value = dr.r;
    runPass(dropMat, simB, simA.texture);
    [simA, simB] = [simB, simA];
  }
  // wave update
  runPass(simUpdateMat, simB, simA.texture);
  [simA, simB] = [simB, simA];
  // normals
  runPass(normalMat, normalRT, simA.texture);
}

// ---------------------------------------------------------------------------
// Caustics — render water grid into floor-space; brightness = area compression
// ---------------------------------------------------------------------------
function initCaustics() {
  causticRT = makeRT(CAUSTIC_RES);
  causticScene = new THREE.Scene();
  causticCam = new THREE.Camera(); // we output clip coords directly

  const geo = new THREE.PlaneGeometry(2, 2, GRID_SEG, GRID_SEG);
  geo.rotateX(-Math.PI / 2); // into xz plane, uv preserved

  const mat = new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    uniforms: {
      uSim: { value: null },
      uNormal: { value: null },
      uLightDir: { value: LIGHT_DIR },
    },
    vertexShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uSim, uNormal;
      uniform vec3 uLightDir;
      varying vec3 vOld;
      varying vec3 vNew;
      void main(){
        // position.xz in [-1,1]; uv in [0,1]
        float h = texture2D(uSim, uv).r;
        vec3 n = texture2D(uNormal, uv).xyz;
        vec3 surf = vec3(position.x, h, position.z);
        vec3 refr = refract(uLightDir, n, ${IOR.toFixed(5)});
        // where the refracted ray hits the floor (y = -1)
        float t = (-1.0 - surf.y) / refr.y;
        vec3 land = surf + refr * t;
        vOld = vec3(position.x, position.z, 0.0);
        vNew = vec3(land.x, land.z, 0.0);
        gl_Position = vec4(land.x, land.z, 0.0, 1.0); // floor space -> clip
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vOld;
      varying vec3 vNew;
      void main(){
        float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
        float newArea = length(dFdx(vNew)) * length(dFdy(vNew));
        float intensity = oldArea / max(newArea, 1e-6);
        gl_FragColor = vec4(vec3(clamp(intensity, 0.0, 6.0)), 1.0);
      }
    `,
  });
  causticGrid = new THREE.Mesh(geo, mat);
  causticGrid.frustumCulled = false;
  causticScene.add(causticGrid);
}

function renderCaustics() {
  causticGrid.material.uniforms.uSim.value = simA.texture;
  causticGrid.material.uniforms.uNormal.value = normalRT.texture;
  renderer.setRenderTarget(causticRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(causticScene, causticCam);
  renderer.setRenderTarget(null);
}

// ---------------------------------------------------------------------------
// Pool (floor + walls)
// ---------------------------------------------------------------------------
function makePool() {
  const group = new THREE.Group();

  const floorMat = new THREE.ShaderMaterial({
    uniforms: {
      uTile: { value: tileTex },
      uCaustic: { value: null },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; varying vec3 vWorld;
      uniform sampler2D uTile, uCaustic;
      void main(){
        vec3 tile = texture2D(uTile, vUv * 3.0).rgb;
        vec2 cuv = vWorld.xz * 0.5 + 0.5;       // floor-space caustic lookup
        float caustic = texture2D(uCaustic, cuv).r;
        vec3 col = tile * (0.45 + caustic * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1;
  group.add(floor);
  group.userData.floorMat = floorMat;

  // Walls: simple tiled, slightly darker. Inward-facing.
  const wallMat = new THREE.ShaderMaterial({
    uniforms: { uTile: { value: tileTex } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; uniform sampler2D uTile;
      void main(){ gl_FragColor = vec4(texture2D(uTile, vUv * vec2(3.0,1.5)).rgb * 0.6, 1.0); }
    `,
    side: THREE.DoubleSide,
  });
  const wallGeo = new THREE.PlaneGeometry(2, 1); // spans width 2, height 1 (y -1..0)
  const mk = (rx, ry, px, pz) => {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.rotation.y = ry; m.rotation.x = rx; m.position.set(px, -0.5, pz);
    group.add(m);
  };
  mk(0, 0, 0, -1);          // back  (faces +z)
  mk(0, Math.PI, 0, 1);     // front
  mk(0, Math.PI / 2, -1, 0);// left
  mk(0, -Math.PI / 2, 1, 0);// right

  return group;
}

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------
function makeWater() {
  const geo = new THREE.PlaneGeometry(2, 2, GRID_SEG, GRID_SEG);
  geo.rotateX(-Math.PI / 2);

  waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uSim: { value: null },
      uNormal: { value: null },
      uTile: { value: tileTex },
      uCaustic: { value: null },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: SUN_COLOR },
      uHorizon: { value: HORIZON },
      uZenith: { value: ZENITH },
      uTint: { value: WATER_TINT },
      uCamPos: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uSim;
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        vUv = uv;
        float h = texture2D(uSim, uv).r;
        vec3 p = vec3(position.x, h, position.z);
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv; varying vec3 vWorld;
      uniform sampler2D uNormal, uTile, uCaustic;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uTint, uCamPos;
      ${SKY_GLSL}

      // Sample whatever pool surface a ray from o in direction d hits.
      vec3 poolHit(vec3 o, vec3 d){
        float tBest = 1e9; int face = -1; vec3 hit = o;
        if (d.y < -1e-4){ float t=(-1.0-o.y)/d.y; vec3 p=o+d*t;
          if(t>0.0 && abs(p.x)<=1.0 && abs(p.z)<=1.0 && t<tBest){tBest=t;face=0;hit=p;} }
        if (d.x >  1e-4){ float t=(1.0-o.x)/d.x; vec3 p=o+d*t;
          if(t>0.0 && abs(p.z)<=1.0 && p.y<=0.0 && p.y>=-1.0 && t<tBest){tBest=t;face=1;hit=p;} }
        if (d.x < -1e-4){ float t=(-1.0-o.x)/d.x; vec3 p=o+d*t;
          if(t>0.0 && abs(p.z)<=1.0 && p.y<=0.0 && p.y>=-1.0 && t<tBest){tBest=t;face=2;hit=p;} }
        if (d.z >  1e-4){ float t=(1.0-o.z)/d.z; vec3 p=o+d*t;
          if(t>0.0 && abs(p.x)<=1.0 && p.y<=0.0 && p.y>=-1.0 && t<tBest){tBest=t;face=3;hit=p;} }
        if (d.z < -1e-4){ float t=(-1.0-o.z)/d.z; vec3 p=o+d*t;
          if(t>0.0 && abs(p.x)<=1.0 && p.y<=0.0 && p.y>=-1.0 && t<tBest){tBest=t;face=4;hit=p;} }

        vec3 base;
        if (face == 0){
          vec3 tile = texture2D(uTile, (hit.xz * 0.5 + 0.5) * 3.0).rgb;
          float caustic = texture2D(uCaustic, hit.xz * 0.5 + 0.5).r;
          base = tile * (0.45 + caustic * 0.5);
        } else if (face == 1 || face == 2){
          vec2 uv = vec2(hit.z*0.5+0.5, hit.y+1.0);
          base = texture2D(uTile, uv * vec2(3.0,1.5)).rgb * 0.6;
        } else {
          vec2 uv = vec2(hit.x*0.5+0.5, hit.y+1.0);
          base = texture2D(uTile, uv * vec2(3.0,1.5)).rgb * 0.6;
        }
        // water absorption with travelled distance
        float depth = clamp(tBest, 0.0, 2.0);
        return mix(base, uTint, 1.0 - exp(-depth * 0.55));
      }

      void main(){
        vec3 N = texture2D(uNormal, vUv).xyz;
        if (length(N) < 0.5) N = vec3(0.0,1.0,0.0);
        N = normalize(N);
        vec3 V = normalize(uCamPos - vWorld);

        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);

        vec3 refrDir = refract(-V, N, ${IOR.toFixed(5)});
        vec3 refrCol = (length(refrDir) < 0.001)
          ? skyColor(reflect(-V, N))
          : poolHit(vWorld, refrDir);

        vec3 reflCol = skyColor(reflect(-V, N));
        vec3 col = mix(refrCol, reflCol, clamp(fres, 0.0, 1.0));

        // sun glint
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), 350.0) * 1.6;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, waterMat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------
function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSunDir: { value: SUN_DIR }, uSunColor: { value: SUN_COLOR }, uHorizon: { value: HORIZON }, uZenith: { value: ZENITH } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec3 vDir;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith;
      ${SKY_GLSL}
      void main(){ gl_FragColor = vec4(skyColor(vDir), 1.0); }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat);
}

// ---------------------------------------------------------------------------
// Pointer -> drops
// ---------------------------------------------------------------------------
function setupPointer() {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  let down = false;

  const cast = (e, strength, radius) => {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return;
    if (Math.abs(hit.x) > 1 || Math.abs(hit.z) > 1) return;
    // sim-uv v maps to world -z (the water grid is a plane rotated -90° about X),
    // so v must be 0.5 - 0.5*z, not 0.5 + 0.5*z — otherwise clicks mirror front/back.
    _dropQueue.push({ x: hit.x * 0.5 + 0.5, y: 0.5 - hit.z * 0.5, s: strength, r: radius });
  };
  renderer.domElement.addEventListener('pointerdown', (e) => { down = true; cast(e, 0.6, 0.04); });
  renderer.domElement.addEventListener('pointermove', (e) => { if (down) cast(e, 0.18, 0.03); });
  window.addEventListener('pointerup', () => { down = false; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.autoClear = true;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 200);
  camera.position.set(1.9, 1.7, 2.2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.2, 0);
  controls.minDistance = 1.6;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.49; // stay above the water
  controls.enableDamping = true;

  tileTex = makeTileTexture();
  initSim();
  initCaustics();

  scene.add(makeSky());
  const pool = makePool();
  scene.add(pool);
  const water = makeWater();
  scene.add(water);

  // wire shared textures
  pool.userData.floorMat.uniforms.uCaustic.value = causticRT.texture;
  waterMat.uniforms.uCaustic.value = causticRT.texture;

  setupPointer();

  // a couple of seed drops so there's motion on load
  _dropQueue.push({ x: 0.4, y: 0.45, s: 0.5, r: 0.04 });
  _dropQueue.push({ x: 0.62, y: 0.6, s: 0.4, r: 0.035 });

  clock = new THREE.Clock();
  addEventListener('resize', onResize);
  renderer.setAnimationLoop(loop);

  window.__pool = {
    renderer, scene, camera, step: loop,
    drop: (x = 0.5, y = 0.5, s = 0.6, r = 0.04) => _dropQueue.push({ x, y, s, r }),
  };
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

let frames = 0, accum = 0, lastMs = 0;
function loop() {
  controls.update();

  // simulate a few substeps for lively waves
  for (let i = 0; i < 3; i++) stepSim();
  renderCaustics();

  waterMat.uniforms.uSim.value = simA.texture;
  waterMat.uniforms.uNormal.value = normalRT.texture;
  waterMat.uniforms.uCamPos.value.copy(camera.position);

  renderer.setClearColor(0x0c1320, 1);
  renderer.render(scene, camera);

  const now = performance.now();
  if (lastMs) { accum += now - lastMs; frames++; }
  lastMs = now;
  if (accum >= 250) {
    const avg = accum / frames;
    $('fps').textContent = String(Math.round(1000 / avg));
    $('ms').textContent = avg.toFixed(1) + ' ms';
    accum = 0; frames = 0;
  }
}

try { init(); } catch (e) { window.__poolError = String(e && (e.stack || e.message || e)); console.error('[pool] init failed:', e); }
