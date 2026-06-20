// ===========================================================================
// Ocean scene SPIKE — WebGL interactive water SURFACE (not particles).
//
// This is the "looks like water / feels like water" approach for a game:
//   • a shaded surface, NOT simulated particles
//   • Gerstner swell + fine normal detail            -> moving water
//   • analytic sky reflection + Fresnel + sun glitter -> looks like water
//   • depth/horizon color + crest foam                -> reads as ocean
//   • an interactive GPU ripple simulation            -> FEELS like water
//
// The ripple sim is a classic wave-equation height field, ping-ponged between
// two float render targets each frame. Dragging on the surface injects an
// impulse; the wave propagates and reflects off the field edge. Its height +
// derived normal are added to the Gerstner surface near the camera. This is
// the part the forest lake (src/world/water.js) doesn't have.
//
// Pure WebGL (your existing renderer stack) — no WebGPU, no post rework.
// Throwaway spike: nothing imports this into the game.
// ===========================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);

// --- Shared sky/sun look. The sky DOME and the ocean's analytic reflection
// read the same values so the mirrored sky matches the real one exactly. ----
const SUN_DIR = new THREE.Vector3(0.55, 0.32, 0.4).normalize();
const SUN_COLOR = new THREE.Color(1.0, 0.93, 0.78);
const HORIZON = new THREE.Color(0.72, 0.82, 0.88);
const ZENITH = new THREE.Color(0.16, 0.42, 0.70);
const WATER_DEEP = new THREE.Color(0.012, 0.10, 0.16);
const WATER_SHALLOW = new THREE.Color(0.10, 0.34, 0.42);

// --- Ripple field config ----------------------------------------------------
const RIPPLE_RES = 512;       // sim texture resolution
const RIPPLE_SIZE = 140;      // meters covered by the field (centered at origin)

let renderer, scene, camera, controls, oceanMat, oceanMesh;
let clock;

// ---------------------------------------------------------------------------
// Ripple simulation (ping-pong wave equation)
// ---------------------------------------------------------------------------
let simRTA, simRTB, simMat, simQuad, simScene, simCam;
const impulse = { x: 0.5, y: 0.5, strength: 0.0, radius: 2.2 / RIPPLE_SIZE };

function makeSimRT() {
  const rt = new THREE.WebGLRenderTarget(RIPPLE_RES, RIPPLE_RES, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  });
  return rt;
}

function initRippleSim() {
  simRTA = makeSimRT();
  simRTB = makeSimRT();

  simMat = new THREE.ShaderMaterial({
    uniforms: {
      uPrev: { value: null },     // R = height(t-1 -> "current"), G = height(t-2 -> "previous")
      uTexel: { value: 1 / RIPPLE_RES },
      uImpulsePos: { value: new THREE.Vector2(0.5, 0.5) },
      uImpulseStrength: { value: 0.0 },
      uImpulseRadius: { value: impulse.radius },
      uDamping: { value: 0.994 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uPrev;
      uniform float uTexel;
      uniform vec2 uImpulsePos;
      uniform float uImpulseStrength;
      uniform float uImpulseRadius;
      uniform float uDamping;

      void main() {
        vec2 t = vec2(uTexel, 0.0);
        // .r = current height, .g = previous height
        float c  = texture2D(uPrev, vUv).r;
        float p  = texture2D(uPrev, vUv).g;
        float l  = texture2D(uPrev, vUv - t.xy).r;
        float r  = texture2D(uPrev, vUv + t.xy).r;
        float d  = texture2D(uPrev, vUv - t.yx).r;
        float u  = texture2D(uPrev, vUv + t.yx).r;

        // Discrete wave equation: a = c^2 * laplacian. k folds c^2*dt^2 in
        // (<=0.5 stays stable). Verlet step gives propagation + reflection.
        float lap = (l + r + u + d) - 4.0 * c;
        float n = (2.0 * c - p) + 0.49 * lap;
        n *= uDamping;

        // Inject a soft gaussian impulse where the pointer touched.
        float dist = distance(vUv, uImpulsePos);
        n += uImpulseStrength * exp(-(dist * dist) / (uImpulseRadius * uImpulseRadius));

        // Damp hard at the border so the boundary doesn't ring/accumulate.
        vec2 edge = min(vUv, 1.0 - vUv);
        float border = smoothstep(0.0, 0.03, min(edge.x, edge.y));
        n *= border;

        gl_FragColor = vec4(n, c, 0.0, 1.0);
      }
    `,
  });

  simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat);
  simScene = new THREE.Scene();
  simScene.add(simQuad);
  simCam = new THREE.Camera();

  // Prime both targets to zero.
  const clearMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  simQuad.material = clearMat;
  renderer.setRenderTarget(simRTA); renderer.render(simScene, simCam);
  renderer.setRenderTarget(simRTB); renderer.render(simScene, simCam);
  renderer.setRenderTarget(null);
  simQuad.material = simMat;
}

function stepRippleSim() {
  simMat.uniforms.uPrev.value = simRTA.texture;
  simMat.uniforms.uImpulsePos.value.set(impulse.x, impulse.y);
  simMat.uniforms.uImpulseStrength.value = impulse.strength;
  renderer.setRenderTarget(simRTB);
  renderer.render(simScene, simCam);
  renderer.setRenderTarget(null);
  // swap
  const tmp = simRTA; simRTA = simRTB; simRTB = tmp;
  // impulse is a one-frame kick
  impulse.strength = 0.0;
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------
function makeSky() {
  const geo = new THREE.SphereGeometry(4000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: SUN_COLOR },
      uHorizon: { value: HORIZON },
      uZenith: { value: ZENITH },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith;
      void main() {
        vec3 dir = normalize(vDir);
        float h = smoothstep(-0.05, 0.55, dir.y);
        vec3 sky = mix(uHorizon, uZenith, h);
        float s = max(dot(dir, uSunDir), 0.0);
        sky += uSunColor * pow(s, 900.0) * 2.0;        // sun disk
        sky += uSunColor * pow(s, 6.0) * 0.30;         // halo
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// Ocean surface
// ---------------------------------------------------------------------------
function makeOcean() {
  // Big plane; fog blends the far edge into the horizon so it reads infinite.
  const geo = new THREE.PlaneGeometry(2000, 2000, 400, 400);
  geo.rotateX(-Math.PI / 2);

  oceanMat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: SUN_DIR },
        uSunColor: { value: SUN_COLOR },
        uHorizon: { value: HORIZON },
        uZenith: { value: ZENITH },
        uDeep: { value: WATER_DEEP },
        uShallow: { value: WATER_SHALLOW },
        uRipple: { value: null },
        uRippleSize: { value: RIPPLE_SIZE },
        uRippleTexel: { value: 1 / RIPPLE_RES },
        uCamPos: { value: new THREE.Vector3() },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform sampler2D uRipple;
      uniform float uRippleSize;
      varying vec3 vWorld;
      varying float vRippleH;

      // Three Gerstner waves (dir.xy, wavelength, amplitude, speed).
      const vec4 W0 = vec4( 0.80,  0.60, 42.0, 0.55);
      const vec4 W1 = vec4(-0.45,  0.89, 24.0, 0.42);
      const vec4 W2 = vec4( 0.30, -0.95, 13.0, 0.28);
      const vec3 AMP = vec3(0.62, 0.34, 0.16);

      vec3 gerstner(vec2 p) {
        vec3 d = vec3(0.0);
        vec4 w[3]; w[0]=W0; w[1]=W1; w[2]=W2;
        for (int i=0;i<3;i++){
          float k = 6.2831853 / w[i].z;
          float a = AMP[i];
          float f = k * dot(w[i].xy, p) - w[i].w * uTime;
          float c = cos(f);
          d.y += a * sin(f);
          d.x += w[i].xy.x * a * c * 0.5;
          d.z += w[i].xy.y * a * c * 0.5;
        }
        return d;
      }

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec3 disp = gerstner(world.xz);
        world.xyz += disp;

        // Interactive ripple height (only inside the field around origin).
        vec2 ruv = world.xz / uRippleSize + 0.5;
        float rh = 0.0;
        if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) {
          rh = texture2D(uRipple, ruv).r;
        }
        vRippleH = rh;
        world.y += rh;

        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world; // name required by <fog_vertex>
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uDeep, uShallow, uCamPos;
      uniform sampler2D uRipple;
      uniform float uRippleSize, uRippleTexel;
      varying vec3 vWorld;
      varying float vRippleH;

      const vec4 W0 = vec4( 0.80,  0.60, 42.0, 0.55);
      const vec4 W1 = vec4(-0.45,  0.89, 24.0, 0.42);
      const vec4 W2 = vec4( 0.30, -0.95, 13.0, 0.28);
      const vec3 AMP = vec3(0.62, 0.34, 0.16);

      // Analytic Gerstner slope (per-pixel normal, no vertex normals needed).
      vec2 gerstnerSlope(vec2 p) {
        vec2 s = vec2(0.0);
        vec4 w[3]; w[0]=W0; w[1]=W1; w[2]=W2;
        for (int i=0;i<3;i++){
          float k = 6.2831853 / w[i].z;
          float a = AMP[i];
          float f = k * dot(w[i].xy, p) - w[i].w * uTime;
          s += w[i].xy * (k * a * cos(f));
        }
        return s;
      }

      vec3 skyColor(vec3 dir) {
        dir = normalize(dir);
        float h = smoothstep(-0.05, 0.55, dir.y);
        vec3 sky = mix(uHorizon, uZenith, max(h, 0.0));
        float s = max(dot(dir, uSunDir), 0.0);
        sky += uSunColor * pow(s, 900.0) * 2.0;
        sky += uSunColor * pow(s, 6.0) * 0.30;
        return sky;
      }

      void main() {
        // Base swell normal.
        vec2 slope = gerstnerSlope(vWorld.xz);

        // High-freq sparkle: two scrolling sine ripples (cheap detail normal).
        float t = uTime;
        slope += 0.18 * vec2(
          sin(vWorld.x * 1.7 + t * 1.3) + sin(vWorld.z * 1.1 - t * 0.9),
          cos(vWorld.z * 1.9 - t * 1.1) + sin(vWorld.x * 1.3 + t * 0.7)
        ) * 0.25;

        // Interactive ripple normal (central differences on the height field).
        vec2 ruv = vWorld.xz / uRippleSize + 0.5;
        float rippleStrength = 0.0;
        if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) {
          float e = uRippleTexel;
          float hl = texture2D(uRipple, ruv - vec2(e,0.0)).r;
          float hr = texture2D(uRipple, ruv + vec2(e,0.0)).r;
          float hd = texture2D(uRipple, ruv - vec2(0.0,e)).r;
          float hu = texture2D(uRipple, ruv + vec2(0.0,e)).r;
          // world-space derivative scaling
          float scale = 1.0 / (uRippleSize * uRippleTexel);
          slope += vec2(hr - hl, hu - hd) * scale * 6.0;
          rippleStrength = abs(hr - hl) + abs(hu - hd);
        }

        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 V = normalize(uCamPos - vWorld);

        // Fresnel (Schlick, water F0 = 0.02).
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);

        // Reflection: analytic sky (matches the dome).
        vec3 refl = skyColor(reflect(-V, N));

        // Body color: deep -> a touch lighter toward the horizon/grazing.
        float facing = clamp(dot(V, N), 0.0, 1.0);
        vec3 body = mix(uDeep, uShallow, pow(1.0 - facing, 3.0) * 0.6);

        vec3 col = mix(body, refl, clamp(fres, 0.0, 1.0));

        // Sun specular glint off the surface normal.
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), 400.0) * 2.2;

        // Foam where ripple disturbance is strong (interaction feedback).
        float foam = smoothstep(0.015, 0.06, rippleStrength);
        col = mix(col, vec3(0.85, 0.92, 0.95), foam * 0.7);

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }
    `,
  });

  oceanMesh = new THREE.Mesh(geo, oceanMat);
  oceanMesh.frustumCulled = false;
  return oceanMesh;
}

// ---------------------------------------------------------------------------
// Pointer -> ripple impulses
// ---------------------------------------------------------------------------
function setupPointer() {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  let down = false;

  const cast = (event) => {
    const ndc = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return false;
    const u = hit.x / RIPPLE_SIZE + 0.5;
    const v = hit.z / RIPPLE_SIZE + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    impulse.x = u; impulse.y = v;
    return true;
  };

  renderer.domElement.addEventListener('pointerdown', (e) => {
    down = true;
    if (cast(e)) impulse.strength = 0.9;
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (cast(e)) impulse.strength = 0.45; // continuous drag = gentler trail
  });
  window.addEventListener('pointerup', () => { down = false; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON.getHex(), 0.0016);

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 6000);
  camera.position.set(0, 9, 26);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.5, 0);
  controls.maxPolarAngle = Math.PI * 0.495; // don't go under the sea
  controls.minDistance = 6;
  controls.maxDistance = 120;
  controls.enableDamping = true;

  scene.add(makeSky());
  initRippleSim();
  scene.add(makeOcean());
  oceanMat.uniforms.uRipple.value = simRTA.texture;
  setupPointer();

  clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
  renderer.setAnimationLoop(loop);

  // Spike-only manual-step hook for headless verification (rAF is throttled
  // while the preview tab is hidden). Removed with the spike.
  window.__ocean = {
    renderer, scene, camera, step: loop,
    kick: (u = 0.5, v = 0.5, s = 0.9) => { impulse.x = u; impulse.y = v; impulse.strength = s; },
    readSim: () => {
      const buf = new Float32Array(4);
      renderer.readRenderTargetPixels(simRTA, RIPPLE_RES >> 1, RIPPLE_RES >> 1, 1, 1, buf);
      return [...buf];
    },
    sampleSim: (px, py) => {
      const buf = new Float32Array(4);
      renderer.readRenderTargetPixels(simRTA, px, py, 1, 1, buf);
      return [...buf];
    },
  };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

let frames = 0, accum = 0, lastMs = 0;
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  controls.update();

  // A few sim sub-steps per frame so waves travel at a lively speed.
  for (let i = 0; i < 2; i++) stepRippleSim();
  oceanMat.uniforms.uRipple.value = simRTA.texture;
  oceanMat.uniforms.uTime.value = clock.elapsedTime;
  oceanMat.uniforms.uCamPos.value.copy(camera.position);

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

init();
