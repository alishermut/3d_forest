import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const WALK_SPEED = 4.2;     // m/s
const SPRINT_SPEED = 8.0;   // m/s, hold Shift
const ACCEL_RATE = 10;      // how fast velocity approaches target (1/s)
const HEAD_BOB = true;      // subtle walk bob; set false to disable
const BOB_FREQ = 2.1;       // steps per meter-ish
const BOB_AMP = 0.035;      // meters

const FLY_SPEED = 14;       // m/s; Shift multiplies by 3.5
const UP = new THREE.Vector3(0, 1, 0);

// Input + look only (Phase 8): produces a desired world-space velocity each
// frame; core/physics.js moves the capsule and resolves all collisions.
export class PlayerControls {
  constructor(camera, domElement) {
    this.camera = camera;

    this.controls = new PointerLockControls(camera, domElement);
    this.velocity = new THREE.Vector3(); // camera-local: x strafe, z forward
    this.worldVelocity = new THREE.Vector3();
    this.flyVelocity = new THREE.Vector3();
    this.keys = new Set();
    this.bobPhase = 0;
    this.bobOffset = 0;
    this.jumpQueued = false;

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && this.locked) {
        this.jumpQueued = true;
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Released keys are missed while the window is unfocused — clear all.
    window.addEventListener('blur', () => this.keys.clear());
  }

  get locked() {
    return this.controls.isLocked;
  }

  lock() {
    this.controls.lock();
  }

  onLock(fn) {
    this.controls.addEventListener('lock', fn);
  }

  onUnlock(fn) {
    this.controls.addEventListener('unlock', fn);
  }

  // One-shot jump request (queued on Space keydown, consumed per frame;
  // physics only honors it when grounded).
  consumeJump() {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }

  // While swimming: Space surfaces, C/Ctrl dives.
  getSwimVertical() {
    if (!this.locked) return 0;
    return (
      (this.keys.has('Space') ? 1 : 0) -
      (this.keys.has('KeyC') || this.keys.has('ControlLeft') ? 1 : 0)
    );
  }

  // Sandbox/spectator fly: WASD relative to the full view direction
  // (including pitch), Space up, C/Ctrl down, Shift fast. No collision —
  // moves the camera directly.
  updateFly(dt) {
    const forward = this.locked
      ? (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
      : 0;
    const strafe = this.locked
      ? (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
      : 0;
    const vertical = this.locked
      ? (this.keys.has('Space') ? 1 : 0) -
        (this.keys.has('KeyC') || this.keys.has('ControlLeft') ? 1 : 0)
      : 0;

    const boost =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3.5 : 1;

    this.camera.getWorldDirection(this._forward); // full 3D, pitch included
    this._right.crossVectors(this._forward, UP).normalize();

    const target = new THREE.Vector3()
      .addScaledVector(this._forward, forward)
      .addScaledVector(this._right, strafe)
      .addScaledVector(UP, vertical);
    if (target.lengthSq() > 0) {
      target.normalize().multiplyScalar(FLY_SPEED * boost);
    }

    const t = 1 - Math.exp(-ACCEL_RATE * dt);
    this.flyVelocity.lerp(target, t);
    this.camera.position.addScaledVector(this.flyVelocity, dt);

    this.bobPhase = 0;
    this.bobOffset = 0;
    this.jumpQueued = false; // Space means "up" here, never jump
  }

  // Returns the desired world-space velocity (m/s) for this frame.
  update(dt) {
    const forward = this.locked
      ? (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
      : 0;
    const strafe = this.locked
      ? (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
      : 0;

    const sprinting =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const maxSpeed = sprinting ? SPRINT_SPEED : WALK_SPEED;

    // Target velocity in local space, normalized so diagonals aren't faster.
    const target = new THREE.Vector3(strafe, 0, forward);
    if (target.lengthSq() > 0) target.normalize().multiplyScalar(maxSpeed);

    // Frame-rate independent approach: v -> target with exponential easing.
    const t = 1 - Math.exp(-ACCEL_RATE * dt);
    this.velocity.lerp(target, t);
    if (target.lengthSq() === 0 && this.velocity.lengthSq() < 1e-4) {
      this.velocity.set(0, 0, 0);
    }

    // Local -> world: forward is the camera direction flattened to XZ.
    this.camera.getWorldDirection(this._forward);
    this._forward.y = 0;
    this._forward.normalize();
    this._right.crossVectors(this._forward, UP);

    this.worldVelocity
      .copy(this._forward)
      .multiplyScalar(this.velocity.z)
      .addScaledVector(this._right, this.velocity.x);

    // Head bob (visual only — applied to the camera, not the capsule).
    const speed = this.velocity.length();
    if (HEAD_BOB && speed > 0.5) {
      this.bobPhase += speed * BOB_FREQ * dt;
      this.bobOffset =
        Math.sin(this.bobPhase) * BOB_AMP * Math.min(speed / WALK_SPEED, 1.4);
    } else {
      this.bobPhase = 0;
      this.bobOffset = 0;
    }

    return this.worldVelocity;
  }
}
