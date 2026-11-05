// Highlands — phase 0 scaffold.
//
// A self-contained, isolated boot for the new stylized streamed world. It
// shares NOTHING with the forest (src/main.js): no forest modules, no shared
// scene. The only deps are three + OrbitControls (already installed).
//
// Right now this just proves the subproject lives and renders: a low-poly sky,
// a flat ground plate, and a placeholder peak so there's something 3D in view.
// The terrain engine, streaming, and everything else land in later phases
// (see games/highlands/PLAN.md). Nothing here is meant to survive past phase 1 —
// it's the skeleton we hang the real systems on.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const app = document.getElementById('app');

// --- Renderer (WebGL — same stack as the forest, by design) ---------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0xaacbe6); // hazy sky blue
app.appendChild(renderer.domElement);

// --- Scene + stylized atmosphere ------------------------------------------
const scene = new THREE.Scene();
// Fog doubles as mood + (later) the streaming-frontier hider.
scene.fog = new THREE.Fog(0xaacbe6, 120, 600);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  2000
);
camera.position.set(80, 60, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 20, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495; // don't dip under the ground

// --- Lighting: flat, stylized (hemisphere fill + a low sun) ----------------
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a5a3a, 0.9));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.1);
sun.position.set(120, 180, 60);
scene.add(sun);

// --- Placeholder ground plate (flat-shaded low-poly look) ------------------
// A real streamed heightfield replaces this in phase 1. The MeshStandardMaterial
// with flatShading is the look we'll keep — bold facets, no textures.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1200, 1200, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x6b8f4e, flatShading: true })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// --- Placeholder peak so there's something to orbit ------------------------
const peak = new THREE.Mesh(
  new THREE.ConeGeometry(60, 110, 5), // 5-sided = chunky low-poly
  new THREE.MeshStandardMaterial({ color: 0x8a8f97, flatShading: true })
);
peak.position.set(0, 55, 0);
scene.add(peak);
// Snow cap — altitude tinting, by hand for now (procedural by height in phase 2).
const cap = new THREE.Mesh(
  new THREE.ConeGeometry(26, 40, 5),
  new THREE.MeshStandardMaterial({ color: 0xeef3f7, flatShading: true })
);
cap.position.set(0, 90, 0);
scene.add(cap);

// --- Resize ----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop ------------------------------------------------------------------
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
