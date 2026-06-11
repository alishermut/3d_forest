import * as THREE from 'three';

// Impact FX (Phase 44): pooled, zero per-shot allocations in steady state.
// - particle bursts: one THREE.Points pool, surface-flavored palettes
// - bullet-hole decals: pooled planes oriented to the hit normal
// - water splash: expanding ring + white spray burst

const PARTICLE_CAP = 384;
const DECAL_CAP = 48;
const RING_CAP = 8;
const GRAVITY = 6.5;

const PALETTES = {
  wood: [0x6b4a2c, 0x8a6240, 0x4a3017],
  dirt: [0x5d4a30, 0x7a6543, 0x46371f],
  rock: [0x8d8d92, 0xa9a9ad, 0x6e6e72],
  water: [0xd6ecf2, 0xb8dde8, 0xffffff],
};

export class ImpactEffects {
  constructor(scene) {
    this.scene = scene;

    // --- particles ---------------------------------------------------------
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(PARTICLE_CAP * 3);
    this.colors = new Float32Array(PARTICLE_CAP * 3);
    this.positions.fill(-9999); // park dead particles far away
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.velocities = new Float32Array(PARTICLE_CAP * 3);
    this.lives = new Float32Array(PARTICLE_CAP);
    this.cursor = 0;
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.055,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    this.points.frustumCulled = false;
    scene.add(this.points);

    // --- decals -------------------------------------------------------------
    const decalGeo = new THREE.PlaneGeometry(0.13, 0.13);
    const decalMat = new THREE.MeshBasicMaterial({
      map: makeHoleTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.decals = [];
    this.decalCursor = 0;
    for (let i = 0; i < DECAL_CAP; i++) {
      const m = new THREE.Mesh(decalGeo, decalMat);
      m.visible = false;
      scene.add(m);
      this.decals.push(m);
    }

    // --- splash rings ---------------------------------------------------------
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.55, 0.72, 28);
    for (let i = 0; i < RING_CAP; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xeaf6f8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      this.rings.push({ mesh: m, t: 1 });
    }
    this.ringCursor = 0;
  }

  spawnParticles(point, normal, kind, count, speed = 2.6) {
    const palette = PALETTES[kind] ?? PALETTES.dirt;
    const c = new THREE.Color();
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % PARTICLE_CAP;
      const i3 = i * 3;
      this.positions[i3] = point.x;
      this.positions[i3 + 1] = point.y;
      this.positions[i3 + 2] = point.z;
      const s = speed * (0.4 + Math.random() * 0.9);
      this.velocities[i3] = normal.x * s + (Math.random() - 0.5) * speed;
      this.velocities[i3 + 1] = normal.y * s + Math.random() * speed * 0.7;
      this.velocities[i3 + 2] = normal.z * s + (Math.random() - 0.5) * speed;
      this.lives[i] = 0.35 + Math.random() * 0.45;
      c.setHex(palette[(Math.random() * palette.length) | 0]);
      this.colors[i3] = c.r;
      this.colors[i3 + 1] = c.g;
      this.colors[i3 + 2] = c.b;
    }
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  // Bullet hit on a solid surface: decal + chips. No decal on dynamic
  // bodies (they move; a parented decal pool isn't worth it yet).
  spawnImpact(point, normal, kind, { decal = true } = {}) {
    this.spawnParticles(point, normal, kind, kind === 'rock' ? 8 : 12);
    if (!decal) return;
    const m = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % DECAL_CAP;
    m.visible = true;
    m.position.set(
      point.x + normal.x * 0.013,
      point.y + normal.y * 0.013,
      point.z + normal.z * 0.013
    );
    m.lookAt(
      point.x + normal.x,
      point.y + normal.y,
      point.z + normal.z
    );
    m.rotateZ(Math.random() * Math.PI * 2);
  }

  // Bullet crossing the water surface: ring + upward spray.
  spawnSplash(point) {
    const up = new THREE.Vector3(0, 1, 0);
    this.spawnParticles(point, up, 'water', 16, 3.4);
    const r = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % RING_CAP;
    r.mesh.visible = true;
    r.mesh.position.set(point.x, point.y + 0.02, point.z);
    r.t = 0;
  }

  update(dt) {
    // particles
    const pos = this.positions;
    const vel = this.velocities;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      if (this.lives[i] <= 0) continue;
      this.lives[i] -= dt;
      const i3 = i * 3;
      if (this.lives[i] <= 0) {
        pos[i3] = pos[i3 + 1] = pos[i3 + 2] = -9999;
        continue;
      }
      vel[i3 + 1] -= GRAVITY * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    // rings
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t += dt / 0.8;
      const s = 0.4 + r.t * 2.8;
      r.mesh.scale.setScalar(s);
      r.mesh.material.opacity = 0.65 * (1 - r.t);
      if (r.t >= 1) r.mesh.visible = false;
    }
  }
}

// Dark ragged bullet hole with a charred rim.
function makeHoleTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(8,6,4,0.95)');
  grad.addColorStop(0.35, 'rgba(15,11,7,0.8)');
  grad.addColorStop(0.6, 'rgba(25,18,10,0.35)');
  grad.addColorStop(1, 'rgba(30,22,12,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  // ragged speckles around the rim
  g.fillStyle = 'rgba(10,8,5,0.5)';
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = s * (0.2 + Math.random() * 0.18);
    g.beginPath();
    g.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, 1 + Math.random() * 2, 0, 7);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
