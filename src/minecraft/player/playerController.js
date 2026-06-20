// Voxelcraft — Phase 4: full player controller.
//
// Replaces the Phase 3 FlyController. Two modes:
//   WALK (default): gravity, jump, swept-AABB collision against voxels, step-up
//   FLY  (toggle F): no gravity, no collision, free 6DOF (Phase 3 fly behavior)
//
// Eye height = 1.62 (PLAYER_HEIGHT 1.8 - 0.18). The camera is positioned at
// feet.y + eyeHeight. Movement uses accel/damping for weight (same feel as
// the forest game).
//
// Controls:
//   WASD      move (relative to look, Y-plane in walk; full 3D in fly)
//   Space     jump (walk) / ascend (fly)
//   C / Ctrl  descend (fly)
//   Shift     sprint
//   F         toggle fly/walk
//   Mouse     look (PointerLockControls handles this)

import * as THREE from 'three';
import { moveAndCollide, collidesAt, PLAYER_DIMS } from '../engine/collision.js';

const EYE_HEIGHT = 1.62;
const WALK_SPEED = 4.3;     // m/s, Minecraft walk speed
const SPRINT_SPEED = 5.6;   // m/s, Minecraft sprint speed
const FLY_SPEED = 11;       // m/s
const FLY_SPRINT = 22;      // m/s
const ACCEL = 12;
const DAMP = 10;
const GRAVITY = 24;         // m/s² (stronger than real for snappy game feel)
const JUMP_SPEED = 8.4;     // m/s upward → ~1.25 block jump (MC is ~1.25)
const MAX_FALL = 60;        // terminal velocity

export class PlayerController {
  constructor(camera, world, controls) {
    this.camera = camera;
    this.world = world;
    this.controls = controls;
    this.keys = {};
    this.velocity = new THREE.Vector3();
    this.fly = false;
    this.onGround = false;
    this.spawn = new THREE.Vector3();

    this._onKeyDown = (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyF' && controls.isLocked) {
        this.toggleFly();
      }
    };
    this._onKeyUp = (e) => { this.keys[e.code] = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  // Place the player at a world position (feet). Snaps to ground if not flying.
  spawnAt(x, y, z) {
    this.spawn.set(x, y, z);
    this.feet = new THREE.Vector3(x, y, z);
    this.velocity.set(0, 0, 0);
    // Snap to ground: drop until we hit something or fall past -64.
    if (!this.fly) {
      while (this.feet.y > -64 && !collidesAt(this.world, this.feet.x, this.feet.y - 0.01, this.feet.z)) {
        this.feet.y -= 0.1;
        if (this.feet.y < -100) break;
      }
    }
    this._syncCamera();
  }

  toggleFly() {
    this.fly = !this.fly;
    this.velocity.set(0, 0, 0);
    if (!this.fly) {
      // Exiting fly: ensure feet are valid (drop to ground on next update)
      this.onGround = false;
    }
    this._notifyMode();
  }

  _notifyMode() {
    const el = document.getElementById('mode');
    if (el) {
      el.textContent = this.fly ? 'FLY' : 'WALK';
    }
  }

  update(dt) {
    if (!this.feet) return;
    if (this.fly) this._updateFly(dt);
    else this._updateWalk(dt);
    this._syncCamera();
  }

  _updateWalk(dt) {
    // Build horizontal movement direction from look (Y-plane only).
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

    const target = new THREE.Vector3();
    if (this.keys['KeyW']) target.add(forward);
    if (this.keys['KeyS']) target.sub(forward);
    if (this.keys['KeyD']) target.add(right);
    if (this.keys['KeyA']) target.sub(right);

    const sprint = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const maxSpeed = sprint ? SPRINT_SPEED : WALK_SPEED;

    if (target.lengthSq() > 0) {
      target.normalize().multiplyScalar(maxSpeed);
    }

    // Horizontal accel/damp
    const rate = target.lengthSq() > 0 ? ACCEL : DAMP;
    this.velocity.x = damp(this.velocity.x, target.x, rate, dt);
    this.velocity.z = damp(this.velocity.z, target.z, rate, dt);

    // Gravity + jump
    if (this.onGround && this.keys['Space']) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;
    if (this.velocity.y < -MAX_FALL) this.velocity.y = -MAX_FALL;

    // Move with collision (X, Y, Z resolved independently → slide)
    const delta = new THREE.Vector3(
      this.velocity.x * dt,
      this.velocity.y * dt,
      this.velocity.z * dt
    );
    const result = moveAndCollide(this.world, this.feet, delta);
    if (result.hitY) {
      if (this.velocity.y < 0) this.onGround = true;
      this.velocity.y = 0;
    } else {
      // Coyote: keep onGround true for one frame after leaving ground? No —
      // only true if we're actually resting. Re-check by probing down.
      this.onGround = !collidesAt(this.world, this.feet.x, this.feet.y - 0.05, this.feet.z)
        ? false
        : this.onGround;
    }
    // If we're not moving up and standing on ground, keep grounded.
    if (!result.hitY && this.velocity.y <= 0 && collidesAt(this.world, this.feet.x, this.feet.y - 0.01, this.feet.z)) {
      this.onGround = true;
      this.velocity.y = 0;
    }

    // Respawn if fell out of the world
    if (this.feet.y < -70) {
      this.feet.copy(this.spawn);
      this.velocity.set(0, 0, 0);
    }
  }

  _updateFly(dt) {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward); // full 3D in fly
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

    const target = new THREE.Vector3();
    if (this.keys['KeyW']) target.add(forward);
    if (this.keys['KeyS']) target.sub(forward);
    if (this.keys['KeyD']) target.add(right);
    if (this.keys['KeyA']) target.sub(right);
    if (this.keys['Space']) target.y += 1;
    if (this.keys['KeyC'] || this.keys['ControlLeft']) target.y -= 1;

    const sprint = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const maxSpeed = sprint ? FLY_SPRINT : FLY_SPEED;
    if (target.lengthSq() > 0) target.normalize().multiplyScalar(maxSpeed);

    const rate = target.lengthSq() > 0 ? ACCEL : DAMP;
    this.velocity.x = damp(this.velocity.x, target.x, rate, dt);
    this.velocity.y = damp(this.velocity.y, target.y, rate, dt);
    this.velocity.z = damp(this.velocity.z, target.z, rate, dt);

    this.feet.addScaledVector(this.velocity, dt);
  }

  _syncCamera() {
    this.camera.position.set(this.feet.x, this.feet.y + EYE_HEIGHT, this.feet.z);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}

function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export { EYE_HEIGHT };
