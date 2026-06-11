import * as THREE from 'three';
import { sunDirection } from '../world/atmosphere.js';
import { buildKnife, buildPistol, buildRifle, buildRod } from './models.js';

// First-person viewmodel (Phases 41-42): arms + weapon live in their own
// tiny scene with a dedicated low-FOV camera, rendered AFTER the composer
// with a depth clear. The gun therefore never clips into tree trunks and
// never touches the fragile N8AO/godrays depth pipeline. All animation is
// code-driven: springs for recoil, exponential smoothing for sway, and
// normalized-time timelines for switch/reload/slash.

const SWITCH_DUR = 0.4;

const _muzzleCam = new THREE.Vector3();
const _muzzleNdc = new THREE.Vector3();

function smooth(t) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.01,
      8
    );
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });

    // Lighting: hemi fill + a directional that tracks the live sun so the
    // weapon's shading direction matches the world. Renderer-level exposure
    // (day/night curve) applies to this forward render automatically.
    this.scene.add(new THREE.HemisphereLight(0xfff2dd, 0x42503c, 0.9));
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.7);
    this.scene.add(this.sunLight);

    // Animated root: rigs are children, pose offsets apply to the root.
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.rigs = {
      knife: buildKnife(),
      pistol: buildPistol(),
      rifle: buildRifle(),
      rod: buildRod(),
    };
    for (const r of Object.values(this.rigs)) {
      r.group.visible = false;
      this.root.add(r.group);
    }
    this.current = null;

    // Muzzle flash: additive sprite re-parented to the active rig's muzzle.
    this.flashSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeFlashTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        color: 0xffd9a0,
      })
    );
    this.flashSprite.visible = false;
    this.flashTimer = 0;

    // sway smoothing state
    this.swayX = 0;
    this.swayY = 0;
    this.swayRotX = 0;
    this.swayRotY = 0;
    // recoil spring state
    this.recoilZ = 0;
    this.recoilVelZ = 0;
    this.recoilRot = 0;
    this.recoilVelRot = 0;
    // timelines (null when inactive)
    this.switchAnim = null; // { t, to, onMid, midFired }
    this.reloadAnim = null; // { t, dur, onStage, fired:Set }
    this.attackAnim = null; // { t, dur }
    // per-frame pose written by external systems (fishing rod charge/cast):
    // { px, py, pz, rx, ry, rz } applied after the timelines, or null.
    this.extraPose = null;
  }

  setWeapon(name) {
    if (this.current) this.rigs[this.current].group.visible = false;
    this.current = name;
    const rig = this.rigs[name];
    rig.group.visible = true;
    rig.muzzle.add(this.flashSprite);
  }

  get switching() {
    return this.switchAnim !== null;
  }
  get reloading() {
    return this.reloadAnim !== null;
  }

  // Lower current weapon, swap at the midpoint (onMid: ammo/HUD updates).
  startSwitch(to, onMid) {
    this.switchAnim = { t: 0, to, onMid, midFired: false };
  }

  // onStage('out' | 'in' | 'rack') fires at fixed fractions for audio.
  startReload(dur, onStage) {
    this.reloadAnim = { t: 0, dur, onStage, fired: new Set() };
  }

  startAttack(dur) {
    this.attackAnim = { t: 0, dur };
  }

  // World-space point that appears ON SCREEN exactly where the muzzle is
  // drawn. The viewmodel renders with its own 55° camera while bullets live
  // in the main 75° camera's world — a fixed world offset can never line up
  // in both. So: muzzle -> vm-camera NDC (the vm camera sits at the origin,
  // so scene coords ARE camera space) -> ray through the SAME NDC from the
  // main camera, at the muzzle's eye distance.
  getMuzzleWorld(mainCamera, out) {
    const rig = this.rigs[this.current];
    rig.muzzle.getWorldPosition(_muzzleCam); // camera-space position
    const dist = _muzzleCam.length();
    _muzzleNdc.copy(_muzzleCam).project(this.camera);
    out.set(_muzzleNdc.x, _muzzleNdc.y, 0.5).unproject(mainCamera);
    return out
      .sub(mainCamera.position)
      .normalize()
      .multiplyScalar(dist)
      .add(mainCamera.position);
  }

  triggerRecoil(strength) {
    this.recoilVelZ += 1.5 * strength;
    this.recoilVelRot += 9 * strength;
  }

  flash() {
    this.flashSprite.visible = true;
    this.flashSprite.scale.setScalar(0.13 + Math.random() * 0.1);
    this.flashSprite.material.rotation = Math.random() * Math.PI * 2;
    this.flashTimer = 0.045;
  }

  // ctx: { lookYawVel, lookPitchVel, speed, bobPhase }
  update(dt, ctx) {
    if (!this.current) return;
    const rig = this.rigs[this.current];

    // --- sway: weapon lags the mouse (exponential approach) ---------------
    const k = 1 - Math.exp(-12 * dt);
    this.swayX += (THREE.MathUtils.clamp(-ctx.lookYawVel * 0.012, -0.035, 0.035) - this.swayX) * k;
    this.swayY += (THREE.MathUtils.clamp(-ctx.lookPitchVel * 0.01, -0.03, 0.03) - this.swayY) * k;
    this.swayRotY += (THREE.MathUtils.clamp(-ctx.lookYawVel * 0.04, -0.08, 0.08) - this.swayRotY) * k;
    this.swayRotX += (THREE.MathUtils.clamp(ctx.lookPitchVel * 0.03, -0.06, 0.06) - this.swayRotX) * k;

    // --- recoil spring back to rest ---------------------------------------
    const KS = 240, CD = 16;
    this.recoilVelZ += (-KS * this.recoilZ - CD * this.recoilVelZ) * dt;
    this.recoilZ += this.recoilVelZ * dt;
    this.recoilVelRot += (-KS * this.recoilRot - CD * this.recoilVelRot) * dt;
    this.recoilRot += this.recoilVelRot * dt;

    // --- walk bob (synced to the head-bob phase) ---------------------------
    const bobK = Math.min(ctx.speed / 4.2, 1.6);
    const bobX = Math.sin(ctx.bobPhase) * 0.011 * bobK;
    const bobY = -Math.abs(Math.cos(ctx.bobPhase)) * 0.009 * bobK;

    // --- compose pose ------------------------------------------------------
    const p = this.root.position;
    const r = this.root.rotation;
    p.copy(rig.basePos);
    p.x += this.swayX + bobX;
    p.y += this.swayY + bobY;
    p.z += this.recoilZ * 0.06;
    r.set(
      rig.baseRot.x + this.swayRotX - this.recoilRot * 0.045,
      rig.baseRot.y + this.swayRotY,
      rig.baseRot.z
    );

    // --- switch timeline ---------------------------------------------------
    if (this.switchAnim) {
      const a = this.switchAnim;
      a.t += dt / SWITCH_DUR;
      if (!a.midFired && a.t >= 0.5) {
        a.midFired = true;
        this.setWeapon(a.to);
        a.onMid?.();
      }
      const amt = a.t < 0.5 ? smooth(a.t / 0.5) : smooth((1 - a.t) / 0.5);
      p.y -= 0.32 * amt;
      r.x -= 0.85 * amt;
      if (a.t >= 1) this.switchAnim = null;
    }

    // --- reload timeline ---------------------------------------------------
    if (this.reloadAnim) {
      const a = this.reloadAnim;
      a.t += dt / a.dur;
      for (const [stage, at] of [['out', 0.22], ['in', 0.6], ['rack', 0.84]]) {
        if (a.t >= at && !a.fired.has(stage)) {
          a.fired.add(stage);
          a.onStage?.(stage);
        }
      }
      const dip = Math.sin(Math.PI * THREE.MathUtils.clamp(a.t, 0, 1));
      p.y -= 0.15 * dip;
      p.x -= 0.03 * dip;
      r.z += 0.4 * dip;
      r.x += 0.35 * dip;
      if (a.t >= 1) this.reloadAnim = null;
    }

    // --- knife slash timeline ----------------------------------------------
    if (this.attackAnim) {
      const a = this.attackAnim;
      a.t += dt / a.dur;
      const t = a.t;
      let dz = 0, dy = 0, dx = 0, rx = 0, rz = 0;
      if (t < 0.25) {
        const w = smooth(t / 0.25); // windup: pull back + raise
        dz = 0.08 * w; dy = 0.06 * w; rx = 0.6 * w; rz = 0.3 * w;
      } else if (t < 0.55) {
        const s = smooth((t - 0.25) / 0.3); // strike: lunge + arc down
        dz = 0.08 - 0.42 * s;
        dy = 0.06 - 0.14 * s;
        dx = -0.1 * s;
        rx = 0.6 - 1.5 * s;
        rz = 0.3 - 0.7 * s;
      } else {
        const c = 1 - smooth((t - 0.55) / 0.45); // recover
        dz = -0.34 * c; dy = -0.08 * c; dx = -0.1 * c;
        rx = -0.9 * c; rz = -0.4 * c;
      }
      p.x += dx; p.y += dy; p.z += dz;
      r.x += rx; r.z += rz;
      if (t >= 1) this.attackAnim = null;
    }

    // --- external pose layer (fishing) ---------------------------------------
    if (this.extraPose) {
      const e = this.extraPose;
      p.x += e.px || 0; p.y += e.py || 0; p.z += e.pz || 0;
      r.x += e.rx || 0; r.y += e.ry || 0; r.z += e.rz || 0;
    }

    // --- muzzle flash decay -------------------------------------------------
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.flashSprite.visible = false;
    }

    // sun-matched shading direction
    this.sunLight.position.copy(sunDirection).multiplyScalar(3);
  }

  render(renderer) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}

// Radial-gradient star texture for the muzzle flash sprite.
function makeFlashTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.25, 'rgba(255,210,120,0.9)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.25)');
  grad.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  // crossed spikes
  g.globalCompositeOperation = 'lighter';
  for (const rot of [0, Math.PI / 2]) {
    g.save();
    g.translate(s / 2, s / 2);
    g.rotate(rot);
    const sg = g.createLinearGradient(-s / 2, 0, s / 2, 0);
    sg.addColorStop(0, 'rgba(255,180,80,0)');
    sg.addColorStop(0.5, 'rgba(255,235,180,0.85)');
    sg.addColorStop(1, 'rgba(255,180,80,0)');
    g.fillStyle = sg;
    g.fillRect(-s / 2, -3, s, 6);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
