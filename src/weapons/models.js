import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
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
  glove: new THREE.MeshStandardMaterial({
    color: 0x26282d,
    metalness: 0.05,
    roughness: 0.9,
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
  const sleeve = limb(e, mid, 0.062, 0.05, MATS.sleeve);
  const wrist = limb(mid, w, 0.046, 0.038, MATS.skin);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), MATS.skin);
  hand.scale.set(0.85, 0.75, 1.15);
  hand.position.copy(w);
  // Disable frustum culling for viewmodel meshes
  [sleeve, wrist, hand].forEach((m) => { m.frustumCulled = false; });
  g.add(sleeve, wrist, hand);
  return g;
}

// ---------------------------------------------------------------------------
// Procedural GLOVED gripping hand (replaces the GLB FPS arms — see PLAN v6).
// Built deterministically around a handle so it can be placed exactly on each
// weapon's grips. Local frame: handle runs along +Z, palm sits at -Y, fingers
// wrap up the front (+X) and over the top.
// ---------------------------------------------------------------------------

// A curled finger: a short chain of glove segments hugging the handle circle
// (radius R) in the local XY plane, at distance `z` along the handle.
function curledFinger(z, R, fr, totalWrap, startAngle, segs = 4) {
  const g = new THREE.Group();
  g.position.z = z;
  const ringR = R + fr * 0.8;
  const segLen = (totalWrap * ringR) / segs;
  for (let i = 0; i < segs; i++) {
    const a = startAngle + ((i + 0.5) / segs) * totalWrap;
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(fr * 1.7, fr * 1.7, segLen * 0.92),
      MATS.glove
    );
    seg.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, 0);
    // box length (local Z) points along the circle tangent
    const t = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
    seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
    g.add(seg);
  }
  return g;
}

// Palm + 4 fingers + thumb wrapping a handle of radius R (local frame above).
function buildGripHand(parent, { R = 0.018, fr = 0.0078, side = 'R' } = {}) {
  // palm under the handle + back-of-hand block over it
  parent.add(box(0.05, 0.024, 0.072, MATS.glove, 0, -(R + 0.012), 0.004));
  parent.add(box(0.044, 0.018, 0.058, MATS.glove, 0, -(R - 0.004), 0.004));
  // four fingers across the handle, wrapping front -> over the top -> back
  const zPos = [-0.027, -0.009, 0.009, 0.027];
  zPos.forEach((z, i) => {
    parent.add(curledFinger(z, R, fr, Math.PI * (0.92 + 0.04 * i), -0.35));
  });
  // thumb: opposite side, shorter wrap, near the rear of the palm
  const tz = side === 'R' ? 0.034 : -0.034;
  parent.add(curledFinger(tz, R, fr * 1.15, Math.PI * 0.62, Math.PI * 0.9));
}

// Gloved forearm + a gripping hand placed at `grip`, oriented so the handle
// axis is `handleDir` and the forearm runs back toward `elbow`.
function glovedArm(elbowArr, gripArr, handleDirArr, opts = {}) {
  const g = new THREE.Group();
  const elbow = new THREE.Vector3(...elbowArr);
  const grip = new THREE.Vector3(...gripArr);
  const fwd = new THREE.Vector3().subVectors(grip, elbow).normalize();
  const wristPt = grip.clone().addScaledVector(fwd, -0.05);
  g.add(limb(elbow, wristPt, 0.056, 0.032, MATS.glove)); // sleeve forearm

  const hand = new THREE.Group();
  hand.position.copy(grip);
  const z = new THREE.Vector3(...handleDirArr).normalize();
  const y = new THREE.Vector3().subVectors(grip, elbow).normalize(); // local +Y away from forearm
  y.addScaledVector(z, -y.dot(z)).normalize(); // orthogonalize against handle axis
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  hand.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  buildGripHand(hand, opts);
  g.add(hand);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
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

// Replace a rig's procedural mitten arms with the DJMaesen FPS arms GLB
// (CC-BY 4.0, gloved, full finger rig, bind pose reaching +Z). Same
// placeholder pattern as swapInGLB: mittens render until the GLB lands.
// Options: pos (rig-local wrap position), zReach (target arm length m),
// squeezeX (pull hands toward centerline for narrow grips), collapseLeft
// (scale the left arm bone to zero — one-handed weapons).
const ARMS_URL = '/models/fps_arms/scene.gltf';

// Finger map: our key -> the GLB's finger-bone prefix (index is "point",
// pinky is "pink"). Each finger has 4 segments; we curl the first three.
const FINGER_PREFIX = { thumb: 'thumb', index: 'point', middle: 'middle', ring: 'ring', pinky: 'pink' };

// Per-weapon grip pose presets. The handTuner (press H) lets you fine-tune
// these live, then save to localStorage['handpose.<weapon>']. Poses cover:
// - Whole-arms placement (offset on top of the auto wrist-to-grip fit)
// - Per-hand: arm (shoulder) rotation, elbow bend, wrist orientation, finger curls
// Support hand fully wrapped; trigger hand wrapped with index near-straight
// (resting toward the trigger guard).
const GRIP_POSES = {
  knife: {
    axis: 'z', sign: 1,
    rig: { px: 0.02, py: -0.04, pz: 0.08, rx: 0.15, ry: -0.1, rz: 0.08, scale: 0.95 },
    R: {
      arm: { x: 0.1, y: 0.05, z: -0.15 },
      elbow: { x: 0.2, y: 0, z: 0 },
      wrist: { x: 0.25, y: 0.1, z: 0.15 },
      thumb: 0.55, index: 0.75, fingers: 0.9,
    },
    L: {
      arm: { x: 0, y: 0, z: 0 },
      elbow: { x: 0, y: 0, z: 0 },
      wrist: { x: 0, y: 0, z: 0 },
      thumb: 0.45, index: 0.85, fingers: 0.85,
    },
  },
  pistol: {
    axis: 'z', sign: 1,
    rig: { px: 0.01, py: -0.02, pz: 0.05, rx: 0.08, ry: 0, rz: 0.04, scale: 0.98 },
    R: {
      arm: { x: 0.05, y: 0, z: -0.08 },
      elbow: { x: 0.15, y: 0, z: 0 },
      wrist: { x: 0.12, y: 0.05, z: 0.08 },
      thumb: 0.48, index: 0.12, fingers: 0.88,
    },
    L: {
      arm: { x: 0, y: 0, z: 0 },
      elbow: { x: 0, y: 0, z: 0 },
      wrist: { x: 0, y: 0, z: 0 },
      thumb: 0.45, index: 0.85, fingers: 0.85,
    },
  },
  rifle: {
    axis: 'z', sign: 1,
    rig: { px: 0, py: -0.02, pz: 0.04, rx: 0.1, ry: 0.02, rz: 0.02, scale: 1.0 },
    R: {
      arm: { x: 0.08, y: 0.02, z: -0.1 },
      elbow: { x: 0.18, y: 0, z: 0 },
      wrist: { x: 0.15, y: 0.08, z: 0.1 },
      thumb: 0.5, index: 0.1, fingers: 0.85,
    },
    L: {
      arm: { x: 0.12, y: -0.05, z: 0.15 },
      elbow: { x: 0.25, y: 0.05, z: 0 },
      wrist: { x: 0.1, y: -0.08, z: -0.05 },
      thumb: 0.55, index: 0.9, fingers: 0.92,
    },
  },
  rod: {
    axis: 'z', sign: 1,
    rig: { px: 0, py: -0.03, pz: 0.06, rx: 0.12, ry: -0.08, rz: 0.05, scale: 0.95 },
    R: {
      arm: { x: 0.08, y: 0, z: -0.12 },
      elbow: { x: 0.2, y: 0, z: 0 },
      wrist: { x: 0.18, y: 0.1, z: 0.12 },
      thumb: 0.5, index: 0.65, fingers: 0.85,
    },
    L: {
      arm: { x: 0.1, y: -0.05, z: 0.12 },
      elbow: { x: 0.22, y: 0, z: 0 },
      wrist: { x: 0.1, y: -0.05, z: -0.08 },
      thumb: 0.52, index: 0.72, fingers: 0.88,
    },
  },
};

function defaultGripPose(name = 'rifle') {
  const preset = GRIP_POSES[name] || GRIP_POSES.rifle;
  return JSON.parse(JSON.stringify(preset)); // deep clone so localStorage can override
}

// Deep-merge a saved pose over the current defaults so newly-added fields
// (arm/elbow/rig placement) always exist on older saved poses.
function mergePose(def, s) {
  const out = { ...def, ...s };
  out.rig = { ...def.rig, ...(s.rig || {}) };
  for (const side of ['R', 'L']) {
    const sd = s[side] || {};
    out[side] = { ...def[side], ...sd };
    out[side].arm = { ...def[side].arm, ...(sd.arm || {}) };
    out[side].elbow = { ...def[side].elbow, ...(sd.elbow || {}) };
    out[side].wrist = { ...def[side].wrist, ...(sd.wrist || {}) };
  }
  return out;
}

// Build the poseable hand rig: locate the arm/elbow/wrist + finger-segment
// bones per side, capture their bind rotations, and expose applyPose(pose).
// Controls (all additive on the auto wrist-to-grip fit):
//   • rig: whole-arms position/rotation/scale (the `wrap` group)
//   • per side: arm (shoulder) rot, elbow rot, wrist rot, finger curls
function buildHandRig(rig, arms, wrap, name) {
  const byName = {};
  arms.traverse((o) => { if (o.isBone) byName[o.name] = o; });
  const seg = (side, fp, i) => {
    const k = Object.keys(byName).find((n) => n.startsWith(`${side}_${fp}${i}_`));
    return k ? byName[k] : null;
  };
  const boneRe = (side, re) => Object.values(byName).find((b) => re.test(b.name) && b.name.startsWith(side + '_')) || null;
  const bind = new Map();
  const cap = (b) => { if (b) bind.set(b, { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z }); };

  const sides = {};
  for (const side of ['R', 'L']) {
    const armB = boneRe(side, /_arm/);
    const elbowB = boneRe(side, /_elbow/);
    const wrist = boneRe(side, /_wrist/);
    [armB, elbowB, wrist].forEach(cap);
    const fingers = {};
    for (const key in FINGER_PREFIX) {
      const segs = [1, 2, 3, 4].map((i) => seg(side, FINGER_PREFIX[key], i)).filter(Boolean);
      segs.forEach(cap);
      fingers[key] = segs;
    }
    sides[side] = { arm: armB, elbow: elbowB, wrist, fingers };
  }

  let pose = defaultGripPose(name);
  try { const s = JSON.parse(localStorage.getItem('handpose.' + name)); if (s) pose = mergePose(pose, s); } catch {}

  const wrapBase = { pos: wrap.position.clone(), rot: wrap.rotation.clone(), scale: wrap.scale.clone() };

  rig.handRig = {
    R: sides.R, L: sides.L, name, pose, wrap, wrapBase,
    setBone(bone, off) {
      if (!bone || !off) return;
      const b = bind.get(bone);
      bone.rotation.set(b.x + (off.x || 0), b.y + (off.y || 0), b.z + (off.z || 0));
    },
    applyPose(p) {
      // whole-arms placement (offset on top of the fitted base)
      const rg = p.rig || {};
      const sc = rg.scale ?? 1;
      this.wrap.position.set(wrapBase.pos.x + (rg.px || 0), wrapBase.pos.y + (rg.py || 0), wrapBase.pos.z + (rg.pz || 0));
      this.wrap.rotation.set(wrapBase.rot.x + (rg.rx || 0), wrapBase.rot.y + (rg.ry || 0), wrapBase.rot.z + (rg.rz || 0));
      this.wrap.scale.set(wrapBase.scale.x * sc, wrapBase.scale.y * sc, wrapBase.scale.z * sc);

      const ax = p.axis || 'z', sg = p.sign ?? 1;
      for (const side of ['R', 'L']) {
        const h = this[side], ps = p[side];
        if (!h || !ps) continue;
        this.setBone(h.arm, ps.arm);
        this.setBone(h.elbow, ps.elbow);
        this.setBone(h.wrist, ps.wrist);
        for (const fkey in h.fingers) {
          const curl = fkey === 'thumb' ? ps.thumb : fkey === 'index' ? ps.index : ps.fingers;
          h.fingers[fkey].forEach((s, i) => {
            if (i > 2) return; // tip segment stays
            const b = bind.get(s); if (!b) return;
            const w = [1.0, 0.9, 0.7][i];
            s.rotation.set(b.x, b.y, b.z);
            s.rotation[ax] = b[ax] + (curl || 0) * sg * w * 1.4; // up to ~80°
          });
        }
      }
    },
  };
  rig.handRig.applyPose(pose);
}

function attachArms(rig, placeholderArms, { gripR, gripL = null, zReach = 0.62, squeezeX = 1, collapseLeft = false, tilt = 0, name = 'weapon' }) {
  loadGLB(ARMS_URL)
    .then((gltf) => {
      const arms = cloneSkinned(gltf.scene);
      const wrap = new THREE.Group();
      wrap.name = 'armsGLB';
      wrap.add(arms);
      // rotate hands from +Z (authored) to -Z (our forward), then scale
      arms.rotation.y = Math.PI;
      const raw = measureRestBox(arms);
      const s = zReach / raw.getSize(new THREE.Vector3()).z;
      wrap.scale.set(s * squeezeX, s, s);
      // DETERMINISTIC two-point fit on the WRIST BONES (bbox anchoring
      // failed: the box top is the shoulders, so hands floated under every
      // grip). 1) translate so the RIGHT wrist lands exactly on the firing
      // grip; 2) yaw the wrap so the LEFT wrist aims at the support grip
      // (rotation moves the right wrist, so re-pin it after). Grip targets
      // are the same coordinates the procedural mitten hands used.
      const wristOf = (side) => {
        let pos = null;
        arms.traverse((o) => {
          if (!pos && o.isBone && o.name.startsWith(side) && /wrist/i.test(o.name)) {
            pos = o.getWorldPosition(new THREE.Vector3());
          }
        });
        return pos;
      };
      const pinRight = () => {
        wrap.updateMatrixWorld(true);
        const rw = wristOf('R');
        if (rw) wrap.position.add(gripR.clone().sub(rw));
      };
      pinRight();
      if (gripL) {
        wrap.updateMatrixWorld(true);
        const rw = wristOf('R');
        const lw = wristOf('L');
        if (rw && lw) {
          // YAW-ONLY alignment of the wrist axis to the grip axis. Full 3D
          // (setFromUnitVectors) was tried and rejected: the pitch swings
          // the chest/shoulder mass up into the near plane and floods the
          // whole view. The leftover vertical offset is fine — the support
          // hand cradles the handguard from below, like a real grip.
          const cur = lw.sub(rw);
          const des = gripL.clone().sub(gripR);
          wrap.rotation.y = Math.atan2(des.x, des.z) - Math.atan2(cur.x, cur.z);
          pinRight(); // the yaw moved the right wrist — re-pin
        }
      }
      wrap.rotateX(tilt);
      if (collapseLeft) {
        const lArm = arms.getObjectByName('L_arm_02');
        if (lArm) lArm.scale.setScalar(0.0001);
      }
      wrap.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
          o.frustumCulled = false; // tiny vm scene — skip stale-bounds risk
        }
      });
      // Pose the fingers/wrist onto the grip (was bind-pose before — rigid,
      // straight fingers). Tunable live via the hand-pose tuner (press H).
      buildHandRig(rig, arms, wrap, name);
      placeholderArms.forEach((a) => rig.group.remove(a));
      rig.group.add(wrap);
    })
    .catch((e) => console.warn('[viewmodel] arms GLB failed, mittens stay:', e));
}

// ---------------------------------------------------------------------------
export function buildKnife() {
  const group = new THREE.Group();

  // Knife geometry - disable frustum culling since the viewmodel camera is tiny
  const handle = tube(0.016, 0.11, MATS.polymer, 0, 0, 0.05);
  const guard = box(0.055, 0.02, 0.016, MATS.metal, 0, 0, -0.008);
  const blade = box(0.007, 0.036, 0.19, MATS.blade, 0, 0.004, -0.105);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 8), MATS.blade);
  tip.rotation.x = -Math.PI / 2;
  tip.scale.x = 0.2;
  tip.position.set(0, 0.004, -0.228);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), MATS.metal);
  pommel.position.set(0, 0, 0.108);

  // Disable frustum culling on all knife meshes to prevent them being culled
  // in the viewmodel's small dedicated scene
  [handle, guard, blade, tip, pommel].forEach((m) => {
    m.frustumCulled = false;
    group.add(m);
  });

  const arms = [arm([0.14, -0.34, 0.34], [0, -0.01, 0.05])];
  // Disable frustum culling on arm meshes too
  arms.forEach((a) => {
    a.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    group.add(a);
  });

  const muzzle = new THREE.Object3D(); // unused for melee, kept for interface
  muzzle.position.set(0, 0, -0.25);
  group.add(muzzle);

  const rig = {
    group,
    muzzle,
    basePos: new THREE.Vector3(0.24, -0.23, -0.42),
    baseRot: new THREE.Euler(0.1, -0.35, 0.12),
  };
  attachArms(rig, arms, {
    gripR: new THREE.Vector3(0, -0.01, 0.05), // knife handle (mitten target)
    zReach: 0.5,
    collapseLeft: true,
    name: 'knife',
  });
  return rig;
}

// ---------------------------------------------------------------------------
export function buildPistol() {
  const group = new THREE.Group();

  const placeholder = new THREE.Group();
  const parts = [
    box(0.034, 0.04, 0.2, MATS.metal, 0, 0.025, -0.06), // slide
    box(0.008, 0.012, 0.01, MATS.metalDark, 0, 0.051, -0.15), // front sight
    box(0.02, 0.012, 0.012, MATS.metalDark, 0, 0.051, 0.03), // rear sight
    box(0.032, 0.024, 0.15, MATS.polymer, 0, -0.006, -0.05), // frame
  ];
  const grip = box(0.034, 0.12, 0.055, MATS.polymer, 0, -0.07, 0.022);
  grip.rotation.x = 0.28;
  parts.push(grip);
  parts.push(box(0.006, 0.005, 0.05, MATS.polymer, 0, -0.045, -0.045)); // trigger guard bottom
  parts.push(box(0.006, 0.03, 0.005, MATS.polymer, 0, -0.032, -0.068)); // trigger guard front
  // Disable frustum culling for viewmodel meshes
  parts.forEach((m) => { m.frustumCulled = false; placeholder.add(m); });
  group.add(placeholder);

  const arms = [
    arm([0.13, -0.36, 0.36], [0.0, -0.07, 0.03]), // firing hand
    arm([-0.24, -0.38, 0.26], [-0.025, -0.095, 0.035]), // support hand
  ];
  arms.forEach((a) => group.add(a));

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
  // One-handed: the bind pose holds the wrists ~22 cm apart even squeezed —
  // two hands can never meet on a pistol grip without bone surgery, and a
  // single gloved shooting hand is a classic FPS look anyway.
  attachArms(rig, arms, {
    gripR: new THREE.Vector3(0, -0.07, 0.03), // pistol grip (mitten target)
    zReach: 0.55,
    collapseLeft: true,
    name: 'pistol',
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

  // Placeholder mitten arms — replaced by GLB FPS arms when loaded.
  // Two-handed rifle grip: trigger hand on the pistol grip, support hand on
  // the handguard.
  const arms = [
    arm([0.17, -0.42, 0.44], [0, -0.055, 0.04]),    // trigger hand
    arm([-0.3, -0.42, 0.16], [0, -0.002, -0.3]),   // support hand on handguard
  ];
  arms.forEach((a) => group.add(a));

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
  // GLB FPS arms: two-handed rifle grip with proper finger curl. The support
  // hand cradles the handguard, trigger hand wraps the pistol grip.
  attachArms(rig, arms, {
    gripR: new THREE.Vector3(0, -0.055, 0.04),  // trigger hand on pistol grip
    gripL: new THREE.Vector3(0, -0.002, -0.3),  // support hand on handguard
    zReach: 0.62,
    squeezeX: 0.92,
    tilt: 0.06,
    name: 'rifle',
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

  const arms = [
    arm([0.14, -0.35, 0.35], [0.0, -0.015, 0.16]), // rod hand
    arm([-0.24, -0.4, 0.3], [-0.02, -0.03, 0.3]), // reel hand
  ];
  arms.forEach((a) => group.add(a));

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
  attachArms(rig, arms, {
    gripR: new THREE.Vector3(0, -0.015, 0.16), // rod hand (mitten target)
    gripL: new THREE.Vector3(-0.02, -0.03, 0.3), // reel hand
    zReach: 0.5,
    squeezeX: 0.65, // hands stacked on the handle
    name: 'rod',
  });
  return rig;
}
