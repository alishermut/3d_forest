import * as THREE from 'three';
import { getHeight, LAKE_WATER_Y } from './terrain.js';
import {
  sunDirection,
  FOG_COLOR,
  ZENITH_COLOR,
  SUN_COLOR,
} from './atmosphere.js';

// Water rendering (Phase 14 rewrite). The old version faked every optical
// cue: sky-tint "reflection", procedural sine normals, and a baked terrain
// height texture to discard shoreline pixels (which quantized into a visible
// crack). This version does the real things:
//   • Tiling multi-octave NORMAL map  -> fine ripple detail that never tiles
//   • Gerstner wave sum               -> varied swell + analytic surface normal
//   • REFRACTION + DEPTH pre-pass      -> see-through bed, soft shoreline, depth color
//   • Planar REFLECTION (lake)         -> real trees + sky mirrored on the surface
//   • Analytic sky reflection (river)  -> matches the atmosphere sky dome exactly

const materials = [];

// Objects on this layer (grass, flowers, dust) are skipped by the water
// pre-passes: through ripple distortion and a half-res mirror they are
// invisible anyway, and together they are hundreds of thousands of
// instances re-drawn twice per frame. The main camera must enable this
// layer (main.js does) so they still render normally on screen.
export const WATER_EXCLUDED_LAYER = 1;

// --- Module state wired up in createWater(), used by prepareWater() ----------
let lakeMesh = null;
let lakeMaterial = null;
let reflectionRT = null;
let refractionRT = null;
const _drawSize = new THREE.Vector2(1, 1);

// =============================================================================
// Procedural tiling normal (really a slope/derivative) map. Seamless because
// the value noise is periodic per octave. Sampled at four scales in the shader
// so the high-frequency sparkle never visibly repeats.
// =============================================================================
function makeWaterNormalTexture(size = 256) {
  function makeGrid(period, seed) {
    const g = new Float32Array(period * period);
    let s = seed >>> 0;
    for (let i = 0; i < g.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return g;
  }
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function noise(grid, period, u, v) {
    const x = u * period;
    const y = v * period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const i0 = ((x0 % period) + period) % period;
    const i1 = (i0 + 1) % period;
    const j0 = ((y0 % period) + period) % period;
    const j1 = (j0 + 1) % period;
    const v00 = grid[j0 * period + i0];
    const v10 = grid[j0 * period + i1];
    const v01 = grid[j1 * period + i0];
    const v11 = grid[j1 * period + i1];
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  }
  const octs = [
    { p: 4, a: 1.0, s: 11 },
    { p: 8, a: 0.5, s: 23 },
    { p: 16, a: 0.25, s: 37 },
    { p: 32, a: 0.125, s: 51 },
  ].map((o) => ({ ...o, grid: makeGrid(o.p, o.s) }));

  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let val = 0;
      let amp = 0;
      for (const o of octs) {
        val += noise(o.grid, o.p, u, v) * o.a;
        amp += o.a;
      }
      h[y * size + x] = val / amp;
    }
  }

  // Store the height-field SLOPE (central differences, wrapped) in R/G.
  const data = new Uint8Array(size * size * 4);
  const strength = 2.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const yt = (y - 1 + size) % size;
      const yb = (y + 1) % size;
      const dx = (h[y * size + xr] - h[y * size + xl]) * strength;
      const dy = (h[yb * size + x] - h[yt * size + x]) * strength;
      const i = (y * size + x) * 4;
      data[i] = THREE.MathUtils.clamp((dx * 0.5 + 0.5) * 255, 0, 255);
      data[i + 1] = THREE.MathUtils.clamp((dy * 0.5 + 0.5) * 255, 0, 255);
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let normalTex = null;

// =============================================================================
// Gerstner waves. THE SAME three waves are evaluated in the vertex shader (for
// the surface) and here in JS (for buoyancy/swim physics) — keep them in sync.
// dir.xy = horizontal direction, k = 2π/wavelength, amp, speed.
// =============================================================================
const WAVES = [
  { dx: 0.876, dy: 0.482, len: 16.0, amp: 0.085, spd: 0.55 },
  { dx: -0.514, dy: 0.857, len: 10.0, amp: 0.05, spd: 0.85 },
  { dx: 0.371, dy: -0.928, len: 6.0, amp: 0.028, spd: 1.25 },
];
const LAKE_WAVE_SPEED = 1.0; // matches the lake material's uWaveSpeed

// JS mirror of the shader's Gerstner vertical displacement, tapered to zero in
// the shallows exactly like the vertex shader, so floating bodies and the
// swimming camera ride the visible waves.
export function getWaveHeight(x, z, time) {
  const t = time * LAKE_WAVE_SPEED;
  const taper = THREE.MathUtils.clamp(
    (LAKE_WATER_Y - getHeight(x, z)) / 1.2,
    0,
    1
  );
  let y = 0;
  for (const w of WAVES) {
    const k = (Math.PI * 2) / w.len;
    const f = k * (w.dx * x + w.dy * z) - w.spd * t;
    y += w.amp * Math.sin(f);
  }
  return y * taper;
}

// =============================================================================
// Material
// =============================================================================
function makeWaterMaterial(opts) {
  const {
    waveAmp = 1.0,
    waveSpeed = 1.0,
    flowSpeed = 0.05,
    rippleScale = 6.0,
    bump = 0.6,
    clipRadius = -1,
    useReflection = 0,
    refractStrength = 0.06,
    shallow = new THREE.Color(0.24, 0.44, 0.46),
    deep = new THREE.Color(0.05, 0.17, 0.22),
    depthFade = 4.5,
    murk = 0.14,
    foamWidth = 0.4,
    foamStrength = 0.9,
    edge = 0.08,
  } = opts;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uWaveAmp: { value: waveAmp },
        uWaveSpeed: { value: waveSpeed },
        uFlowSpeed: { value: flowSpeed },
        uRippleScale: { value: rippleScale },
        uBump: { value: bump },
        uClipRadius: { value: clipRadius },
        uSunDir: { value: sunDirection },
        uSunColor: { value: new THREE.Color().copy(SUN_COLOR) },
        uHorizon: { value: new THREE.Color().copy(FOG_COLOR) },
        uZenith: { value: new THREE.Color().copy(ZENITH_COLOR) },
        uNormalMap: { value: null },
        // Reflection (planar, lake only)
        uReflection: { value: null },
        uReflectionMatrix: { value: new THREE.Matrix4() },
        uUseReflection: { value: useReflection },
        uReflectDistort: { value: 0.035 },
        // Physical water: F0 = 0.02 (IOR 1.33). The old 0.06 + pow-3 ramp
        // over-reflected at mid angles and turned the whole sheet chalky.
        uReflMin: { value: 0.02 },
        uReflectivity: { value: 1.0 },
        // Refraction + depth
        uRefraction: { value: null },
        uDepthTex: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
        uRefractStrength: { value: refractStrength },
        // Body color + shoreline
        uWaterShallow: { value: shallow },
        uWaterDeep: { value: deep },
        uDepthFade: { value: depthFade },
        uMurk: { value: murk },
        uFoamWidth: { value: foamWidth },
        uFoamStrength: { value: foamStrength },
        uEdge: { value: edge },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying vec3 vWorldPos;
      varying float vViewZ;
      varying vec4 vReflCoord;
      varying float vAnalyticDepth;
      uniform float uTime;
      uniform float uWaveAmp;
      uniform float uWaveSpeed;
      uniform mat4 uReflectionMatrix;
      #include <fog_pars_vertex>

      // Three Gerstner waves (must match WAVES[] / getWaveHeight in JS).
      const vec3 W0 = vec3( 0.876,  0.482, 16.0);
      const vec3 W1 = vec3(-0.514,  0.857, 10.0);
      const vec3 W2 = vec3( 0.371, -0.928,  6.0);
      const vec3 WA = vec3(0.085, 0.05, 0.028);   // amplitudes
      const vec3 WS = vec3(0.55, 0.85, 1.25);     // speeds

      void gerstner(vec2 p, float t, float taper, out vec3 disp, out vec2 slope) {
        disp = vec3(0.0);
        slope = vec2(0.0);
        vec2 dirs[3]; dirs[0]=W0.xy; dirs[1]=W1.xy; dirs[2]=W2.xy;
        float lens[3]; lens[0]=W0.z; lens[1]=W1.z; lens[2]=W2.z;
        for (int i = 0; i < 3; i++) {
          float k = 6.2831853 / lens[i];
          float a = WA[i] * uWaveAmp * taper;
          float f = k * dot(dirs[i], p) - WS[i] * t;
          float c = cos(f);
          disp.y += a * sin(f);
          disp.x += dirs[i].x * a * c * 0.6;
          disp.z += dirs[i].y * a * c * 0.6;
          slope += dirs[i] * (k * a * c);
        }
      }

      void main() {
        vec3 transformed = position;            // used by the fog chunk
        vec4 flatWorld = modelMatrix * vec4(position, 1.0);
        float taper = clamp(aDepth / 1.2, 0.0, 1.0);

        vec3 disp; vec2 slope;
        gerstner(flatWorld.xz, uTime * uWaveSpeed, taper, disp, slope);

        vec4 wp = flatWorld;
        wp.xyz += disp;
        vWorldPos = wp.xyz;
        vReflCoord = uReflectionMatrix * flatWorld;
        // True vertical water depth (bed -> displaced surface), interpolated
        // smoothly — used instead of the depth pre-pass for foam/edge/tint.
        vAnalyticDepth = max(aDepth + disp.y, 0.0);

        vec4 mv = viewMatrix * wp;
        vViewZ = -mv.z;
        #include <fog_vertex>
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlowSpeed;
      uniform float uRippleScale;
      uniform float uBump;
      uniform float uClipRadius;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform sampler2D uNormalMap;
      uniform sampler2D uReflection;
      uniform float uUseReflection;
      uniform float uReflectDistort;
      uniform float uReflMin;
      uniform float uReflectivity;
      uniform sampler2D uRefraction;
      uniform sampler2D uDepthTex;
      uniform vec2 uResolution;
      uniform float uNear;
      uniform float uFar;
      uniform float uRefractStrength;
      uniform vec3 uWaterShallow;
      uniform vec3 uWaterDeep;
      uniform float uDepthFade;
      uniform float uMurk;
      uniform float uFoamWidth;
      uniform float uFoamStrength;
      uniform float uEdge;

      varying vec3 vWorldPos;
      varying float vViewZ;
      varying vec4 vReflCoord;
      varying float vAnalyticDepth;

      // Same three Gerstner waves as the vertex stage — the swell normal is
      // recomputed PER PIXEL here. The vertex grid undersamples the 6 m wave
      // and interpolated normals drew triangle-shaped shading wedges at
      // grazing angles.
      uniform float uWaveAmp;
      uniform float uWaveSpeed;
      const vec3 W0 = vec3( 0.876,  0.482, 16.0);
      const vec3 W1 = vec3(-0.514,  0.857, 10.0);
      const vec3 W2 = vec3( 0.371, -0.928,  6.0);
      const vec3 WA = vec3(0.085, 0.05, 0.028);
      const vec3 WS = vec3(0.55, 0.85, 1.25);

      vec2 swellSlope(vec2 p, float taper) {
        float wt = uTime * uWaveSpeed;
        vec2 slope = vec2(0.0);
        vec2 dirs[3]; dirs[0]=W0.xy; dirs[1]=W1.xy; dirs[2]=W2.xy;
        float lens[3]; lens[0]=W0.z; lens[1]=W1.z; lens[2]=W2.z;
        for (int i = 0; i < 3; i++) {
          float k = 6.2831853 / lens[i];
          float a = WA[i] * uWaveAmp * taper;
          float f = k * dot(dirs[i], p) - WS[i] * wt;
          slope += dirs[i] * (k * a * cos(f));
        }
        return slope;
      }

      #include <packing>
      #include <fog_pars_fragment>

      vec3 skyColor(vec3 dir) {
        dir = normalize(dir);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.02, 0.5, dir.y));
        float s = max(dot(dir, uSunDir), 0.0);
        sky += uSunColor * pow(s, 350.0) * 1.6;
        // Halo halved vs the sky dome: at grazing fresnel the full halo
        // bleached the whole sheet to white when facing the sun.
        sky += uSunColor * pow(s, 4.5) * 0.45;
        return sky;
      }

      vec2 sampleSlope(vec2 uv) {
        return texture2D(uNormalMap, uv).rg * 2.0 - 1.0;
      }

      float sceneDist(vec2 uv) {
        float d = texture2D(uDepthTex, uv).x;
        return -perspectiveDepthToViewZ(d, uNear, uFar);
      }

      void main() {
        if (uClipRadius > 0.0 && length(vWorldPos.xz) > uClipRadius) discard;

        // ---- Surface normal: low-freq swell + 4 octaves of the ripple map.
        vec2 buv = vWorldPos.xz / uRippleScale;
        float ft = uTime * uFlowSpeed;
        vec2 s = vec2(0.0);
        s += sampleSlope(buv * 1.0 + vec2( ft * 0.30,  ft * 0.20)) * 1.0;
        s += sampleSlope(buv * 2.1 + vec2(-ft * 0.50,  ft * 0.40)) * 0.5;
        s += sampleSlope(buv * 4.3 + vec2( ft * 0.70, -ft * 0.60)) * 0.25;
        s += sampleSlope(buv * 8.7 + vec2(-ft * 1.10,  ft * 0.90)) * 0.125;
        vec2 sw = swellSlope(vWorldPos.xz, clamp(vAnalyticDepth / 1.2, 0.0, 1.0));
        vec3 N = normalize(vec3(-sw.x - s.x * uBump, 1.0, -sw.y - s.y * uBump));

        vec3 viewDir = normalize(cameraPosition - vWorldPos);

        // ---- Water depth: analytic (bed -> surface, from geometry). The
        // old reconstruction from the half-res depth pre-pass quantized at
        // grazing angles and drew dashed foam/edge artifacts along banks.
        vec2 screenUV = gl_FragCoord.xy / uResolution;
        float vdepth = vAnalyticDepth;

        // ---- Refraction: bend the screen-space lookup of the bed by the
        // surface normal. Don't pull foreground geometry into the water
        // (that check is the one remaining use of the depth pre-pass).
        // The offset fades out at grazing angles: reflection dominates there
        // anyway, and the half-res depth check otherwise flips the lookup
        // on/off across rows, drawing striped artifacts.
        vec2 refrUV = screenUV + N.xz * uRefractStrength * clamp(vdepth, 0.0, 1.5)
          * clamp(abs(viewDir.y) * 3.0, 0.0, 1.0);
        if (sceneDist(refrUV) < vViewZ) refrUV = screenUV;
        vec3 bed = texture2D(uRefraction, refrUV).rgb;

        // ---- Body color: clear over shallows (show bed), absorbs to deep.
        float t = clamp(vdepth / uDepthFade, 0.0, 1.0);
        vec3 tint = mix(uWaterShallow, uWaterDeep, t);
        float clarity = exp(-vdepth * uMurk);              // 1 shallow -> 0 deep
        vec3 body = mix(tint, bed * (tint + 0.6), clarity);

        // ---- Reflection: planar (lake) or analytic sky (river).
        vec3 reflCol;
        if (uUseReflection > 0.5) {
          vec2 ruv = vReflCoord.xy / vReflCoord.w + N.xz * uReflectDistort;
          reflCol = texture2D(uReflection, clamp(ruv, 0.001, 0.999)).rgb;
        } else {
          reflCol = skyColor(reflect(-viewDir, N));
        }
        // Schlick fresnel, exponent 5 (physical). uReflectivity caps the
        // grazing endpoint below 1.0 — the raw ramp to a perfect mirror at
        // exactly 90 deg overestimates reflection at 80-85 deg and washes
        // the far sheet to milk; the cap keeps some body color everywhere.
        float fres = uReflMin + (1.0 - uReflMin) *
          pow(1.0 - max(dot(viewDir, N), 0.0), 5.0);
        vec3 col = mix(body, reflCol, clamp(fres * uReflectivity, 0.0, 1.0));

        // ---- Sun specular glint off the ripples.
        vec3 hVec = normalize(uSunDir + viewDir);
        col += uSunColor * pow(max(dot(N, hVec), 0.0), 200.0) * 1.3;

        // ---- Animated shoreline foam in the shallow band. Tone is kept
        // close to wet sand so the waterline doesn't draw a hard white rule.
        float foam = 1.0 - smoothstep(0.0, uFoamWidth, vdepth);
        foam *= 0.55 + 0.45 * sin(uTime * 2.0 + vWorldPos.x * 2.3 +
          vWorldPos.z * 1.9 + s.x * 4.0);
        col = mix(col, vec3(0.80, 0.83, 0.78), clamp(foam, 0.0, 1.0) * uFoamStrength);

        // ---- Soft edge: water is essentially opaque (refraction shows the
        // bed); only the shallowest band feathers out at the waterline.
        float alpha = smoothstep(0.0, uEdge, vdepth);

        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
      }
    `,
  });
  mat.uniforms.uNormalMap.value = normalTex;
  materials.push(mat);
  return mat;
}

// =============================================================================
// Build geometry + materials + render targets.
// =============================================================================
export function createWater(scene, renderer, camera) {
  normalTex = makeWaterNormalTexture(256);

  renderer.getDrawingBufferSize(_drawSize);
  // Half resolution: the refracted bed is only ever seen through ripple
  // distortion and murk tint — full res was indistinguishable and cost a
  // full-size HalfFloat scene render every frame. NOTE: the shader's
  // uResolution stays the FULL drawing-buffer size (it normalizes
  // gl_FragCoord into 0..1 screen UVs; the half-res textures are sampled
  // with those normalized UVs).
  const rw = Math.max(2, Math.floor(_drawSize.x / 2));
  const rh = Math.max(2, Math.floor(_drawSize.y / 2));

  // Refraction = scene color WITHOUT water + its depth (opaque scene depth).
  const depthTexture = new THREE.DepthTexture(rw, rh);
  depthTexture.type = THREE.UnsignedShortType;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  refractionRT = new THREE.WebGLRenderTarget(rw, rh, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    depthTexture,
  });

  // Planar reflection (half-res is plenty — it gets distorted anyway).
  // rw/rh are already half the drawing buffer.
  reflectionRT = new THREE.WebGLRenderTarget(rw, rh, {
    type: THREE.HalfFloatType,
  });
  reflectionRT.texture.minFilter = THREE.LinearFilter;
  reflectionRT.texture.magFilter = THREE.LinearFilter;

  // --- Lake: a flat sheet over the basin.
  const lakeGeo = new THREE.PlaneGeometry(240, 240, 96, 96);
  lakeGeo.rotateX(-Math.PI / 2);
  {
    const pos = lakeGeo.attributes.position;
    const depths = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      depths[i] = LAKE_WATER_Y - getHeight(pos.getX(i), pos.getZ(i));
    }
    lakeGeo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  }
  lakeMaterial = makeWaterMaterial({
    waveAmp: 1.0,
    waveSpeed: LAKE_WAVE_SPEED,
    flowSpeed: 0.06,
    rippleScale: 7.0,
    bump: 0.6,
    clipRadius: 106,
    useReflection: 1,
    refractStrength: 0.07,
    // Soft waterline: 8 cm of alpha feather drew a razor edge against the
    // beach; half a meter blends into the wet-sand band instead.
    edge: 0.5,
    foamStrength: 0.6,
  });
  lakeMaterial.uniforms.uReflection.value = reflectionRT.texture;
  lakeMaterial.uniforms.uRefraction.value = refractionRT.texture;
  lakeMaterial.uniforms.uDepthTex.value = refractionRT.depthTexture;
  lakeMaterial.uniforms.uNear.value = camera.near;
  lakeMaterial.uniforms.uFar.value = camera.far;
  lakeMaterial.uniforms.uResolution.value.set(_drawSize.x, _drawSize.y);
  // Grazing-endpoint cap (see fresnel comment in the shader): some body
  // color always survives, so the far sheet never goes full mirror-milk.
  lakeMaterial.uniforms.uReflectivity.value = 0.85;

  lakeMesh = new THREE.Mesh(lakeGeo, lakeMaterial);
  lakeMesh.position.y = LAKE_WATER_Y;
  lakeMesh.renderOrder = 2;
  lakeMesh.matrixAutoUpdate = true;
  lakeMesh.updateMatrixWorld(true);
  scene.add(lakeMesh);

  // (The river water strip was removed with the river — see terrain.js.
  // Its wide 2-vertex rings overlapping the lake sheet at the mouth drew
  // X-shaped interpolation wedges and double-draw moiré on the water.)
}

// =============================================================================
// Per-frame: refraction/depth pre-pass + planar reflection. Call BEFORE the
// composer renders the main image.
// =============================================================================
const _mirrorCam = new THREE.PerspectiveCamera();
const _texMatrix = new THREE.Matrix4();
const _mirrorPlane = new THREE.Plane();
const _normal = new THREE.Vector3();
const _mirrorPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _lookAt = new THREE.Vector3();
const _clipPlane = new THREE.Vector4();
const _view = new THREE.Vector3();
const _target = new THREE.Vector3();
const _q = new THREE.Vector4();

function renderReflection(renderer, scene, camera) {
  _mirrorPos.setFromMatrixPosition(lakeMesh.matrixWorld);
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  _rot.extractRotation(lakeMesh.matrixWorld);
  _normal.set(0, 0, 1).applyMatrix4(_rot); // lake's local +Z -> world +Y

  _view.subVectors(_mirrorPos, _camPos);
  if (_view.dot(_normal) > 0) return; // camera is under the surface

  _view.reflect(_normal).negate().add(_mirrorPos);
  _rot.extractRotation(camera.matrixWorld);
  _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
  _target.subVectors(_mirrorPos, _lookAt).reflect(_normal).negate().add(_mirrorPos);

  _mirrorCam.position.copy(_view);
  _mirrorCam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
  _mirrorCam.lookAt(_target);
  _mirrorCam.far = camera.far;
  _mirrorCam.updateMatrixWorld();
  _mirrorCam.projectionMatrix.copy(camera.projectionMatrix);

  _texMatrix.set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0
  );
  _texMatrix.multiply(_mirrorCam.projectionMatrix);
  _texMatrix.multiply(_mirrorCam.matrixWorldInverse);

  // Oblique near plane = the water plane, so nothing under the surface leaks.
  _mirrorPlane.setFromNormalAndCoplanarPoint(_normal, _mirrorPos);
  _mirrorPlane.applyMatrix4(_mirrorCam.matrixWorldInverse);
  _clipPlane.set(
    _mirrorPlane.normal.x,
    _mirrorPlane.normal.y,
    _mirrorPlane.normal.z,
    _mirrorPlane.constant
  );
  const pm = _mirrorCam.projectionMatrix;
  _q.x = (Math.sign(_clipPlane.x) + pm.elements[8]) / pm.elements[0];
  _q.y = (Math.sign(_clipPlane.y) + pm.elements[9]) / pm.elements[5];
  _q.z = -1.0;
  _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
  _clipPlane.multiplyScalar(2.0 / _clipPlane.dot(_q));
  pm.elements[2] = _clipPlane.x;
  pm.elements[6] = _clipPlane.y;
  pm.elements[10] = _clipPlane.z + 1.0;
  pm.elements[14] = _clipPlane.w;

  lakeMaterial.uniforms.uReflectionMatrix.value.copy(_texMatrix);

  renderer.setRenderTarget(reflectionRT);
  renderer.clear();
  renderer.render(scene, _mirrorCam);
}

const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _camInverse = new THREE.Matrix4();
// Generous lake bound: clip radius 106 + margin for waves/one-frame lag.
const _lakeSphere = new THREE.Sphere(new THREE.Vector3(0, LAKE_WATER_Y, 0), 112);

export function prepareWater(renderer, scene, camera) {
  if (!refractionRT) return;

  // Both pre-passes exist only to feed the water shaders — when neither
  // water body can be on screen, skip the two extra scene renders entirely.
  camera.updateMatrixWorld();
  _camInverse.copy(camera.matrixWorld).invert();
  _projScreen.multiplyMatrices(camera.projectionMatrix, _camInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
  if (!_frustum.intersectsSphere(_lakeSphere)) return;

  const prevTarget = renderer.getRenderTarget();
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  // Grass/flowers/dust live on WATER_EXCLUDED_LAYER — drop them from both
  // pre-passes (the mirror camera never enables that layer to begin with).
  const prevLayerMask = camera.layers.mask;
  camera.layers.disable(WATER_EXCLUDED_LAYER);
  // The two pre-passes reuse last frame's shadow map; the main composer
  // render right after recomputes it once. Net shadow cost stays ~1x.
  renderer.shadowMap.autoUpdate = false;

  const lakeVisible = lakeMesh.visible;
  lakeMesh.visible = false;

  // 1) Refraction + depth: the scene with no water, from the main camera.
  renderer.setRenderTarget(refractionRT);
  renderer.clear();
  renderer.render(scene, camera);

  // 2) Planar reflection for the lake.
  renderReflection(renderer, scene, camera);

  lakeMesh.visible = lakeVisible;
  camera.layers.mask = prevLayerMask;
  renderer.shadowMap.autoUpdate = prevShadowAuto;
  renderer.setRenderTarget(prevTarget);
}

export function setWaterSize(renderer) {
  if (!refractionRT) return;
  renderer.getDrawingBufferSize(_drawSize);
  // Both pre-pass targets run at half the drawing buffer (see createWater);
  // uResolution stays the full size for gl_FragCoord normalization.
  const rw = Math.max(2, Math.floor(_drawSize.x / 2));
  const rh = Math.max(2, Math.floor(_drawSize.y / 2));
  refractionRT.setSize(rw, rh);
  reflectionRT.setSize(rw, rh);
  for (const mat of materials) {
    mat.uniforms.uResolution.value.set(_drawSize.x, _drawSize.y);
  }
}

export function updateWater(elapsedTime) {
  for (const mat of materials) {
    mat.uniforms.uTime.value = elapsedTime;
  }
}
