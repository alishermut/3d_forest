// Merge Board — iteration 4: a chess-style board of FIGURES that merge.
//
// CONCEPT PIVOT (from the backpack). This is an auto-chess / merge-battler:
//   * A square board + a bench in front (the auto-chess layout we already had).
//   * Figures are 3D pieces. THREE matching figures placed next to each other
//     ON THE BOARD fuse into one bigger figure of the next star tier
//     (1★ -> 2★ -> 3★). "Different sizes" = the tiers: higher = bigger.
//   * Merging requires them to be ADJACENT on the board, so positioning is the
//     game ("board management"). The bench is just storage — no merging there.
//
// No combat yet — auto-battle is a later slice. This one is about making the
// place-and-merge loop satisfying. Reuses the grid / pick-place / adjacency
// machinery from the earlier iterations; footprints + rotation are dropped
// (every figure is one cell).
//
// Self-contained (three + OrbitControls only), like the other experiments.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CELL = 1.0;
const TILE = CELL - 0.08;
const LIFT = 0.85;
const REST = 0.0;
const MAX_STAR = 3;
const MERGE_T = 0.4;       // seconds for a merge animation

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const walletEl = document.getElementById('wallet');

// --- Renderer --------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x2e2838);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

// --- Scene + atmosphere ----------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x2e2838, 26, 70);

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 11, 10.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0.3);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 8;
controls.maxDistance = 26;
controls.maxPolarAngle = Math.PI * 0.47;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// --- Lighting --------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xfff4e2, 0x3a3142, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.1);
sun.position.set(5, 12, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 40;
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
sun.shadow.camera.top = 9; sun.shadow.camera.bottom = -9;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const fill = new THREE.DirectionalLight(0xcfe0ff, 0.45);
fill.position.set(-4, 6, 10);
scene.add(fill);

// --- Table -----------------------------------------------------------------
const table = new THREE.Mesh(
  new THREE.CylinderGeometry(10, 10, 0.6, 56),
  new THREE.MeshStandardMaterial({ color: 0x55473a, roughness: 0.92 })
);
table.position.set(0, -0.62, 0.3);
table.receiveShadow = true;
scene.add(table);

// ---------------------------------------------------------------------------
// Zones: the board (where figures merge & will fight) and the bench (storage).
// ---------------------------------------------------------------------------
const ZONES = [
  { id: 'board', cols: 6, rows: 6, ox: 0, oz: -1.0 },
  { id: 'bench', cols: 8, rows: 2, ox: 0, oz: 4.0 },
];
const zoneById = (id) => ZONES.find((z) => z.id === id);

function cellToWorld(zone, c, r) {
  return new THREE.Vector3(
    zone.ox + (c - (zone.cols - 1) / 2) * CELL,
    0,
    zone.oz + (r - (zone.rows - 1) / 2) * CELL
  );
}
function worldToCell(point) {
  for (const z of ZONES) {
    const cf = (point.x - z.ox) / CELL + (z.cols - 1) / 2;
    const rf = (point.z - z.oz) / CELL + (z.rows - 1) / 2;
    const c = Math.round(cf), r = Math.round(rf);
    if (c >= 0 && c < z.cols && r >= 0 && r < z.rows &&
        Math.abs(cf - c) <= 0.5 && Math.abs(rf - r) <= 0.5) {
      return { zoneId: z.id, c, r };
    }
  }
  return null;
}

// --- Board (checkerboard) + bench surface ----------------------------------
{
  const board = zoneById('board');
  const tileGeo = new THREE.BoxGeometry(TILE, 0.12, TILE);
  const light = new THREE.MeshStandardMaterial({ color: 0xe7d6b0, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x9c7b50, roughness: 0.85 });
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(board.cols + 0.5, 0.3, board.rows + 0.5),
    new THREE.MeshStandardMaterial({ color: 0x6f5638, roughness: 0.8 })
  );
  frame.position.set(board.ox, -0.16, board.oz);
  frame.receiveShadow = true; frame.castShadow = true;
  scene.add(frame);
  for (let c = 0; c < board.cols; c++)
    for (let r = 0; r < board.rows; r++) {
      const t = new THREE.Mesh(tileGeo, (c + r) % 2 ? dark : light);
      const p = cellToWorld(board, c, r);
      t.position.set(p.x, 0, p.z);
      t.receiveShadow = true;
      scene.add(t);
    }

  const bench = zoneById('bench');
  const tray = new THREE.Mesh(
    new THREE.BoxGeometry(bench.cols + 0.5, 0.34, bench.rows + 0.5),
    new THREE.MeshStandardMaterial({ color: 0x6e533a, roughness: 0.9 })
  );
  tray.position.set(bench.ox, -0.16, bench.oz);
  tray.receiveShadow = true; tray.castShadow = true;
  scene.add(tray);
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x856641, roughness: 0.95 });
  for (let c = 0; c < bench.cols; c++)
    for (let r = 0; r < bench.rows; r++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.1, TILE), slotMat);
      const p = cellToWorld(bench, c, r);
      s.position.set(p.x, 0, p.z);
      s.receiveShadow = true;
      scene.add(s);
    }
}

// ---------------------------------------------------------------------------
// Figure types. Each is a distinct primitive "creature" + color. Tier (star)
// scales the figure up and adds glow + star pips.
// ---------------------------------------------------------------------------
const TYPES = {
  slime: { name: 'Slime', color: 0x57b85a, shape: 'slime' },
  golem: { name: 'Golem', color: 0x8a93a0, shape: 'golem' },
  imp:   { name: 'Imp',   color: 0xd0563f, shape: 'imp' },
};

const STAR_SCALE = { 1: 0.8, 2: 1.05, 3: 1.32 };
const STAR_GLOW = { 1: 0.0, 2: 0.28, 3: 0.55 };

function buildShape(shape, mat) {
  const g = new THREE.Group();
  if (shape === 'slime') {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 14), mat);
    body.scale.y = 0.72; body.position.y = 0.24;
    g.add(body);
  } else if (shape === 'golem') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.4), mat);
    body.position.y = 0.26;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.28), mat);
    head.position.y = 0.6;
    g.add(body, head);
  } else { // imp
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 16), mat);
    body.position.y = 0.32;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), mat);
    head.position.y = 0.66;
    g.add(body, head);
  }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  return g;
}

const pipMat = new THREE.MeshStandardMaterial({
  color: 0xffe27a, emissive: 0xffcf4d, emissiveIntensity: 0.7, roughness: 0.4,
});

function buildFigure(typeKey, star) {
  const type = TYPES[typeKey];
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: type.color, roughness: 0.5, metalness: 0.1,
    emissive: new THREE.Color(type.color), emissiveIntensity: STAR_GLOW[star],
  });
  group.userData.mat = mat;
  group.userData.baseGlow = STAR_GLOW[star];

  const shape = buildShape(type.shape, mat);
  shape.scale.setScalar(STAR_SCALE[star]);
  group.add(shape);

  // Star pips floating above the figure.
  const top = 0.95 * STAR_SCALE[star] + 0.12;
  for (let i = 0; i < star; i++) {
    const pip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), pipMat);
    pip.position.set((i - (star - 1) / 2) * 0.14, top, 0);
    group.add(pip);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Instances + occupancy (one cell each — no footprints/rotation).
// ---------------------------------------------------------------------------
const instances = [];
const occupancy = new Map();
let nextId = 1;
const occKey = (zoneId, c, r) => `${zoneId}:${c},${r}`;

function instAt(zoneId, c, r) {
  const id = occupancy.get(occKey(zoneId, c, r));
  return id !== undefined ? instances.find((i) => i.id === id) : null;
}
function emptyAndInBounds(zoneId, c, r, ignoreId) {
  const z = zoneById(zoneId);
  if (c < 0 || c >= z.cols || r < 0 || r >= z.rows) return false;
  const occ = occupancy.get(occKey(zoneId, c, r));
  return occ === undefined || occ === ignoreId;
}

function placeInstance(inst) { occupancy.set(occKey(inst.anchor.zoneId, inst.anchor.c, inst.anchor.r), inst.id); }
function unplaceInstance(inst) {
  const k = occKey(inst.anchor.zoneId, inst.anchor.c, inst.anchor.r);
  if (occupancy.get(k) === inst.id) occupancy.delete(k);
}
function layoutGroup(inst, held) {
  const p = cellToWorld(zoneById(inst.anchor.zoneId), inst.anchor.c, inst.anchor.r);
  inst.group.position.set(p.x, held ? LIFT : REST, p.z);
}

function spawnFigure(typeKey, star, zoneId, c, r, pop = false) {
  const group = buildFigure(typeKey, star);
  const inst = { id: nextId++, typeKey, star, anchor: { zoneId, c, r }, group };
  layoutGroup(inst, false);
  if (pop) { group.scale.setScalar(0.001); popFx.push({ group, t: 0 }); }
  scene.add(group);
  instances.push(inst);
  placeInstance(inst);
  return inst;
}

function destroyInstance(inst) {
  inst.group.traverse((m) => { m.geometry?.dispose?.(); });
  scene.remove(inst.group);
  const i = instances.indexOf(inst);
  if (i >= 0) instances.splice(i, 1);
}

// --- Merge animation bookkeeping -------------------------------------------
const mergeFx = [];   // { group, from, to, t }   (the consumed trio shrinking in)
const popFx = [];     // { group, t }             (the upgraded figure popping out)

// ---------------------------------------------------------------------------
// The merge rule: 3 same-type same-star figures, orthogonally connected ON THE
// BOARD, fuse into one figure of the next star at the just-placed cell.
// ---------------------------------------------------------------------------
function connectedComponent(start) {
  const seen = new Set([start.id]);
  const stack = [start];
  const comp = [start];
  while (stack.length) {
    const cur = stack.pop();
    const { c, r } = cur.anchor;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = instAt('board', c + dc, r + dr);
      if (n && !seen.has(n.id) && n.typeKey === start.typeKey && n.star === start.star) {
        seen.add(n.id); comp.push(n); stack.push(n);
      }
    }
  }
  return comp;
}

function tryMergeAround(inst) {
  if (!inst || inst.anchor.zoneId !== 'board' || inst.star >= MAX_STAR) return;
  const comp = connectedComponent(inst);
  if (comp.length < 3) return;

  // Keep `inst` as the target; consume two others.
  const others = comp.filter((x) => x !== inst).slice(0, 2);
  const trio = [inst, ...others];
  const target = cellToWorld(zoneById('board'), inst.anchor.c, inst.anchor.r);
  target.y = REST;

  const { typeKey, star } = inst;
  const tc = inst.anchor.c, tr = inst.anchor.r;
  for (const x of trio) {
    unplaceInstance(x);
    const from = x.group.position.clone();
    instances.splice(instances.indexOf(x), 1);
    mergeFx.push({ group: x.group, from, to: target.clone(), t: 0 });
  }

  const up = spawnFigure(typeKey, star + 1, 'board', tc, tr, true);
  setStatus(`Merged 3× ${TYPES[typeKey].name} → ${'★'.repeat(star + 1)} ${TYPES[typeKey].name}`);
  updateLegend();
  tryMergeAround(up);   // cascade (the new tier may complete another trio)
}

// ---------------------------------------------------------------------------
// Interaction.
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

let held = null;        // { inst, origin:{zoneId,c,r} }
let hoverCell = null;
let hovered = null;

function setStatus(m) { statusEl.textContent = m; }

function updateLegend() {
  const counts = {};
  for (const i of instances) {
    const k = `${i.typeKey}${i.star}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const lines = Object.keys(TYPES).map((tk) => {
    const parts = [];
    for (let s = 1; s <= MAX_STAR; s++) {
      const n = counts[`${tk}${s}`] || 0;
      if (n) parts.push(`${'★'.repeat(s)}×${n}`);
    }
    return `${TYPES[tk].name.padEnd(6)} ${parts.join(' ') || '—'}`;
  });
  walletEl.textContent = lines.join('\n');
}

function updateHoverCell() {
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) { hoverCell = null; return; }
  hoverCell = worldToCell(hit);
}

function pickUp(inst) {
  unplaceInstance(inst);
  held = { inst, origin: { ...inst.anchor } };
  setStatus(`Carrying ${'★'.repeat(inst.star)} ${TYPES[inst.typeKey].name} — click to place, Esc to cancel.`);
}

function tryPlace() {
  if (!held || !hoverCell) return;
  const { inst } = held;
  if (!emptyAndInBounds(hoverCell.zoneId, hoverCell.c, hoverCell.r, inst.id)) {
    setStatus('That cell is taken.');
    return;
  }
  inst.anchor = { zoneId: hoverCell.zoneId, c: hoverCell.c, r: hoverCell.r };
  placeInstance(inst);
  layoutGroup(inst, false);
  const placed = inst;
  held = null;
  setStatus(placed.anchor.zoneId === 'board' ? 'Placed on the board.' : 'Placed on the bench.');
  tryMergeAround(placed);
  updateLegend();
}

function cancelHeld() {
  if (!held) return;
  const { inst } = held;
  inst.anchor = { ...held.origin };
  placeInstance(inst);
  layoutGroup(inst, false);
  held = null;
  setStatus('Returned it.');
}

// --- Highlight under the held figure ---------------------------------------
const hl = new THREE.Mesh(
  new THREE.BoxGeometry(TILE, 0.06, TILE),
  new THREE.MeshBasicMaterial({ color: 0x57d36b, transparent: true, opacity: 0.5 })
);
hl.position.y = 0.1; hl.visible = false;
scene.add(hl);

function updateHighlight() {
  hl.visible = false;
  if (!held || !hoverCell) return;
  const ok = emptyAndInBounds(hoverCell.zoneId, hoverCell.c, hoverCell.r, held.inst.id);
  const p = cellToWorld(zoneById(hoverCell.zoneId), hoverCell.c, hoverCell.r);
  hl.position.set(p.x, 0.1, p.z);
  hl.material.color.setHex(ok ? 0x57d36b : 0xe2544f);
  hl.visible = true;
}

// --- Pointer + key handlers ------------------------------------------------
function onPointerMove(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  updateHoverCell();

  if (held) {
    if (hoverCell) {
      const p = cellToWorld(zoneById(hoverCell.zoneId), hoverCell.c, hoverCell.r);
      held.inst.group.position.set(p.x, LIFT, p.z);
    }
  } else {
    const inst = hoverCell ? instAt(hoverCell.zoneId, hoverCell.c, hoverCell.r) : null;
    if (inst !== hovered) {
      if (hovered) layoutGroup(hovered, false);
      hovered = inst;
    }
  }
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (held) { tryPlace(); return; }
  if (!hoverCell) return;
  const inst = instAt(hoverCell.zoneId, hoverCell.c, hoverCell.r);
  if (inst) { hovered = null; pickUp(inst); }
}

function onKeyDown(e) { if (e.code === 'Escape' && held) cancelHeld(); }

renderer.domElement.addEventListener('pointermove', onPointerMove);
renderer.domElement.addEventListener('pointerdown', onPointerDown);
window.addEventListener('keydown', onKeyDown);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Starting figures: three of each type on the bench (board empty) -------
// Laid out so nothing auto-merges; you drag trios onto the board.
spawnFigure('slime', 1, 'bench', 0, 0);
spawnFigure('slime', 1, 'bench', 1, 0);
spawnFigure('slime', 1, 'bench', 2, 0);
spawnFigure('golem', 1, 'bench', 3, 0);
spawnFigure('golem', 1, 'bench', 4, 0);
spawnFigure('golem', 1, 'bench', 5, 0);
spawnFigure('imp', 1, 'bench', 6, 0);
spawnFigure('imp', 1, 'bench', 7, 0);
spawnFigure('imp', 1, 'bench', 0, 1);
updateLegend();

// --- Loop ------------------------------------------------------------------
const clock = new THREE.Clock();
let last = 0;
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  const dt = Math.min(t - last, 0.05); last = t;

  if (held) held.inst.group.position.y = LIFT + Math.sin(t * 4) * 0.04;
  if (hovered && !held) {
    const p = cellToWorld(zoneById(hovered.anchor.zoneId), hovered.anchor.c, hovered.anchor.r);
    hovered.group.position.set(p.x, REST + 0.14 + Math.sin(t * 3) * 0.02, p.z);
  }

  // Star-tier idle glow shimmer.
  for (const inst of instances) {
    if (held && inst === held.inst) continue;
    const base = inst.group.userData.baseGlow;
    if (base > 0) inst.group.userData.mat.emissiveIntensity = base + Math.sin(t * 3 + inst.id) * 0.12;
  }

  // Merge: consumed trio slides toward the target and shrinks away.
  for (let i = mergeFx.length - 1; i >= 0; i--) {
    const fx = mergeFx[i];
    fx.t += dt / MERGE_T;
    const k = Math.min(fx.t, 1);
    fx.group.position.lerpVectors(fx.from, fx.to, k);
    fx.group.position.y = THREE.MathUtils.lerp(fx.from.y, fx.to.y, k) + Math.sin(k * Math.PI) * 0.6;
    fx.group.scale.setScalar(1 - k);
    if (fx.t >= 1) {
      fx.group.traverse((m) => m.geometry?.dispose?.());
      scene.remove(fx.group);
      mergeFx.splice(i, 1);
    }
  }
  // Upgraded figure pops out with a slight overshoot.
  for (let i = popFx.length - 1; i >= 0; i--) {
    const fx = popFx[i];
    fx.t += dt / MERGE_T;
    const k = Math.min(fx.t, 1);
    const s = k < 0.7 ? (k / 0.7) * 1.15 : 1.15 - ((k - 0.7) / 0.3) * 0.15;
    fx.group.scale.setScalar(s);
    if (fx.t >= 1) { fx.group.scale.setScalar(1); popFx.splice(i, 1); }
  }

  updateHighlight();
  controls.update();
  renderer.render(scene, camera);
}
animate();

// Debug handle (matches the repo's convention).
window.__merge = {
  scene, camera, renderer, instances, occupancy, TYPES, ZONES,
  // Test helper: move a figure and run the merge check, like a real placement.
  _move(id, zoneId, c, r) {
    const inst = instances.find((i) => i.id === id);
    unplaceInstance(inst);
    inst.anchor = { zoneId, c, r };
    placeInstance(inst);
    layoutGroup(inst, false);
    tryMergeAround(inst);
    updateLegend();
    return instances.map((i) => ({ id: i.id, type: i.typeKey, star: i.star, at: i.anchor }));
  },
};
