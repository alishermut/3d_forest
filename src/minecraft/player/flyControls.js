// Voxelcraft — Phase 3: minimal fly controller (temporary).
//
// Just enough movement to test chunk streaming: WASD + mouse look + Space/C
// for vertical. No collision — Phase 4 replaces this with the full player
// controller (swept-AABB vs voxel grid, walk + fly modes, gravity, jump).
//
// The controller is active only while the pointer is locked (game focused).

import * as THREE from 'three';

const SPEED = 20;       // m/s normal
const SPRINT_SPEED = 60; // m/s sprint (Shift)
const ACCEL = 12;        // how fast to reach target velocity
const DAMP = 8;          // how fast to stop when no input

export class FlyController {
  constructor(camera) {
    this.camera = camera;
    this.keys = {};
    this.velocity = new THREE.Vector3();
    this._onKeyDown = (e) => { this.keys[e.code] = true; };
    this._onKeyUp = (e) => { this.keys[e.code] = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  update(dt) {
    // Build movement direction from camera basis.
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, this.camera.up).normalize();

    const target = new THREE.Vector3();
    if (this.keys['KeyW']) target.add(forward);
    if (this.keys['KeyS']) target.sub(forward);
    if (this.keys['KeyD']) target.add(right);
    if (this.keys['KeyA']) target.sub(right);
    if (this.keys['Space']) target.y += 1;
    if (this.keys['KeyC'] || this.keys['ControlLeft']) target.y -= 1;

    const sprint = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const maxSpeed = sprint ? SPRINT_SPEED : SPEED;

    if (target.lengthSq() > 0) {
      target.normalize().multiplyScalar(maxSpeed);
    }

    // Accelerate toward target velocity, damp when no input.
    const isMoving = target.lengthSq() > 0;
    const rate = isMoving ? ACCEL : DAMP;
    this.velocity.lerp(target, 1 - Math.exp(-rate * dt));

    this.camera.position.addScaledVector(this.velocity, dt);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
