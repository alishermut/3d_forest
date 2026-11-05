// Voxelcraft — Phase 12: day/night cycle + sky.
//
// A 20-minute day (24,000 ticks at 20 ticks/sec). The sun rises in the east
// (+X) at tick 0 (06:00), arcs to zenith at tick 6000 (noon), sets in the west
// (-X) at tick 12000 (18:00). Night is tick 13000–23000. The moon follows the
// opposite arc.
//
// Sky color is keyframe-interpolated (day blue → dusk orange → dusk purple →
// night dark blue → dawn purple → dawn orange → day blue). Sun directional
// light intensity follows the sun's height above the horizon. Stars (Points)
// fade in at night.
//
// Sun/moon are rendered as unlit spheres positioned far away in their
// respective directions, following the camera so they always appear "at
// infinity".

import * as THREE from 'three';

const TICKS_PER_DAY = 24000;
const TICKS_PER_SECOND = 20;

// Sky color keyframes: [tick, [r, g, b]]. Linearly interpolated, wrapping at 24000.
const SKY_STOPS = [
  { t: 0,     c: [0x87, 0xce, 0xeb] }, // 06:00 dawn → day blue
  { t: 10500, c: [0x87, 0xce, 0xeb] }, // still day
  { t: 12000, c: [0xf0, 0xa0, 0x50] }, // 18:00 dusk orange
  { t: 13000, c: [0x60, 0x30, 0x6a] }, // 19:00 dusk purple
  { t: 14500, c: [0x0a, 0x0a, 0x2a] }, // 20:30 night dark blue
  { t: 21500, c: [0x0a, 0x0a, 0x2a] }, // 03:30 night
  { t: 22500, c: [0x60, 0x30, 0x6a] }, // 04:45 pre-dawn purple
  { t: 23500, c: [0xf0, 0xa0, 0x50] }, // 05:30 dawn orange
  { t: 24000, c: [0x87, 0xce, 0xeb] }, // 06:00 day blue (wraps)
];

export class Sky {
  constructor(scene) {
    this.time = 0; // ticks 0..24000
    this.paused = false;
    this.scene = scene;

    // --- Sun mesh (unlit bright sphere) ---
    const sunGeo = new THREE.SphereGeometry(30, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff5b4, fog: false });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.sunMesh.renderOrder = -1;
    scene.add(this.sunMesh);

    // --- Moon mesh (unlit pale sphere) ---
    const moonGeo = new THREE.SphereGeometry(22, 16, 16);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, fog: false });
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.moonMesh.renderOrder = -1;
    scene.add(this.moonMesh);

    // --- Star field (random points on a large sphere) ---
    const starCount = 800;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // Random direction on a sphere (upper hemisphere biased for sky feel).
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const r = 800;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.stars.renderOrder = -1;
    scene.add(this.stars);

    this._tmpDir = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
  }

  // Advance time by dt seconds (20 ticks/sec).
  update(dt) {
    if (this.paused) return;
    this.time += dt * TICKS_PER_SECOND;
    while (this.time >= TICKS_PER_DAY) this.time -= TICKS_PER_DAY;
    while (this.time < 0) this.time += TICKS_PER_DAY;
  }

  // Apply sky state to the scene: background color, sun/ambient/hemi light
  // intensities + positions, sun/moon/star visibility.
  apply(camera, sun, ambient, hemi) {
    // Sun angle: 0 at tick 0 (east horizon), PI/2 at noon, PI at dusk.
    const angle = (this.time / 12000) * Math.PI;
    const dir = this._tmpDir.set(Math.cos(angle), Math.sin(angle), 0.15).normalize();
    const sunHeight = Math.sin(angle); // -1..1

    // Daylight factor: smooth curve, brighter near dawn/dusk than raw sin.
    const daylight = Math.max(0, Math.min(1, sunHeight * 1.5 + 0.25));

    // Sky background color (interpolated keyframes).
    const [r, g, b] = skyColorAt(this.time);
    this._tmpColor.setRGB(r / 255, g / 255, b / 255);
    this.scene.background = this._tmpColor;

    // Sun directional light: position follows the sun direction relative to the
    // camera, far enough to stay outside the shadow-camera frustum. The sun's
    // DIRECTION drives the shadow map; its intensity is cosmetic now (MeshBasic
    // surfaces ignore scene lights — vertex colors + the shadow-darkening patch
    // own brightness). Kept so future MeshLambert objects (mobs) would light.
    sun.position.copy(camera.position).addScaledVector(dir, 150);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    sun.intensity = daylight * 1.0;

    // Ambient + hemisphere no longer affect chunk surfaces (MeshBasic ignores
    // them) — kept for future dynamic objects. Day/night brightness for the
    // voxel world comes from the baked vertex skylight + exposure modulation.
    ambient.intensity = 0.12 + daylight * 0.48;
    hemi.intensity = 0.08 + daylight * 0.32;

    // Sun mesh visible when above/near horizon; moon visible when sun is down.
    this.sunMesh.position.copy(camera.position).addScaledVector(dir, 500);
    this.sunMesh.visible = sunHeight > -0.15;
    // Moon is opposite the sun.
    this.moonMesh.position.copy(camera.position).addScaledVector(dir, -500);
    this.moonMesh.visible = sunHeight < 0.15;

    // Stars fade in as daylight drops.
    const nightFactor = 1 - daylight;
    this.stars.material.opacity = Math.max(0, nightFactor * 1.8 - 0.4);
    this.stars.position.copy(camera.position);
  }

  // Returns the current daylight factor (0 = full night, 1 = full day).
  getDaylight() {
    const angle = (this.time / 12000) * Math.PI;
    const sunHeight = Math.sin(angle);
    return Math.max(0, Math.min(1, sunHeight * 1.5 + 0.25));
  }

  // Returns "HH:MM" clock string (tick 0 = 06:00).
  getClock() {
    let hours = (this.time / 1000 + 6) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  // Returns a phase name for HUD.
  getPhase() {
    const t = this.time;
    if (t < 200) return 'dawn';
    if (t < 11000) return 'day';
    if (t < 13000) return 'dusk';
    if (t < 22500) return 'night';
    if (t < 24000) return 'dawn';
    return 'day';
  }

  // Scrub time by delta ticks (for debug keys).
  scrub(deltaTicks) {
    this.time += deltaTicks;
    while (this.time >= TICKS_PER_DAY) this.time -= TICKS_PER_DAY;
    while (this.time < 0) this.time += TICKS_PER_DAY;
  }
}

// Interpolate the sky color at a given tick. Returns [r, g, b] in 0..255.
function skyColorAt(time) {
  const stops = SKY_STOPS;
  // Find the surrounding stops.
  for (let i = 0; i < stops.length - 1; i++) {
    if (time >= stops[i].t && time <= stops[i + 1].t) {
      const t = (time - stops[i].t) / (stops[i + 1].t - stops[i].t);
      return [
        lerp(stops[i].c[0], stops[i + 1].c[0], t),
        lerp(stops[i].c[1], stops[i + 1].c[1], t),
        lerp(stops[i].c[2], stops[i + 1].c[2], t),
      ];
    }
  }
  return stops[stops.length - 1].c;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export { TICKS_PER_DAY, TICKS_PER_SECOND, skyColorAt };
