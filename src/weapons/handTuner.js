// Hand-pose tuner (dev tool) — a lil-gui panel to dial in the FPS-arm grip
// on the live viewmodel: wrist orientation + per-hand finger curl. Press H in
// game to toggle. Tune until the fingers wrap the handle and the wrist angle
// reads right, hit "save" (localStorage + JSON to clipboard), then paste the
// JSON back so I can bake it into models.js defaultGripPose / per-weapon.
//
// Targets the CURRENTLY equipped weapon's rig.handRig (built in models.js once
// the FPS-arms GLB loads). No effect until the arms have loaded.

import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

let gui = null;

export function toggleHandTuner(viewmodel) {
  if (gui) { gui.destroy(); gui = null; return false; }

  const name = viewmodel.current;
  const rig = viewmodel.rigs[name];
  if (!rig || !rig.handRig) {
    console.warn('[handTuner] arms not loaded yet for', name, '— equip the weapon and retry');
    return false;
  }

  const hr = rig.handRig;
  const pose = hr.pose;
  const apply = () => hr.applyPose(pose);

  gui = new GUI({ title: `Hand Pose — ${name}` });
  gui.domElement.style.zIndex = 30;

  gui.add(pose, 'axis', ['x', 'y', 'z']).name('curl axis').onChange(apply);
  gui.add(pose, 'sign', { '+': 1, '−': -1 }).name('curl sign').onChange(apply);

  // Whole-arms placement — move/rotate/scale the entire arm assembly. This is
  // what fixes "the arm comes in sideways": rotate the whole rig so the hands
  // come up from the camera, then nudge position.
  const rg = pose.rig;
  const fp = gui.addFolder('Whole arms — placement');
  fp.add(rg, 'px', -0.6, 0.6, 0.005).name('move X (left/right)').onChange(apply);
  fp.add(rg, 'py', -0.6, 0.6, 0.005).name('move Y (down/up)').onChange(apply);
  fp.add(rg, 'pz', -0.6, 0.6, 0.005).name('move Z (near/far)').onChange(apply);
  fp.add(rg, 'rx', -3.2, 3.2, 0.02).name('rotate pitch').onChange(apply);
  fp.add(rg, 'ry', -3.2, 3.2, 0.02).name('rotate yaw').onChange(apply);
  fp.add(rg, 'rz', -3.2, 3.2, 0.02).name('rotate roll').onChange(apply);
  fp.add(rg, 'scale', 0.4, 2.0, 0.02).name('scale').onChange(apply);

  for (const [side, label] of [['R', 'Right (trigger)'], ['L', 'Left (support)']]) {
    const ps = pose[side];
    if (!ps) continue;
    const f = gui.addFolder(label);
    f.add(ps.arm, 'x', -1.6, 1.6, 0.02).name('arm pitch').onChange(apply);
    f.add(ps.arm, 'y', -1.6, 1.6, 0.02).name('arm yaw').onChange(apply);
    f.add(ps.arm, 'z', -1.6, 1.6, 0.02).name('arm roll').onChange(apply);
    f.add(ps.elbow, 'x', -1.6, 1.6, 0.02).name('elbow bend').onChange(apply);
    f.add(ps.wrist, 'x', -1.6, 1.6, 0.02).name('wrist pitch').onChange(apply);
    f.add(ps.wrist, 'y', -1.6, 1.6, 0.02).name('wrist yaw').onChange(apply);
    f.add(ps.wrist, 'z', -1.6, 1.6, 0.02).name('wrist roll').onChange(apply);
    f.add(ps, 'thumb', 0, 1, 0.02).name('thumb curl').onChange(apply);
    f.add(ps, 'index', 0, 1, 0.02).name('index curl').onChange(apply);
    f.add(ps, 'fingers', 0, 1, 0.02).name('fingers curl').onChange(apply);
    f.close();
  }

  const io = gui.addFolder('Save / load');
  io.add({ save: () => {
    const json = JSON.stringify(pose, null, 2);
    try { localStorage.setItem('handpose.' + name, json); } catch {}
    navigator.clipboard?.writeText(json).catch(() => {});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `handpose-${name}.json`; a.click(); URL.revokeObjectURL(a.href);
    console.log('[handTuner] saved + copied:', json);
  } }, 'save').name('★ save + copy JSON');
  io.add({ reset: () => { location.reload(); } }, 'reset').name('reset (reload)');

  apply();
  return true;
}
