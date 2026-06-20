// ===========================================================================
// Water Lab v2 — ONE water, scaled from pool-grade (Ultra) down to cheap (Low).
//
// Ultra turns on the full pool pipeline:
//   • interactive height-field ripple SIM (click/drag = droplets)
//   • REFRACTION of the lake bed through the surface
//   • CAUSTICS on the bed
//   • FBM (multi-octave + domain-warp) detail normals  — no tiling
//   • Gerstner swell
// Lower presets switch those features off / down (sim res, caustics, octaves,
// waves, tessellation, resolution scale) so you can find the cheapest setting
// that still looks right. Perf HUD + 5s benchmark + save-as-reference.
//
// Everything is indexed in one normalized FIELD space:
//   fieldUV(x,z) = vec2(x,z)/(2*AREA) + 0.5
// The sim texture, caustic texture, and baked bed texture all live in it, so
// there are no rotateX/uv-flip mismatches (the bug from the first pool).
// ===========================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

const $ = (id) => document.getElementById(id);

const AREA = 26;          // water/lake half-extent (world units) -> 52m field
const BED_Y = -7;         // flat reference plane caustics project onto
const IOR = 1.0 / 1.33;

const SUN_DIR = new THREE.Vector3(0.35, 0.62, 0.30).normalize();
const LIGHT_DIR = SUN_DIR.clone().negate();          // into the water
const SUN_COLOR = new THREE.Color(1.0, 0.96, 0.84);
const HORIZON = new THREE.Color(0.80, 0.87, 0.93);
const ZENITH = new THREE.Color(0.22, 0.48, 0.76);

// --- Parameters (defaults = High) ------------------------------------------
const DEFAULTS = {
  preset: 'High',
  // structural
  segments: 160, gerstnerWaves: 4, detailOctaves: 3,
  simRes: 256, causticRes: 512, refraction: true, caustics: true, foam: true,
  resolutionScale: 1.0,
  // continuous — waves
  waveAmp: 0.18, waveLen: 12.0, waveSpeed: 1.0, choppiness: 0.5,
  // continuous — detail
  detailStrength: 0.35, detailScale: 0.18, flowSpeed: 0.05, warp: 0.7,
  // continuous — optics
  fresnelPower: 5.0, sunGlint: 1.6, glintSharpness: 320, refractStrength: 0.25,
  causticGain: 0.6,
  deep: '#06212c', shallow: '#2c6b72', tint: '#0d3a40',
};
const PRESETS = {
  Low:    { segments: 64,  gerstnerWaves: 2, detailOctaves: 1, simRes: 0,   causticRes: 0,   refraction: false, caustics: false, foam: false, resolutionScale: 0.75 },
  Medium: { segments: 96,  gerstnerWaves: 3, detailOctaves: 2, simRes: 128, causticRes: 0,   refraction: true,  caustics: false, foam: true,  resolutionScale: 1.0 },
  High:   { segments: 160, gerstnerWaves: 4, detailOctaves: 3, simRes: 256, causticRes: 256, refraction: true,  caustics: true,  foam: true,  resolutionScale: 1.0 },
  Ultra:  { segments: 224, gerstnerWaves: 5, detailOctaves: 4, simRes: 256, causticRes: 512, refraction: true,  caustics: true,  foam: true,  resolutionScale: 2.0 },
};

const params = Object.assign({}, DEFAULTS, loadJSON('waterlab.current') || {});

let renderer, scene, camera, controls, clock, gui;
let water = null, terrain = null, bedRT = null;
let simA, simB, normalRT, simUpdateMat, dropMat, normalMat, fsQuad, fsScene, fsCam;
let causticRT, causticScene, causticCam, causticGrid;

// ===========================================================================
// Terrain (rough land + lake bed) — JS value-noise FBM
// ===========================================================================
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y) { let s = 0, amp = 0.5, f = 1; for (let i = 0; i < 5; i++) { s += amp * vnoise(x * f, y * f); f *= 2.0; amp *= 0.5; } return s; }
function terrainHeight(x, z) {
  let h = (fbm2(x * 0.05 + 11, z * 0.05 + 7) - 0.5) * 7.0;     // rough undulating bed
  const r = Math.hypot(x, z);
  h += Math.max(0, 1 - r / 15) * 7.5;                          // central island
  h += Math.max(0, 1 - Math.hypot(x - 20, z + 10) / 12) * 5.0; // a bank
  h += (fbm2(x * 0.25, z * 0.25) - 0.5) * 1.2;                 // fine roughness
  return h - 3.2;                                              // most below water (y=0)
}

function makeTerrain() {
  const N = 220;
  const g = new THREE.PlaneGeometry(2 * AREA, 2 * AREA, N, N);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  g.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uArea: { value: AREA }, uCaustic: { value: null }, uUseCaustic: { value: 1 },
      uSunDir: { value: SUN_DIR }, uCausticGain: { value: params.causticGain },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vN;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vWorld = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorld; varying vec3 vN;
      uniform float uArea, uUseCaustic, uCausticGain; uniform sampler2D uCaustic; uniform vec3 uSunDir;
      vec3 albedo(float y){
        vec3 deepBed = vec3(0.20,0.26,0.28);
        vec3 sand    = vec3(0.74,0.66,0.46);
        vec3 grass   = vec3(0.32,0.40,0.20);
        vec3 rock    = vec3(0.42,0.38,0.33);
        vec3 c = mix(deepBed, sand, smoothstep(-4.0,-0.2,y));   // bed -> shore sand
        c = mix(c, grass, smoothstep(0.1,1.2,y));               // shore -> land
        c = mix(c, rock, smoothstep(2.5,5.0,y));                // higher -> rock
        return c;
      }
      void main(){
        vec3 c = albedo(vWorld.y);
        float light = clamp(dot(normalize(vN), uSunDir)*0.6+0.5, 0.2, 1.0);
        c *= light;
        if (uUseCaustic > 0.5 && vWorld.y < 0.0){
          vec2 uv = vWorld.xz/(2.0*uArea)+0.5;
          float ca = texture2D(uCaustic, uv).r;
          float fade = smoothstep(0.0,-3.0, vWorld.y)*0.0 + (1.0 - smoothstep(-4.0,0.0,vWorld.y))*0.0; // keep simple
          c *= (0.55 + ca * uCausticGain);
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(g, mat);
}

// Bake bed albedo (rgb) + height (a) into a field-space texture for refraction.
function bakeBed() {
  if (!bedRT) bedRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, depthBuffer: true });
  const bakeMat = new THREE.ShaderMaterial({
    uniforms: { uArea: { value: AREA }, uBedY: { value: BED_Y } },
    vertexShader: /* glsl */ `
      varying float vY;
      uniform float uArea;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vY = w.y;
        gl_Position = vec4(w.x/uArea, w.z/uArea, 0.0, 1.0); // straight into field space
      }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying float vY; uniform float uBedY;
      vec3 albedo(float y){
        vec3 deepBed = vec3(0.20,0.26,0.28);
        vec3 sand    = vec3(0.74,0.66,0.46);
        vec3 grass   = vec3(0.32,0.40,0.20);
        vec3 c = mix(deepBed, sand, smoothstep(-4.0,-0.2,y));
        c = mix(c, grass, smoothstep(0.1,1.2,y));
        return c;
      }
      void main(){ gl_FragColor = vec4(albedo(vY), (vY - uBedY)/12.0); }`,
    side: THREE.DoubleSide,
  });
  const prevMat = terrain.material;
  terrain.material = bakeMat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(bedRT);
  renderer.setClearColor(0x202628, 1); renderer.clear();
  renderer.render(terrain, fsCam);   // any cam; vertex writes clip directly
  renderer.setRenderTarget(prev);
  terrain.material = prevMat;
  bakeMat.dispose();
}

// ===========================================================================
// Ripple simulation (ping-pong) — only built when params.simRes > 0
// ===========================================================================
const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`;
function makeRT(res) {
  return new THREE.WebGLRenderTarget(res, res, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
  });
}
function disposeSim() {
  for (const rt of [simA, simB, normalRT, causticRT]) rt?.dispose();
  simA = simB = normalRT = causticRT = null;
}
function initSim() {
  disposeSim();
  if (!params.simRes) return;
  const R = params.simRes;
  simA = makeRT(R); simB = makeRT(R); normalRT = makeRT(R);

  if (!fsScene) { fsScene = new THREE.Scene(); fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); fsScene.add(fsQuad); fsCam = new THREE.Camera(); }

  simUpdateMat = simUpdateMat || new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uTexel: { value: 1 / R } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D uState; uniform float uTexel;
      void main(){
        vec2 d = vec2(uTexel,0.0);
        vec2 s = texture2D(uState,vUv).rg; float h=s.r, v=s.g;
        float hl=texture2D(uState,vUv-d.xy).r, hr=texture2D(uState,vUv+d.xy).r;
        float hd=texture2D(uState,vUv-d.yx).r, hu=texture2D(uState,vUv+d.yx).r;
        v += ((hl+hr+hd+hu)*0.25 - h) * 1.4; v *= 0.992; h += v;
        vec2 e=min(vUv,1.0-vUv); h *= smoothstep(0.0,0.02,min(e.x,e.y));
        gl_FragColor = vec4(h,v,0.0,1.0);
      }`,
  });
  simUpdateMat.uniforms.uTexel.value = 1 / R;
  dropMat = dropMat || new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 0.03 }, uStrength: { value: 0.5 } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D uState; uniform vec2 uCenter; uniform float uRadius, uStrength;
      void main(){ vec4 s=texture2D(uState,vUv); float dd=length(vUv-uCenter); float drop=max(0.0,1.0-dd/uRadius); drop=0.5-cos(drop*3.14159265)*0.5; s.r+=uStrength*drop; gl_FragColor=s; }`,
  });
  normalMat = normalMat || new THREE.ShaderMaterial({
    uniforms: { uState: { value: null }, uTexel: { value: 1 / R } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D uState; uniform float uTexel;
      void main(){
        vec2 d=vec2(uTexel,0.0);
        float hl=texture2D(uState,vUv-d.xy).r, hr=texture2D(uState,vUv+d.xy).r;
        float hd=texture2D(uState,vUv-d.yx).r, hu=texture2D(uState,vUv+d.yx).r;
        float dx=2.0*uTexel*${(2 * AREA).toFixed(1)};
        gl_FragColor = vec4(normalize(vec3(-(hr-hl)/(2.0*dx),1.0,-(hu-hd)/(2.0*dx))),1.0);
      }`,
  });
  normalMat.uniforms.uTexel.value = 1 / R;

  const clear = new THREE.MeshBasicMaterial({ color: 0x000000 });
  fsQuad.material = clear;
  for (const rt of [simA, simB, normalRT]) { renderer.setRenderTarget(rt); renderer.render(fsScene, fsCam); }
  renderer.setRenderTarget(null);

  if (params.caustics && params.causticRes) initCaustics();
}
function runPass(mat, target, src) { fsQuad.material = mat; if (src !== undefined) mat.uniforms.uState.value = src; renderer.setRenderTarget(target); renderer.render(fsScene, fsCam); renderer.setRenderTarget(null); }
const _drops = [];
function stepSim() {
  if (!params.simRes) return;
  while (_drops.length) { const dr = _drops.shift(); dropMat.uniforms.uCenter.value.set(dr.x, dr.y); dropMat.uniforms.uStrength.value = dr.s; dropMat.uniforms.uRadius.value = dr.r; runPass(dropMat, simB, simA.texture); [simA, simB] = [simB, simA]; }
  runPass(simUpdateMat, simB, simA.texture); [simA, simB] = [simB, simA];
  runPass(normalMat, normalRT, simA.texture);
}

function initCaustics() {
  causticRT?.dispose();
  causticRT = makeRT(params.causticRes);
  if (!causticScene) {
    causticScene = new THREE.Scene(); causticCam = new THREE.Camera();
    const geo = new THREE.PlaneGeometry(2, 2, 200, 200); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
      uniforms: { uSim: { value: null }, uNormal: { value: null }, uLightDir: { value: LIGHT_DIR }, uArea: { value: AREA }, uBedY: { value: BED_Y } },
      vertexShader: /* glsl */ `
        precision highp float; uniform sampler2D uSim, uNormal; uniform vec3 uLightDir; uniform float uArea, uBedY;
        varying vec3 vOld, vNew;
        void main(){
          vec2 uv = uv;
          float h = texture2D(uSim, uv).r; vec3 n = texture2D(uNormal, uv).xyz;
          vec3 surf = vec3(position.x*uArea, h, position.z*uArea);
          vec3 refr = refract(uLightDir, n, ${IOR.toFixed(5)});
          float t = (uBedY - surf.y) / refr.y;
          vec3 land = surf + refr * t;
          vOld = vec3(position.x*uArea, position.z*uArea, 0.0);
          vNew = vec3(land.x, land.z, 0.0);
          gl_Position = vec4(land.x/uArea, land.z/uArea, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float; varying vec3 vOld, vNew;
        void main(){
          float oldA = length(dFdx(vOld))*length(dFdy(vOld));
          float newA = length(dFdx(vNew))*length(dFdy(vNew));
          gl_FragColor = vec4(vec3(clamp(oldA/max(newA,1e-6),0.0,6.0)),1.0);
        }`,
    });
    causticGrid = new THREE.Mesh(geo, mat); causticGrid.frustumCulled = false; causticScene.add(causticGrid);
  }
}
function renderCaustics() {
  if (!(params.caustics && params.causticRes && params.simRes)) return;
  causticGrid.material.uniforms.uSim.value = simA.texture;
  causticGrid.material.uniforms.uNormal.value = normalRT.texture;
  renderer.setRenderTarget(causticRT); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(causticScene, causticCam); renderer.setRenderTarget(null);
}

// ===========================================================================
// Water surface
// ===========================================================================
const WAVE_GLSL = /* glsl */ `
  void waveParams(int i, out vec2 dir, out float k, out float a, out float spd){
    float fi=float(i); float ang=fi*2.39996; dir=vec2(cos(ang),sin(ang));
    k = 6.2831853/(uWaveLen*pow(0.62,fi)); a = uWaveAmp*pow(0.68,fi); spd = 1.0+fi*0.35;
  }`;
const FBM_GLSL = /* glsl */ `
  float hash21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
  float vnoiseG(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
  float fbmG(vec2 p){ float s=0.0,amp=0.5,tot=0.0; for(int i=0;i<DETAIL_OCTAVES;i++){ s+=amp*vnoiseG(p); tot+=amp; p*=2.03; amp*=0.5; } return s/max(tot,1e-3); }`;

function buildWater() {
  if (water) { scene.remove(water.mesh); water.mesh.geometry.dispose(); water.mesh.material.dispose(); }
  const seg = params.segments;
  const geo = new THREE.PlaneGeometry(2 * AREA, 2 * AREA, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const depth = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) depth[i] = Math.max(0, 0 - terrainHeight(pos.getX(i), pos.getZ(i)));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  const useRipple = params.simRes > 0;
  const useRefr = params.refraction;
  const useCaustic = params.caustics && params.causticRes > 0 && useRipple;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    defines: {
      GERSTNER_WAVES: String(params.gerstnerWaves),
      DETAIL_OCTAVES: String(params.detailOctaves),
      USE_RIPPLE: useRipple ? '1' : '0',
      USE_REFRACTION: useRefr ? '1' : '0',
      USE_CAUSTIC: useCaustic ? '1' : '0',
      USE_FOAM: params.foam ? '1' : '0',
    },
    uniforms: {
      uTime: { value: 0 }, uArea: { value: AREA },
      uSunDir: { value: SUN_DIR }, uSunColor: { value: SUN_COLOR }, uHorizon: { value: HORIZON }, uZenith: { value: ZENITH },
      uDeep: { value: new THREE.Color(params.deep) }, uShallow: { value: new THREE.Color(params.shallow) }, uTint: { value: new THREE.Color(params.tint) },
      uCamPos: { value: new THREE.Vector3() },
      uWaveAmp: { value: params.waveAmp }, uWaveLen: { value: params.waveLen }, uWaveSpeed: { value: params.waveSpeed }, uChop: { value: params.choppiness },
      uDetailStrength: { value: params.detailStrength }, uDetailScale: { value: params.detailScale }, uFlowSpeed: { value: params.flowSpeed }, uWarp: { value: params.warp },
      uFresnelPow: { value: params.fresnelPower }, uSunGlint: { value: params.sunGlint }, uGlintSharp: { value: params.glintSharpness },
      uRefractStrength: { value: params.refractStrength }, uCausticGain: { value: params.causticGain },
      uSim: { value: useRipple ? simA.texture : null }, uNormalTex: { value: useRipple ? normalRT.texture : null },
      uBed: { value: bedRT.texture }, uCaustic: { value: useCaustic ? causticRT.texture : null }, uTexel: { value: useRipple ? 1 / params.simRes : 0 },
    },
    vertexShader: /* glsl */ `
      precision highp float;
      attribute float aDepth;
      uniform float uTime, uWaveAmp, uWaveLen, uWaveSpeed, uChop, uArea;
      #if USE_RIPPLE
        uniform sampler2D uSim;
      #endif
      varying vec3 vWorld; varying float vDepth;
      ${WAVE_GLSL}
      void main(){
        vec4 world = modelMatrix * vec4(position,1.0);
        vDepth = aDepth; float taper = clamp(aDepth/1.0,0.0,1.0);
        float t = uTime*uWaveSpeed; vec3 disp=vec3(0.0);
        for(int i=0;i<GERSTNER_WAVES;i++){ vec2 dir; float k,a,spd; waveParams(i,dir,k,a,spd); a*=taper;
          float f=k*dot(dir,world.xz)-spd*t; float c=cos(f); disp.y+=a*sin(f); disp.x+=dir.x*a*c*uChop; disp.z+=dir.y*a*c*uChop; }
        world.xyz += disp;
        #if USE_RIPPLE
          vec2 fuv = world.xz/(2.0*uArea)+0.5;
          world.y += texture2D(uSim, fuv).r * taper;
        #endif
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uWaveLen, uWaveSpeed, uWaveAmp, uArea;
      uniform float uDetailStrength, uDetailScale, uFlowSpeed, uWarp;
      uniform float uFresnelPow, uSunGlint, uGlintSharp, uRefractStrength, uCausticGain;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uDeep, uShallow, uTint, uCamPos;
      uniform sampler2D uBed;
      #if USE_RIPPLE
        uniform sampler2D uNormalTex; uniform float uTexel; uniform sampler2D uSim;
      #endif
      #if USE_CAUSTIC
        uniform sampler2D uCaustic;
      #endif
      varying vec3 vWorld; varying float vDepth;
      ${WAVE_GLSL}
      ${FBM_GLSL}
      vec2 swellSlope(vec2 p, float taper){ vec2 s=vec2(0.0); float t=uTime*uWaveSpeed;
        for(int i=0;i<GERSTNER_WAVES;i++){ vec2 dir; float k,a,spd; waveParams(i,dir,k,a,spd); a*=taper; float f=k*dot(dir,p)-spd*t; s+=dir*(k*a*cos(f)); } return s; }
      float waterH(vec2 p){ vec2 fp=p*uDetailScale; float t=uTime*uFlowSpeed;
        #if DETAIL_OCTAVES > 1
          vec2 w=vec2(fbmG(fp*0.5+t),fbmG(fp*0.5-t+5.2)); fp+=(w-0.5)*uWarp;
        #endif
        return fbmG(fp+vec2(t,-t*0.7)); }
      vec2 detailSlope(vec2 p){
        #if DETAIL_OCTAVES > 0
          float e=0.6; float h0=waterH(p); return (vec2(waterH(p+vec2(e,0.0)),waterH(p+vec2(0.0,e)))-h0)/e*uDetailStrength;
        #else
          return vec2(0.0);
        #endif
      }
      vec3 skyColor(vec3 dir){ dir=normalize(dir); float h=smoothstep(-0.1,0.55,dir.y);
        vec3 sky=mix(uHorizon,uZenith,clamp(h,0.0,1.0)); float s=max(dot(dir,uSunDir),0.0);
        sky+=uSunColor*pow(s,800.0)*2.0; sky+=uSunColor*pow(s,6.0)*0.25; return sky; }
      void main(){
        float taper = clamp(vDepth/1.0,0.0,1.0);
        vec2 slope = swellSlope(vWorld.xz, taper) + detailSlope(vWorld.xz);
        vec2 fuv = vWorld.xz/(2.0*uArea)+0.5;
        float disturb = 0.0;
        #if USE_RIPPLE
          vec3 rn = texture2D(uNormalTex, fuv).xyz; slope += -rn.xz/max(rn.y,0.2) * 1.0;
          float e = uTexel; disturb = abs(texture2D(uSim,fuv+vec2(e,0.0)).r - texture2D(uSim,fuv-vec2(e,0.0)).r);
        #endif
        vec3 N = normalize(vec3(-slope.x,1.0,-slope.y));
        vec3 V = normalize(uCamPos - vWorld);
        float fres = 0.02 + 0.98*pow(1.0-max(dot(V,N),0.0), uFresnelPow);
        vec3 refl = skyColor(reflect(-V,N));

        // ---- body color ----
        vec3 body;
        #if USE_REFRACTION
          vec2 buv = clamp(fuv + N.xz * uRefractStrength * clamp(vDepth,0.0,1.0), 0.0, 1.0);
          vec4 bed = texture2D(uBed, buv);
          float bedY = bed.a * 12.0 + (${BED_Y.toFixed(1)});
          float wd = clamp(-bedY, 0.0, 8.0);
          vec3 bedLit = bed.rgb;
          #if USE_CAUSTIC
            bedLit *= (0.55 + texture2D(uCaustic, buv).r * uCausticGain);
          #endif
          body = mix(bedLit, uTint, 1.0 - exp(-wd * 0.32));
        #else
          float d = clamp(vDepth/3.5,0.0,1.0); body = mix(uShallow, uDeep, d);
        #endif

        float alpha = smoothstep(0.0, 0.25, vDepth);

        #if USE_FOAM
          // shoreline foam broken up by noise (not a regular sine band)
          float shore = 1.0 - smoothstep(0.0, 0.6, vDepth);
          float fn = vnoiseG(vWorld.xz*0.8 + uTime*0.3);
          float foam = shore * smoothstep(0.35,0.8,fn);
          foam += smoothstep(0.02,0.08,disturb);           // foam on ripple crests
          body = mix(body, vec3(0.85,0.9,0.92), clamp(foam,0.0,1.0)*0.7);
        #endif

        vec3 col = mix(body, refl, clamp(fres,0.0,1.0));
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(N,H),0.0), uGlintSharp) * uSunGlint;
        gl_FragColor = vec4(col, alpha);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; scene.add(mesh);
  water = { mesh, material: mat };
  $('tris').textContent = (seg * seg * 2).toLocaleString();
}

function syncUniforms() {
  if (!water) return; const u = water.material.uniforms;
  u.uWaveAmp.value = params.waveAmp; u.uWaveLen.value = params.waveLen; u.uWaveSpeed.value = params.waveSpeed; u.uChop.value = params.choppiness;
  u.uDetailStrength.value = params.detailStrength; u.uDetailScale.value = params.detailScale; u.uFlowSpeed.value = params.flowSpeed; u.uWarp.value = params.warp;
  u.uFresnelPow.value = params.fresnelPower; u.uSunGlint.value = params.sunGlint; u.uGlintSharp.value = params.glintSharpness;
  u.uRefractStrength.value = params.refractStrength; u.uCausticGain.value = params.causticGain;
  u.uDeep.value.set(params.deep); u.uShallow.value.set(params.shallow); u.uTint.value.set(params.tint);
  if (terrain) terrain.material.uniforms.uCausticGain.value = params.causticGain;
}
function applyResolution() { renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * params.resolutionScale); updateResHud(); }

function rebuildAll() {
  if (params.caustics && !params.simRes) params.simRes = 256; // caustics need the sim
  initSim();
  if (terrain) terrain.material.uniforms.uUseCaustic.value = (params.caustics && params.causticRes) ? 1 : 0;
  buildWater(); applyResolution(); syncUniforms();
}

function applyPreset(name) { Object.assign(params, PRESETS[name]); params.preset = name; rebuildAll(); refreshGUI(); $('preset').textContent = name; saveCurrent(); }
function markCustom() { params.preset = 'Custom'; $('preset').textContent = 'Custom'; }

// ===========================================================================
// Persistence / benchmark
// ===========================================================================
function saveJSON(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch {} }
function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function saveCurrent() { saveJSON('waterlab.current', params); }
function saveReference() {
  saveJSON('waterlab.reference', params);
  const json = JSON.stringify(params, null, 2);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = `water-${params.preset}-ref.json`; a.click(); URL.revokeObjectURL(a.href);
  navigator.clipboard?.writeText(json).catch(() => {}); flashBench('saved reference + JSON copied');
}
function loadReference() { const r = loadJSON('waterlab.reference'); if (!r) { flashBench('no reference saved'); return; } Object.assign(params, r); rebuildAll(); refreshGUI(); $('preset').textContent = params.preset; flashBench('reference loaded'); }

let bench = null; const results = [];
function startBenchmark(sec = 5) { if (bench) return; bench = { until: clock.elapsedTime + sec, frames: [], label: params.preset }; flashBench(`benchmarking ${sec}s…`); }
function finishBenchmark() {
  const dts = bench.frames.slice().sort((a, b) => a - b); const n = dts.length || 1;
  const avg = dts.reduce((s, x) => s + x, 0) / n; const low = dts[Math.floor(n * 0.99)] || avg;
  results.unshift({ label: bench.label, fps: Math.round(1000 / avg), low: Math.round(1000 / low), seg: params.segments, waves: params.gerstnerWaves, oct: params.detailOctaves, sim: params.simRes, caustic: params.causticRes, refr: params.refraction ? 1 : 0, res: params.resolutionScale + 'x', calls: renderer.info.render.calls });
  renderResults(); flashBench(`${bench.label}: ${results[0].fps} fps (1% low ${results[0].low})`); bench = null;
}
function renderResults() {
  const tb = $('restable').querySelector('tbody');
  if (!results.length) { tb.innerHTML = '<tr class="empty"><td colspan="5">run a benchmark to record a row</td></tr>'; return; }
  let html = '<tr><th>cfg</th><th>fps</th><th>1%low</th><th>sim/ca</th><th>calls</th></tr>';
  for (const r of results) html += `<tr><td>${r.label} s${r.seg}/w${r.waves}/o${r.oct}/${r.res}</td><td>${r.fps}</td><td>${r.low}</td><td>${r.sim || '–'}/${r.caustic || '–'}</td><td>${r.calls}</td></tr>`;
  tb.innerHTML = html;
}
function exportResults() { if (!results.length) { flashBench('no results'); return; } navigator.clipboard?.writeText(JSON.stringify(results, null, 2)).catch(() => {}); flashBench('results JSON copied'); }
let flashT = 0; function flashBench(m) { $('bench').textContent = m; flashT = clock ? clock.elapsedTime : 0; }

// ===========================================================================
// GUI
// ===========================================================================
function refreshGUI() { gui.controllersRecursive().forEach((c) => c.updateDisplay()); }
function buildGUI() {
  gui = new GUI({ title: 'Water Lab' });
  gui.add(params, 'preset', Object.keys(PRESETS)).name('Quality preset').onChange((v) => applyPreset(v));

  const f1 = gui.addFolder('Complexity (rebuilds)');
  const struct = () => { markCustom(); rebuildAll(); saveCurrent(); };
  f1.add(params, 'segments', [32, 48, 64, 96, 128, 160, 224, 320]).name('tessellation').onChange(struct);
  f1.add(params, 'gerstnerWaves', 1, 8, 1).name('gerstner waves').onFinishChange(struct);
  f1.add(params, 'detailOctaves', 0, 6, 1).name('detail octaves').onFinishChange(struct);
  f1.add(params, 'simRes', [0, 128, 256, 512]).name('ripple sim res (0=off)').onChange(struct);
  f1.add(params, 'caustics').name('caustics').onChange(struct);
  f1.add(params, 'causticRes', [256, 512]).name('caustic res').onChange(struct);
  f1.add(params, 'refraction').name('refraction').onChange(struct);
  f1.add(params, 'foam').name('shoreline foam').onChange(struct);
  f1.add(params, 'resolutionScale', 0.5, 2.0, 0.05).name('resolution scale').onChange(() => { markCustom(); applyResolution(); saveCurrent(); });

  const live = () => { markCustom(); syncUniforms(); saveCurrent(); };
  const f2 = gui.addFolder('Waves');
  f2.add(params, 'waveAmp', 0, 0.8, 0.01).onChange(live); f2.add(params, 'waveLen', 2, 40, 0.5).onChange(live);
  f2.add(params, 'waveSpeed', 0, 3, 0.05).onChange(live); f2.add(params, 'choppiness', 0, 1.2, 0.05).onChange(live);
  const f3 = gui.addFolder('Detail / ripples');
  f3.add(params, 'detailStrength', 0, 1.0, 0.01).onChange(live); f3.add(params, 'detailScale', 0.02, 0.5, 0.01).onChange(live);
  f3.add(params, 'flowSpeed', 0, 0.3, 0.005).onChange(live); f3.add(params, 'warp', 0, 2, 0.05).onChange(live);
  f3.add(params, 'refractStrength', 0, 1.0, 0.02).name('refract distort').onChange(live);
  f3.add(params, 'causticGain', 0, 1.5, 0.05).name('caustic gain').onChange(live);
  const f4 = gui.addFolder('Optics / color'); f4.close();
  f4.add(params, 'fresnelPower', 1, 8, 0.1).onChange(live); f4.add(params, 'sunGlint', 0, 4, 0.1).onChange(live);
  f4.add(params, 'glintSharpness', 50, 800, 10).onChange(live);
  f4.addColor(params, 'deep').onChange(live); f4.addColor(params, 'shallow').onChange(live); f4.addColor(params, 'tint').onChange(live);
  const f5 = gui.addFolder('Benchmark / save');
  f5.add({ x: () => startBenchmark(5) }, 'x').name('▶ benchmark 5s');
  f5.add({ x: () => exportResults() }, 'x').name('copy results JSON');
  f5.add({ x: () => saveReference() }, 'x').name('★ save as reference');
  f5.add({ x: () => loadReference() }, 'x').name('load reference');
}

// ===========================================================================
// Pointer -> droplets
// ===========================================================================
function setupPointer() {
  const ray = new THREE.Raycaster(); const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); const hit = new THREE.Vector3(); let down = false;
  const cast = (e, s, r) => {
    if (!params.simRes) return;
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    if (Math.abs(hit.x) > AREA || Math.abs(hit.z) > AREA) return;
    _drops.push({ x: hit.x / (2 * AREA) + 0.5, y: hit.z / (2 * AREA) + 0.5, s, r });
  };
  renderer.domElement.addEventListener('pointerdown', (e) => { down = true; cast(e, 0.8, 0.05); });
  renderer.domElement.addEventListener('pointermove', (e) => { if (down) cast(e, 0.22, 0.035); });
  addEventListener('pointerup', () => { down = false; });
}

// ===========================================================================
// Boot
// ===========================================================================
function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSunDir: { value: SUN_DIR }, uSunColor: { value: SUN_COLOR }, uHorizon: { value: HORIZON }, uZenith: { value: ZENITH } },
    vertexShader: `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `precision highp float; varying vec3 vDir; uniform vec3 uSunDir,uSunColor,uHorizon,uZenith;
      void main(){ vec3 d=normalize(vDir); float h=smoothstep(-0.1,0.55,d.y); vec3 sky=mix(uHorizon,uZenith,clamp(h,0.0,1.0));
        float s=max(dot(d,uSunDir),0.0); sky+=uSunColor*pow(s,800.0)*2.0+uSunColor*pow(s,6.0)*0.25; gl_FragColor=vec4(sky,1.0); }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), mat);
}

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1; renderer.info.autoReset = false;
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color(0xbcd2e0);
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 8000); camera.position.set(34, 20, 46);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, -1, 0);
  controls.maxPolarAngle = Math.PI * 0.495; controls.minDistance = 10; controls.maxDistance = 300; controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x55300, 1.0));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.3); sun.position.copy(SUN_DIR).multiplyScalar(100); scene.add(sun);
  scene.add(makeSky());

  clock = new THREE.Clock();
  // need fsScene/fsCam before bake/sim:
  fsScene = new THREE.Scene(); fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); fsScene.add(fsQuad); fsCam = new THREE.Camera();

  terrain = makeTerrain(); scene.add(terrain);
  bakeBed();
  initSim();
  if (terrain) terrain.material.uniforms.uCaustic.value = causticRT ? causticRT.texture : null;
  buildWater(); applyResolution();
  if (terrain) terrain.material.uniforms.uUseCaustic.value = (params.caustics && params.causticRes) ? 1 : 0;
  buildGUI(); $('preset').textContent = params.preset;
  setupPointer();
  // seed a couple of droplets
  if (params.simRes) { _drops.push({ x: 0.45, y: 0.5, s: 0.7, r: 0.05 }); _drops.push({ x: 0.6, y: 0.58, s: 0.6, r: 0.04 }); }

  addEventListener('resize', onResize);
  renderer.setAnimationLoop(loop);
  window.__lab = { renderer, scene, camera, step: loop, params, startBenchmark, results, applyPreset };
}
function onResize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); updateResHud(); }
function updateResHud() { const dpr = renderer.getPixelRatio(); $('res').textContent = `${Math.round(innerWidth * dpr)}×${Math.round(innerHeight * dpr)}`; }

let frames = 0, accum = 0, lastMs = 0;
function loop() {
  const dt = clock.getDelta(); controls.update();
  for (let i = 0; i < 2; i++) stepSim();
  renderCaustics();
  if (terrain && causticRT) terrain.material.uniforms.uCaustic.value = causticRT.texture;
  if (water) {
    const u = water.material.uniforms; u.uTime.value = clock.elapsedTime; camera.getWorldPosition(u.uCamPos.value);
    if (params.simRes) { u.uSim.value = simA.texture; u.uNormalTex.value = normalRT.texture; }
    if (params.caustics && causticRT) u.uCaustic.value = causticRT.texture;
  }
  renderer.info.reset();
  renderer.setClearColor(0xbcd2e0, 1);
  renderer.render(scene, camera);
  $('calls').textContent = renderer.info.render.calls;

  if (bench) { bench.frames.push(dt * 1000); if (clock.elapsedTime >= bench.until) finishBenchmark(); }
  const now = performance.now(); if (lastMs) { accum += now - lastMs; frames++; } lastMs = now;
  if (accum >= 250) { const a = accum / frames; $('fps').textContent = String(Math.round(1000 / a)); $('ms').textContent = a.toFixed(1) + ' ms'; accum = 0; frames = 0; }
  if (flashT && clock.elapsedTime - flashT > 4) { $('bench').textContent = 'click/drag water = droplets · drag = orbit'; flashT = 0; }
}

init();
