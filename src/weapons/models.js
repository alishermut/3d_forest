import * as THREE from 'three';
import { loadGLB, measureRestBox } from '../core/assets.js';

// Viewmodels — procedural arms + weapons. Convention: weapon forward is -Z
// in rig-local space, origin sits at the grip. Each builder returns:
//   { group, muzzle, basePos, baseRot }
// basePos/baseRot is the hip-fire rest pose in CAMERA space; viewmodel.js
// layers sway/bob/recoil/timeline offsets on top.
//
// Phase 49: pistol/rifle swap their primitive bodies for Quaternius GLBs
// (CC0). The builders stay synchronous — primitives render immediately as
// a placeholder and the GLB replaces them when loaded; on a failed fetch
// the placeholder simply stays. The procedural mitten arms always remain
// (style-matched, and rigged FPS-arm assets were ruled out — see PLAN v5).

const MATS = {
  metal: new THREE.MeshStandardMaterial({
    color: 0x2e2e33,
    metalness: 0.65,
    roughness: 0.4,
  }),
  metalDark: new THREE.MeshStandardMaterial({
    color: 0x1d1d20,
    metalness: 0.6,
    roughness: 0.5,
  }),
  polymer: new THREE.MeshStandardMaterial({
    color: 0x35322e,
    metalness: 0.1,
    roughness: 0.85,
  }),
  blade: new THREE.MeshStandardMaterial({
    color: 0xb9bec6,
    metalness: 0.9,
    roughness: 0.25,
  }),
  wood: new THREE.MeshStandardMaterial({
    color: 0x5a4530,
    metalness: 0.05,
    roughness: 0.8,
  }),
  skin: new THREE.MeshStandardMaterial({
    color: 0xc99272,
    metalness: 0,
    roughness: 0.75,
  }),
  sleeve: new THREE.MeshStandardMaterial({
    color: 0x49523f,
    metalness: 0,
    roughness: 0.95,
  }),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Cylinder along Z (weapon barrels and grips read better that way).
function tube(r, len, mat, x = 0, y = 0, z = 0, rTop = null) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop ?? r, r, len, 12),
    mat
  );
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// Tapered limb stretched between two points (forearms).
function limb(from, to, rFrom, rTo, mat) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTo, rFrom, len, 10), mat);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  return m;
}

// Forearm (sleeve) + wrist + mitten hand reaching from `elbow` to `grip`.
function arm(elbow, grip) {
  const g = new THREE.Group();
  const e = new THREE.Vector3(...elbow);
  const w = new THREE.Vector3(...grip);
  // sleeve covers the first 70 % of the limb, skin the rest
  const mid = e.clone().lerp(w, 0.68);
  g.add(limb(e, mid, 0.062, 0.05, MATS.sleeve));
  g.add(limb(mid, w, 0.046, 0.038, MATS.skin));
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), MATS.skin);
  hand.scale.set(0.85, 0.75, 1.15);
  hand.position.copy(w);
  g.add(hand);
  return g;
}

// Replace a rig's placeholder weapon body with a GLB, fitted by its
// rest-pose bbox: rotated muzzle-to--Z, scaled to `length` meters, then
// positioned so the bbox rear lands at `rearZ` and its vertical center at
// `centerY` (both in rig-local space — chosen to match the silhouette the
// arms were posed for). The muzzle anchor moves to the front of the bbox.
function swapInGLB(rig, placeholder, url, { length, rearZ, centerY, preRot = null, yawFix = Math.PI / 2, muzzleLift = 0.3 }) {
  loadGLB(url)
    .then((gltf) => {
      const wrap = new THREE.Group();
      wrap.name = 'weaponGLB';
      const mesh = gltf.scene.clone();
      if (preRot) mesh.rotation.copy(preRot);
      else mesh.rotation.y = yawFix; // pack guns are modeled along +X
      wrap.add(mesh);
      const box = measureRestBox(wrap);
      const size = box.getSize(new THREE.Vector3());
      const s = length / size.z;
      wrap.scale.setScalar(s);
      const center = box.getCenter(new THREE.Vector3());
      wrap.position.set(
        -center.x * s,
        centerY - center.y * s,
        rearZ - box.max.z * s
      );
      rig.group.remove(placeholder);
      rig.group.add(wrap);
      rig.muzzle.position.set(
        0,
        centerY + size.y * s * muzzleLift,
        rearZ - length - 0.01
      );
    })
    .catch((e) => console.warn(`[viewmodel] GLB swap failed (${url}):`, e));
}

// ---------------------------------------------------------------------------
export function buildKnife() {
  const group = new THREE.Group();

  group.add(tube(0.016, 0.11, MATS.polymer, 0, 0, 0.05)); // handle
  group.add(box(0.055, 0.02, 0.016, MATS.metal, 0, 0, -0.008)); // guard
  group.add(box(0.007, 0.036, 0.19, MATS.blade, 0, 0.004, -0.105)); // blade
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 8), MATS.blade);
  tip.rotation.x = -Math.PI / 2;
  tip.scale.x = 0.2;
  tip.position.set(0, 0.004, -0.228);
  group.add(tip);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), MATS.metal);
  pommel.position.set(0, 0, 0.108);
  group.add(pommel);

  group.add(arm([0.14, -0.34, 0.34], [0, -0.01, 0.05]));

  const muzzle = new THREE.Object3D(); // unused for melee, kept for interface
  muzzle.position.set(0, 0, -0.25);
  group.add(muzzle);

  return {
    group,
    muzzle,
    basePos: new THREE.Vector3(0.24, -0.23, -0.42),
    baseRot: new THREE.Euler(0.1, -0.35, 0.12),
  };
}

// ---------------------------------------------------------------------------
export function buildPistol() {
  const group = new THREE.Group();

  const placeholder = new THREE.Group();
  placeholder.add(box(0.034, 0.04, 0.2, MATS.metal, 0, 0.025, -0.06)); // slide
  placeholder.add(box(0.008, 0.012, 0.01, MATS.metalDark, 0, 0.051, -0.15)); // front sight
  placeholder.add(box(0.02, 0.012, 0.012, MATS.metalDark, 0, 0.051, 0.03)); // rear sight
  placeholder.add(box(0.032, 0.024, 0.15, MATS.polymer, 0, -0.006, -0.05)); // frame
  const grip = box(0.034, 0.12, 0.055, MATS.polymer, 0, -0.07, 0.022);
  grip.rotation.x = 0.28;
  placeholder.add(grip);
  placeholder.add(box(0.006, 0.005, 0.05, MATS.polymer, 0, -0.045, -0.045)); // trigger guard bottom
  placeholder.add(box(0.006, 0.03, 0.005, MATS.polymer, 0, -0.032, -0.068)); // trigger guard front
  group.add(placeholder);

  group.add(arm([0.13, -0.36, 0.36], [0.0, -0.07, 0.03])); // firing hand
  group.add(arm([-0.24, -0.38, 0.26], [-0.025, -0.095, 0.035])); // support hand

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.025, -0.168);
  group.add(muzzle);

  const rig = {
    group,
    muzzle,
    basePos: new THREE.Vector3(0.16, -0.185, -0.38),
    baseRot: new THREE.Euler(0, 0.04, 0),
  };
  swapInGLB(rig, placeholder, '/models/pistol.glb', {
    length: 0.21,
    rearZ: 0.045,
    centerY: -0.01,
    muzzleLift: 0.35,
  });
  return rig;
}

// ---------------------------------------------------------------------------
export function buildRifle() {
  const group = new THREE.Group();

  const placeholder = new THREE.Group();
  placeholder.add(box(0.055, 0.075, 0.3, MATS.metal, 0, 0.01, -0.05)); // receiver
  placeholder.add(tube(0.013, 0.34, MATS.metalDark, 0, 0.025, -0.4)); // barrel
  placeholder.add(tube(0.017, 0.06, MATS.metalDark, 0, 0.025, -0.59)); // flash hider
  // ribbed handguard
  placeholder.add(tube(0.031, 0.22, MATS.polymer, 0, 0.02, -0.3));
  for (const dz of [-0.24, -0.3, -0.36]) {
    placeholder.add(tube(0.034, 0.012, MATS.polymer, 0, 0.02, dz));
  }
  // carry handle + sights
  placeholder.add(box(0.024, 0.026, 0.15, MATS.metal, 0, 0.062, -0.04));
  placeholder.add(box(0.018, 0.03, 0.02, MATS.metal, 0, 0.062, 0.045));
  placeholder.add(box(0.012, 0.05, 0.012, MATS.metalDark, 0, 0.055, -0.43)); // front sight post
  // stock
  placeholder.add(box(0.045, 0.062, 0.22, MATS.polymer, 0, 0.0, 0.2));
  placeholder.add(box(0.048, 0.085, 0.03, MATS.polymer, 0, -0.005, 0.315)); // butt pad
  // pistol grip
  const grip = box(0.032, 0.1, 0.045, MATS.polymer, 0, -0.075, 0.045);
  grip.rotation.x = 0.35;
  placeholder.add(grip);
  // curved magazine (two angled segments)
  const mag1 = box(0.028, 0.09, 0.058, MATS.metalDark, 0, -0.085, -0.075);
  mag1.rotation.x = 0.12;
  const mag2 = box(0.027, 0.07, 0.056, MATS.metalDark, 0, -0.15, -0.092);
  mag2.rotation.x = 0.32;
  placeholder.add(mag1, mag2);
  placeholder.add(box(0.006, 0.005, 0.06, MATS.metal, 0, -0.042, -0.02)); // trigger guard
  group.add(placeholder);

  group.add(arm([0.13, -0.37, 0.38], [0.0, -0.08, 0.05])); // firing hand
  group.add(arm([-0.26, -0.4, 0.18], [-0.01, -0.015, -0.3])); // support on handguard

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.025, -0.625);
  group.add(muzzle);

  const rig = {
    group,
    muzzle,
    basePos: new THREE.Vector3(0.15, -0.2, -0.42),
    baseRot: new THREE.Euler(0, 0.05, 0),
  };
  swapInGLB(rig, placeholder, '/models/rifle.glb', {
    length: 0.95,
    rearZ: 0.33,
    centerY: 0.0,
    muzzleLift: 0.25,
  });
  return rig;
}

// ---------------------------------------------------------------------------
// Fishing rod (Phase 50). The Quaternius rod is modeled along +Y — preRot
// lays it along -Z. The `muzzle` anchor doubles as the ROD TIP: the fishing
// line starts at getMuzzleWorld() exactly like tracers leave gun barrels.
export function buildRod() {
  const group = new THREE.Group();

  const placeholder = new THREE.Group();
  placeholder.add(tube(0.012, 1.5, MATS.wood, 0, 0, -0.5, 0.005)); // tapering blank
  placeholder.add(tube(0.016, 0.3, MATS.polymer, 0, 0, 0.18)); // handle
  group.add(placeholder);

  group.add(arm([0.14, -0.35, 0.35], [0.0, -0.015, 0.16])); // rod hand
  group.add(arm([-0.24, -0.4, 0.3], [-0.02, -0.03, 0.3])); // reel hand

  const muzzle = new THREE.Object3D(); // = rod tip (line anchor)
  muzzle.position.set(0, 0.02, -1.28);
  group.add(muzzle);

  const rig = {
    group,
    muzzle,
    basePos: new THREE.Vector3(0.22, -0.26, -0.3),
    baseRot: new THREE.Euler(0.32, -0.12, 0.04),
  };
  swapInGLB(rig, placeholder, '/models/fishing_rod.glb', {
    length: 1.55,
    rearZ: 0.28,
    centerY: 0.0,
    preRot: new THREE.Euler(-Math.PI / 2, 0, 0), // +Y length → -Z
    muzzleLift: 0,
  });
  return rig;
}
