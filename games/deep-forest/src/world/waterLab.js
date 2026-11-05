import * as THREE from 'three';
import {
  getHeight,
  getLakeDistance,
  LAKE_WATER_Y,
  LAKE_X,
  LAKE_Z,
} from './terrain.js';
import { sunDirection, FOG_COLOR, ZENITH_COLOR, SUN_COLOR } from './atmosphere.js';

// ===========================================================================
// waterLab.js — drop-in replacement for water.js's RENDERING, using the
// Water Lab "Medium" surface look:
//   • the SAME three Gerstner swell waves as water.js (so getWaveHeight in
//     physics still matches the visual — buoyancy/swim are untouched)
//   • FBM (multi-octave + domain-warp) detail normals  -> no tiling
//   • analytic sky reflection (NOT planar) + Fresnel + sun glint
//   • depth-based color + noise-broken shoreline foam (baked aDepth)
//
// Deliberately LIGHTER than water.js: no planar-reflection pass, no scene
// refraction/depth pre-pass. prepareWater()/setWaterSize() are no-ops, so the
// per-frame water cost is just the one transparent surface draw.
//
// API matches water.js (createWater/updateWater/prepareWater/setWaterSize) so
// main.js can swap the import. WATER_EXCLUDED_LAYER + getWaveHeight stay in
// water.js (still imported by grass/dust/physics) — nothing else changes.
// ===========================================================================

const DETAIL_OCTAVES = 2; // Lab "Medium"

// Lake-shape mask: getLakeDistance baked once so the sheet follows the
// bays/headlands (a circular clip can't). Same approach + numbers as water.js.
const LAKE_MASK_RANGE = 150;
const LAKE_CLIP = 106;
function bakeLakeMask() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const z = LAKE_Z + (j / (N - 1) - 0.5) * 2 * LAKE_MASK_RANGE;
    for (let i = 0; i < N; i++) {
      const x = LAKE_X + (i / (N - 1) - 0.5) * 2 * LAKE_MASK_RANGE;
      const d = Math.min(getLakeDistance(x, z), 300);
      const o = (j * N + i) * 4;
      data[o] = Math.round((d / 300) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let lakeMesh = null;
let lakeMaterial = null;
let _scene = null; // for live fog (color + density) each frame

function makeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // NOTE: NOT using three's fog:true / <fog_*> includes — in this setup the
    // fog-chunk path triggered GL_INVALID_OPERATION and the sheet vanished.
    // Fog is applied MANUALLY below, tracking the scene's live FogExp2 color +
    // density (so underwater murk + the fog toggle still affect the water).
    defines: { DETAIL_OCTAVES: String(DETAIL_OCTAVES) },
    uniforms: {
      uTime: { value: 0 },
      // SHARED live refs from atmosphere.js — the analytic sky reflection
      // and sun follow the day/night cycle for free (same trick water.js used).
      uSunDir: { value: sunDirection },
      uSunColor: { value: SUN_COLOR },
      uHorizon: { value: FOG_COLOR },
      uZenith: { value: ZENITH_COLOR },
      // Translucent water: a clear-ish shallow tint absorbing to a deep
      // blue-green. Kept low-ish so the lakebed shows through (Beer's law).
      uShallow: { value: new THREE.Color(0.14, 0.32, 0.34) },
      uDeep: { value: new THREE.Color(0.02, 0.11, 0.15) },
      uAbsorb: { value: 0.42 }, // how fast water turns opaque with depth
      uLakeMask: { value: null },
      uLakeCenter: { value: new THREE.Vector2(LAKE_X, LAKE_Z) },
      uClipRadius: { value: LAKE_CLIP },
      // detail / look
      uDetailStrength: { value: 0.3 },
      uDetailScale: { value: 0.14 },
      uFlowSpeed: { value: 0.05 },
      uWarp: { value: 0.7 },
      uGlint: { value: 1.3 },
      uGlintSharp: { value: 250 },
      // manual fog (updated each frame from the scene's FogExp2)
      uFogColor: { value: new THREE.Color().copy(FOG_COLOR) },
      uFogDensity: { value: 0.012 },
    },
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying vec3 vWorldPos;
      varying float vDepth;
      varying float vViewZ;
      uniform float uTime;

      // EXACT same three Gerstner waves as water.js (keep in sync with the JS
      // getWaveHeight that physics uses — do not retune independently).
      const vec3 W0 = vec3( 0.876,  0.482, 16.0);
      const vec3 W1 = vec3(-0.514,  0.857, 10.0);
      const vec3 W2 = vec3( 0.371, -0.928,  6.0);
      const vec3 WA = vec3(0.085, 0.05, 0.028);
      const vec3 WS = vec3(0.55, 0.85, 1.25);

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float taper = clamp(aDepth / 1.2, 0.0, 1.0);
        vec2 dirs[3]; dirs[0]=W0.xy; dirs[1]=W1.xy; dirs[2]=W2.xy;
        float lens[3]; lens[0]=W0.z; lens[1]=W1.z; lens[2]=W2.z;
        vec3 disp = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          float k = 6.2831853 / lens[i];
          float a = WA[i] * taper;
          float f = k * dot(dirs[i], world.xz) - WS[i] * uTime;
          float c = cos(f);
          disp.y += a * sin(f);
          disp.x += dirs[i].x * a * c * 0.6;
          disp.z += dirs[i].y * a * c * 0.6;
        }
        world.xyz += disp;
        vWorldPos = world.xyz;
        vDepth = max(aDepth + disp.y, 0.0);
        vec4 mv = viewMatrix * world;
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uDetailStrength, uDetailScale, uFlowSpeed, uWarp, uGlint, uGlintSharp;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uShallow, uDeep, uFogColor;
      uniform float uFogDensity, uAbsorb;
      uniform sampler2D uLakeMask;
      uniform vec2 uLakeCenter;
      uniform float uClipRadius;
      varying vec3 vWorldPos;
      varying float vDepth;
      varying float vViewZ;

      const vec3 W0 = vec3( 0.876,  0.482, 16.0);
      const vec3 W1 = vec3(-0.514,  0.857, 10.0);
      const vec3 W2 = vec3( 0.371, -0.928,  6.0);
      const vec3 WA = vec3(0.085, 0.05, 0.028);
      const vec3 WS = vec3(0.55, 0.85, 1.25);

      vec2 swellSlope(vec2 p) {
        vec2 dirs[3]; dirs[0]=W0.xy; dirs[1]=W1.xy; dirs[2]=W2.xy;
        float lens[3]; lens[0]=W0.z; lens[1]=W1.z; lens[2]=W2.z;
        vec2 s = vec2(0.0);
        for (int i = 0; i < 3; i++) {
          float k = 6.2831853 / lens[i];
          float a = WA[i];
          float f = k * dot(dirs[i], p) - WS[i] * uTime;
          s += dirs[i] * (k * a * cos(f));
        }
        return s;
      }

      // FBM detail (value noise) — domain-warped, two flow directions.
      float hash21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
      float vnoiseG(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
      float fbmG(vec2 p){ float s=0.0,amp=0.5,tot=0.0; for(int i=0;i<DETAIL_OCTAVES;i++){ s+=amp*vnoiseG(p); tot+=amp; p*=2.03; amp*=0.5; } return s/max(tot,1e-3); }
      float waterH(vec2 p){ vec2 fp=p*uDetailScale; float t=uTime*uFlowSpeed;
        #if DETAIL_OCTAVES > 1
          vec2 w=vec2(fbmG(fp*0.5+t),fbmG(fp*0.5-t+5.2)); fp+=(w-0.5)*uWarp;
        #endif
        return fbmG(fp+vec2(t,-t*0.7)); }
      vec2 detailSlope(vec2 p){ float e=0.6; float h0=waterH(p);
        return (vec2(waterH(p+vec2(e,0.0)),waterH(p+vec2(0.0,e)))-h0)/e*uDetailStrength; }

      vec3 skyColor(vec3 dir){
        dir = normalize(dir);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.02, 0.5, dir.y));
        float s = max(dot(dir, uSunDir), 0.0);
        sky += uSunColor * pow(s, 350.0) * 1.6;   // tight sun disk reflection
        sky += uSunColor * pow(s, 4.5) * 0.18;     // halo (small — big halo = milky)
        return sky;
      }

      void main() {
        // Clip the sheet to the warped lake outline (discard outside).
        vec2 lakeUV = (vWorldPos.xz - uLakeCenter + 150.0) / 300.0;
        float lakeD = texture2D(uLakeMask, lakeUV).r * 300.0;
        if (lakeD > uClipRadius) discard;

        vec2 slope = swellSlope(vWorldPos.xz) + detailSlope(vWorldPos.xz);
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 V = normalize(cameraPosition - vWorldPos);

        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
        vec3 refl = skyColor(reflect(-V, N));

        // Beer's-law absorption: clear in the shallows (the lakebed shows
        // through), saturating to the deep tint with depth.
        float absorb = 1.0 - exp(-vDepth * uAbsorb);   // 0 shallow -> ~1 deep
        vec3 transmit = mix(uShallow, uDeep, absorb);

        vec3 col = mix(transmit, refl, clamp(fres, 0.0, 1.0));

        // Thin crisp shoreline foam (only the very edge), broken by noise.
        float shore = 1.0 - smoothstep(0.0, 0.18, vDepth);
        float fn = vnoiseG(vWorldPos.xz * 1.5 + uTime * 0.4);
        float foam = shore * smoothstep(0.5, 0.78, fn);
        col = mix(col, vec3(0.90, 0.93, 0.93), clamp(foam, 0.0, 1.0));

        // Sharp sun glint sparkle.
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), uGlintSharp) * uGlint;

        // Manual exp2 fog (matches scene FogExp2) — applied to color only.
        float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
        col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

        // Transparency: see-through in the shallows / head-on (lakebed shows),
        // opaque in the deep, reflective at grazing; foam is opaque. The
        // waterline feathers to nothing.
        float alpha = max(max(fres, absorb), foam);
        alpha *= smoothstep(0.0, 0.12, vDepth);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Public API (matches water.js)
// ---------------------------------------------------------------------------
export function createWater(scene, renderer, camera) {
  _scene = scene; // for live fog each frame
  // Flat sheet over the basin; the baked mask clips it to the waterline.
  // Same geometry as water.js (280 m, centered on the lake).
  const geo = new THREE.PlaneGeometry(280, 280, 112, 112);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const depths = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    depths[i] = LAKE_WATER_Y - getHeight(pos.getX(i) + LAKE_X, pos.getZ(i) + LAKE_Z);
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));

  lakeMaterial = makeMaterial();
  lakeMaterial.uniforms.uLakeMask.value = bakeLakeMask();

  lakeMesh = new THREE.Mesh(geo, lakeMaterial);
  lakeMesh.position.set(LAKE_X, LAKE_WATER_Y, LAKE_Z);
  lakeMesh.renderOrder = 2;
  scene.add(lakeMesh);
}

export function updateWater(elapsedTime) {
  if (!lakeMaterial) return;
  lakeMaterial.uniforms.uTime.value = elapsedTime;
  // Track the scene's live fog (day/night color + underwater murk density).
  if (_scene && _scene.fog) {
    lakeMaterial.uniforms.uFogColor.value.copy(_scene.fog.color);
    if (_scene.fog.density !== undefined) {
      lakeMaterial.uniforms.uFogDensity.value = _scene.fog.density;
    }
  }
}

// No pre-passes in the lab water — these exist only to keep main.js's calls
// valid so the import is a clean one-line swap.
export function prepareWater() {}
export function setWaterSize() {}
