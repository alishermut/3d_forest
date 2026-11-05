import * as THREE from 'three';
import {
  raycastBullet,
  applyHitImpulse,
  getWaterLevel,
} from '../core/physics.js';
import { getHeight } from '../world/terrain.js';
import { playImpact } from './audio.js';

// Ballistics (Phase 43): bullets are points with velocity + gravity drop,
// swept with a Rapier raycast along each frame's travel segment — exact
// hits at any speed, no tunneling, and the tracer/arc is still visible.
// Shell casings are a cheap manual sim (no Rapier bodies per shell).

const BULLET_CAP = 48;
const SHELL_CAP = 32;
const BULLET_GRAVITY = 9.81;
const MAX_LIFE = 4;

const _dir = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();

export class Projectiles {
  constructor(scene, impacts, camera) {
    this.scene = scene;
    this.impacts = impacts;
    this.camera = camera;
    this.bullets = []; // { pos, vel, life, underwater, impulse, mesh }

    // tracer pool: thin additive boxes stretched along each frame's segment
    this.tracerPool = [];
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
    });
    for (let i = 0; i < BULLET_CAP; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracerPool.push(m);
    }

    // shell casings: one instanced mesh, manual gravity + one ground bounce
    this.shells = [];
    this.shellMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.007, 0.007, 0.03, 6),
      new THREE.MeshStandardMaterial({
        color: 0xb08d3e,
        metalness: 0.8,
        roughness: 0.35,
      }),
      SHELL_CAP
    );
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.count = 0;
    this.shellMesh.frustumCulled = false;
    scene.add(this.shellMesh);
    this._dummy = new THREE.Object3D();
  }

  spawn(origin, dir, speed, impulse) {
    let mesh = this.tracerPool.find((m) => !m.visible);
    if (!mesh || this.bullets.length >= BULLET_CAP) return;
    mesh.visible = true;
    this.bullets.push({
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(speed),
      life: MAX_LIFE,
      underwater: false,
      impulse,
      mesh,
    });
  }

  ejectShell(pos, right, up, forward) {
    if (this.shells.length >= SHELL_CAP) this.shells.shift();
    this.shells.push({
      pos: pos.clone(),
      vel: right
        .clone()
        .multiplyScalar(1.6 + Math.random())
        .addScaledVector(up, 2.2 + Math.random())
        .addScaledVector(forward, -0.4 + Math.random() * 0.6),
      spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
      rot: new THREE.Euler(Math.random() * 3, Math.random() * 3, 0),
      life: 2.5,
      bounced: false,
    });
  }

  // One bullet hit — FX + physics response. Returns true to kill the bullet.
  _handleHit(b, hit) {
    _hitPoint.set(hit.point.x, hit.point.y, hit.point.z);
    _hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    const camDist = _hitPoint.distanceTo(this.camera.position);
    if (hit.body) {
      // dynamic body: kick it, chips but no decal (it moves)
      _dir.copy(b.vel).normalize();
      applyHitImpulse(hit.body, _dir, hit.point, b.impulse);
      this.impacts.spawnImpact(_hitPoint, _hitNormal, hit.kind, { decal: false });
    } else {
      this.impacts.spawnImpact(_hitPoint, _hitNormal, hit.kind);
    }
    playImpact(hit.kind, camDist);
    return true;
  }

  update(dt) {
    // --- bullets -----------------------------------------------------------
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      b.vel.y -= BULLET_GRAVITY * dt;
      if (b.underwater) {
        b.vel.multiplyScalar(Math.exp(-6 * dt));
      }
      _seg.copy(b.vel).multiplyScalar(dt);
      const segLen = _seg.length();
      _dir.copy(_seg).normalize();

      let dead = b.life <= 0 || (b.underwater && b.vel.length() < 8);

      if (!dead && segLen > 1e-6) {
        const hit = raycastBullet(b.pos, _dir, segLen);
        // water-surface crossing (the lake/river has no collider — check
        // the segment against the analytic water level)
        let waterT = Infinity;
        if (!b.underwater) {
          const endY = b.pos.y + _seg.y;
          const lvl = getWaterLevel(b.pos.x + _seg.x, b.pos.z + _seg.z);
          if (lvl !== null && b.pos.y >= lvl && endY < lvl) {
            waterT = (b.pos.y - lvl) / Math.max(b.pos.y - endY, 1e-6);
          }
        }
        if (hit && hit.dist / segLen < waterT) {
          dead = this._handleHit(b, hit);
          b.pos.addScaledVector(_seg, hit.dist / segLen);
        } else if (waterT <= 1) {
          b.pos.addScaledVector(_seg, waterT);
          this.impacts.spawnSplash(b.pos);
          playImpact('water', b.pos.distanceTo(this.camera.position));
          b.underwater = true;
          b.life = Math.min(b.life, 0.5);
        } else {
          b.pos.add(_seg);
        }
      }

      // tracer: stretch along this frame's segment, capped length
      const tLen = Math.min(segLen * 1.5 + 0.3, 2.2);
      _mid.copy(b.pos).addScaledVector(_dir, -tLen * 0.5);
      b.mesh.position.copy(_mid);
      b.mesh.scale.set(0.014, 0.014, tLen);
      b.mesh.lookAt(_mid.clone().add(_dir));

      if (dead) {
        b.mesh.visible = false;
        this.bullets.splice(i, 1);
      }
    }

    // --- shells -------------------------------------------------------------
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.shells.splice(i, 1);
        continue;
      }
      s.vel.y -= 9.81 * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.rot.x += s.spin.x * dt;
      s.rot.y += s.spin.y * dt;
      s.rot.z += s.spin.z * dt;
      const ground = getHeight(s.pos.x, s.pos.z) + 0.015;
      if (s.pos.y < ground) {
        s.pos.y = ground;
        if (!s.bounced) {
          s.bounced = true;
          s.vel.y *= -0.3;
          s.vel.x *= 0.5;
          s.vel.z *= 0.5;
          s.spin.multiplyScalar(0.4);
        } else {
          s.vel.set(0, 0, 0);
          s.spin.set(0, 0, 0);
        }
      }
    }
    this.shellMesh.count = this.shells.length;
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      this._dummy.position.copy(s.pos);
      this._dummy.rotation.copy(s.rot);
      const fade = Math.min(s.life / 0.3, 1); // shrink out at end of life
      this._dummy.scale.setScalar(fade);
      this._dummy.updateMatrix();
      this.shellMesh.setMatrixAt(i, this._dummy.matrix);
    }
    if (this.shells.length) this.shellMesh.instanceMatrix.needsUpdate = true;
  }
}
