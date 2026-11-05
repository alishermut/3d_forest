// Demo harness for the reusable createSimpleWater() module. Shows it over a
// large area (1km plane) with a small island, so the depth-based shoreline
// foam and the cheap per-pixel cost are both visible. Throwaway page.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSimpleWater } from './simpleWater.js';

const $ = (id) => document.getElementById(id);

const SUN_DIR = new THREE.Vector3(0.35, 0.6, 0.3).normalize();
const SUN_COLOR = new THREE.Color(1.0, 0.96, 0.84);
const HORIZON = new THREE.Color(0.80, 0.87, 0.93);
const ZENITH = new THREE.Color(0.22, 0.48, 0.76);

const WATER_LEVEL = 0;
const SIZE = 1000;
const SEG = 256;

// A gentle island bump so part of the field is shallow -> shoreline foam.
function islandHeight(x, z) {
  const r = Math.sqrt(x * x + z * z);
  const h = (1 - smoothstep(0, 60, r)) * 6.0;          // central island peak
  const ridge = Math.max(0, 4 - r * 0.05) * 0.0;        // (unused, kept simple)
  return h + ridge - 2.5;                                // floor sits below water
}
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

let renderer, scene, camera, controls, clock, water;

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSunDir: { value: SUN_DIR }, uSunColor: { value: SUN_COLOR }, uHorizon: { value: HORIZON }, uZenith: { value: ZENITH } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec3 vDir;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith;
      void main(){
        vec3 d = normalize(vDir);
        float h = smoothstep(-0.1, 0.55, d.y);
        vec3 sky = mix(uHorizon, uZenith, clamp(h,0.0,1.0));
        float s = max(dot(d, uSunDir), 0.0);
        sky += uSunColor * pow(s, 800.0) * 2.0 + uSunColor * pow(s, 6.0) * 0.25;
        gl_FragColor = vec4(sky, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), mat);
}

function makeIsland() {
  const g = new THREE.PlaneGeometry(260, 260, 120, 120);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, islandHeight(pos.getX(i), pos.getZ(i)));
  }
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9c8f6e, roughness: 1.0 });
  return new THREE.Mesh(g, mat);
}

function makeWater() {
  // Build a plane carrying a baked aDepth attribute = waterLevel - floorHeight,
  // exactly how the forest lake would supply terrain depth.
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const depth = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // only the island region has a floor near the surface; open sea is deep
    const floor = (Math.abs(x) < 140 && Math.abs(z) < 140) ? islandHeight(x, z) : -50;
    depth[i] = Math.max(0, WATER_LEVEL - floor);
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  return createSimpleWater({
    geometry: geo,
    waterLevel: WATER_LEVEL,
    sunDir: SUN_DIR, sunColor: SUN_COLOR, horizon: HORIZON, zenith: ZENITH,
    waveAmp: 0.22, waveLen: 10, waveSpeed: 1.0,
  });
}

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON.getHex(), 0.0009);

  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 6000);
  camera.position.set(40, 14, 60);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 10;
  controls.maxDistance = 400;
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x6b5d40, 1.0));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.4);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  scene.add(sun);

  scene.add(makeSky());
  scene.add(makeIsland());
  water = makeWater();
  scene.add(water.mesh);

  $('tris').textContent = (SEG * SEG * 2).toLocaleString();

  clock = new THREE.Clock();
  addEventListener('resize', onResize);
  renderer.setAnimationLoop(loop);

  window.__simple = { renderer, scene, camera, step: loop };
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

let frames = 0, accum = 0, lastMs = 0;
function loop() {
  controls.update();
  water.update(clock.elapsedTime, camera);
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
