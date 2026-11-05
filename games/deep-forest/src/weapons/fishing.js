import * as THREE from 'three';
import { loadGLB, measureRestBox } from '../core/assets.js';
import { getWaterLevel as physWaterLevel } from '../core/physics.js';
import { getHeight, getWaterLevel } from '../world/terrain.js';
import {
  playWhoosh,
  playImpact,
  playPlip,
  playBite,
  playReelTick,
  playLineSnap,
  playCatchJingle,
} from './audio.js';

// Fishing (Phases 50-52). The loop:
//   idle -> charging (hold LMB) -> flying (release) -> floating (landed on
//   water; nibble fakeouts, then the real bite) -> fighting (hook on LMB
//   within the bite window; tension tug-of-war: hold to reel, release to
//   yield) -> caught (fish arcs out of the water to a presentation pose)
//   or back to idle via reeling / line snap / slipped hook.
//
// Design notes (researched): reaction-test hook + tension fight — the
// balance-bar minigame (Stardew) is a 2D overlay that fights first person,
// pure waiting (Minecraft) is boring. The bobber is a manual ballistic
// (shell-casing pattern); physics.getWaterLevel includes the live Gerstner
// wave height, so the bobber rides the same waves the shader draws.

const CHARGE_MAX = 1.3; // seconds to full power
const CAST_MIN = 7;
const CAST_MAX = 21;
const REEL_SPEED = 4.2; // m/s of line retrieved while fighting
const RETRIEVE_SPEED = 13; // m/s on an empty reel-in
const LINE_PTS = 24;

const SPECIES = [
  { file: 'fish_a', name: 'PERCH', size: [22, 42], weight: 0.45, fight: 0.8 },
  { file: 'fish_b', name: 'RUDD', size: [16, 32], weight: 0.35, fight: 0.6 },
  { file: 'fish_c', name: 'PIKE', size: [38, 80], weight: 0.2, fight: 1.25 },
];

const _v = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _mid = new THREE.Vector3();

export class FishingSystem {
  constructor({ scene, camera, viewmodel, impacts, hud }) {
    this.scene = scene;
    this.camera = camera;
    this.vm = viewmodel;
    this.impacts = impacts;
    this.hud = hud;

    this.state = 'idle';
    this.holding = false;
    this.chargeT = 0;
    this.castFlick = 0; // brief forward flick after release
    this.elapsed = 0;

    // bobber: classic red-top/white-bottom float
    this.bobber = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.55 });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), white);
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 10), red);
    top.position.y = 0.045;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.05, 6), red);
    antenna.position.y = 0.085;
    this.bobber.add(ball, top, antenna);
    this.bobber.visible = false;
    scene.add(this.bobber);
    this.bobberVel = new THREE.Vector3();
    this.bobDip = 0; // transient downward offset (nibbles/bite)

    // line: polyline updated every frame (bezier tip -> bobber with sag)
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3)
    );
    this.line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x202a24, transparent: true, opacity: 0.85 })
    );
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);

    // wait/bite state
    this.waitTimer = 0;
    this.nibbleTimer = 0;
    this.biteWindow = 0;

    // fight state
    this.fish = null; // { species, sizeCm, fightK }
    this.tension = 0;
    this.lineLen = 0;
    this.slackT = 0;
    this.runTimer = 0;
    this.runStrength = 0;
    this.runDir = 0;
    this.tickTimer = 0;
    this.splashTimer = 0;

    // catch presentation
    this.prize = null; // { obj, t, from, hold }
    this.catches = 0;

    this.tensionEl = document.getElementById('tension');
    this.tensionFill = this.tensionEl?.firstElementChild;
    this.cardEl = document.getElementById('catchcard');
    this.cardTimer = 0;

    window.__fishing = this; // debug/verification handle
  }

  get active() {
    return this.state !== 'idle' && this.state !== 'charging';
  }

  // --- input ---------------------------------------------------------------
  press() {
    this.holding = true;
    if (this.state === 'idle') {
      this.state = 'charging';
      this.chargeT = 0;
    } else if (this.state === 'floating') {
      if (this.biteWindow > 0) this._hook();
      else this._startRetrieve();
    } else if (this.state === 'flying') {
      this._startRetrieve();
    }
    // fighting: holding is read in update
  }

  release() {
    this.holding = false;
    if (this.state === 'charging') this._cast();
  }

  // Called when the player switches away from the rod (or any hard reset).
  cancel() {
    this._clearPrize();
    this.bobber.visible = false;
    this.line.visible = false;
    this.state = 'idle';
    this.vm.extraPose = null;
    this.fish = null;
    this._showTension(false);
  }

  // --- transitions -----------------------------------------------------------
  _cast() {
    const k = Math.min(this.chargeT / CHARGE_MAX, 1);
    const power = THREE.MathUtils.lerp(CAST_MIN, CAST_MAX, k * k * (3 - 2 * k));
    this.vm.getMuzzleWorld(this.camera, _tip);
    this.camera.getWorldDirection(_fwd);
    this.bobber.position.copy(_tip);
    this.bobberVel
      .copy(_fwd)
      .multiplyScalar(power)
      .addScaledVector(this.camera.up, power * 0.22);
    this.bobber.visible = true;
    this.line.visible = true;
    this.state = 'flying';
    this.castFlick = 0.22;
    playWhoosh();
  }

  _land() {
    this.impacts.spawnSplash(this.bobber.position);
    playImpact('water', this.bobber.position.distanceTo(this.camera.position));
    this.state = 'floating';
    this.waitTimer = 3 + Math.random() * 7;
    this.nibbleTimer = 1 + Math.random() * 2;
    this.biteWindow = 0;
    this.bobDip = 0;
  }

  _startRetrieve() {
    this.state = 'reeling';
    this.biteWindow = 0;
  }

  _hook() {
    // pick the fish: weighted species + size roll (bigger = harder)
    let roll = Math.random();
    let species = SPECIES[0];
    for (const s of SPECIES) {
      if (roll < s.weight) {
        species = s;
        break;
      }
      roll -= s.weight;
    }
    const sizeT = Math.random() * Math.random(); // small fish more common
    const sizeCm = Math.round(
      THREE.MathUtils.lerp(species.size[0], species.size[1], sizeT)
    );
    this.fish = {
      species,
      sizeCm,
      fightK: species.fight * (0.75 + sizeT * 0.7),
    };
    this.state = 'fighting';
    this.tension = 0.3;
    this.slackT = 0;
    this.vm.getMuzzleWorld(this.camera, _tip);
    this.lineLen = _tip.distanceTo(this.bobber.position);
    this.runTimer = 0;
    this.splashTimer = 0.2;
    this._showTension(true);
    this.impacts.spawnSplash(this.bobber.position);
  }

  _snap() {
    playLineSnap();
    this._showTension(false);
    this.fish = null;
    this.bobber.visible = false;
    this.line.visible = false;
    this.state = 'idle';
    this._flashCard('LINE SNAPPED', 'too much tension');
  }

  _slip() {
    playPlip(this.bobber.position.distanceTo(this.camera.position));
    this._showTension(false);
    this.fish = null;
    this._startRetrieve();
    this._flashCard('IT GOT AWAY', 'keep the line tight');
  }

  async _catch() {
    const fish = this.fish;
    this.fish = null;
    this._showTension(false);
    this.state = 'caught';
    this.impacts.spawnSplash(this.bobber.position);
    playImpact('water', this.bobber.position.distanceTo(this.camera.position));
    this.bobber.visible = false;

    // build the prize prop from the species GLB, scaled by the size roll
    try {
      const gltf = await loadGLB(`/models/${fish.species.file}.glb`);
      if (this.state !== 'caught') return; // cancelled while loading
      const obj = gltf.scene.clone();
      const box = measureRestBox(obj);
      const len = box.getSize(_v).z || 1;
      obj.scale.setScalar(fish.sizeCm / 100 / len);
      this.prize = {
        obj,
        t: 0,
        hold: 0,
        from: this.bobber.position.clone(),
        fish,
      };
      this.scene.add(obj);
    } catch {
      this.prize = { obj: null, t: 0, hold: 0, from: this.bobber.position.clone(), fish };
    }
  }

  _finishCatch() {
    const fish = this.prize.fish;
    this.catches++;
    playCatchJingle();
    this._flashCard(
      `CAUGHT — ${fish.species.name} · ${fish.sizeCm} cm`,
      `total catches: ${this.catches}`
    );
    this.hud.set('catches', this.catches);
  }

  _clearPrize() {
    if (this.prize?.obj) this.scene.remove(this.prize.obj);
    this.prize = null;
  }

  // --- HUD helpers -----------------------------------------------------------
  _showTension(on) {
    this.tensionEl?.classList.toggle('hidden', !on);
  }

  _flashCard(title, sub) {
    if (!this.cardEl) return;
    this.cardEl.innerHTML = `${title}<small>${sub}</small>`;
    this.cardEl.classList.add('show');
    this.cardTimer = 2.6;
  }

  // --- per-frame ---------------------------------------------------------------
  update(dt, isCurrent) {
    this.elapsed += dt;
    if (this.castFlick > 0) this.castFlick -= dt;
    if (this.cardTimer > 0) {
      this.cardTimer -= dt;
      if (this.cardTimer <= 0) this.cardEl?.classList.remove('show');
    }
    if (!isCurrent) return;

    switch (this.state) {
      case 'charging': {
        this.chargeT = Math.min(this.chargeT + dt, CHARGE_MAX);
        const k = this.chargeT / CHARGE_MAX;
        this.vm.extraPose = { rx: 0.55 * k, py: -0.04 * k, pz: 0.1 * k };
        break;
      }
      case 'flying': {
        this.bobberVel.y -= 9.81 * dt;
        this.bobberVel.multiplyScalar(Math.exp(-0.12 * dt)); // light drag
        this.bobber.position.addScaledVector(this.bobberVel, dt);
        const p = this.bobber.position;
        const lvl = physWaterLevel(p.x, p.z);
        if (lvl !== null && p.y <= lvl) {
          p.y = lvl;
          this._land();
        } else if (p.y <= getHeight(p.x, p.z) + 0.04) {
          this._startRetrieve(); // landed on dirt
        }
        this._pose(0);
        break;
      }
      case 'floating': {
        const p = this.bobber.position;
        // ride the waves; ease transient dips back out
        this.bobDip *= Math.exp(-3.5 * dt);
        p.y = (physWaterLevel(p.x, p.z) ?? p.y) + 0.02 - this.bobDip;

        if (this.biteWindow > 0) {
          this.biteWindow -= dt;
          if (this.biteWindow <= 0) {
            // missed it — fish loses interest, the wait restarts
            this.waitTimer = 4 + Math.random() * 8;
            this.nibbleTimer = 1.5 + Math.random() * 2;
          }
        } else {
          this.nibbleTimer -= dt;
          this.waitTimer -= dt;
          if (this.waitTimer <= 0) {
            // THE BITE
            this.biteWindow = 0.85;
            this.bobDip = 0.16;
            playBite(p.distanceTo(this.camera.position));
            this.impacts.spawnSplash(p);
          } else if (this.nibbleTimer <= 0) {
            // fakeout nibble
            this.bobDip = 0.05 + Math.random() * 0.03;
            playPlip(p.distanceTo(this.camera.position));
            this.nibbleTimer = 1 + Math.random() * 2.4;
          }
        }
        this._pose(0);
        break;
      }
      case 'fighting': {
        const p = this.bobber.position;
        this.vm.getMuzzleWorld(this.camera, _tip);

        // fish runs: periodic bursts of pull, direction wobbles
        this.runTimer -= dt;
        if (this.runTimer <= 0) {
          this.runTimer = 0.7 + Math.random() * 1.2;
          this.runStrength = (0.4 + Math.random() * 0.6) * this.fish.fightK;
          this.runDir = (Math.random() - 0.5) * 2.4;
        }

        if (this.holding) {
          this.lineLen -= REEL_SPEED * dt;
          this.tension += (0.32 + this.runStrength * 0.55) * dt;
          this.slackT = 0;
          this.tickTimer -= dt;
          if (this.tickTimer <= 0) {
            playReelTick();
            this.tickTimer = 0.09;
          }
        } else {
          this.tension -= 0.5 * dt;
          this.lineLen += this.runStrength * 1.5 * dt;
          this.slackT += dt;
        }
        this.tension = THREE.MathUtils.clamp(this.tension, 0, 1);

        if (this.tension >= 1) return this._snap();
        if (this.slackT > 3.2) return this._slip();

        // bobber dragged along the line direction + lateral fish runs
        _v.copy(p).sub(_tip);
        _v.y = 0;
        const horiz = Math.max(_v.length(), 0.001);
        _v.divideScalar(horiz);
        const lateral = _mid.set(-_v.z, 0, _v.x).multiplyScalar(this.runDir * this.runStrength * dt);
        const targetHoriz = Math.max(Math.sqrt(Math.max(this.lineLen * this.lineLen - 4, 1)), 1.2);
        p.x = _tip.x + _v.x * targetHoriz + lateral.x;
        p.z = _tip.z + _v.z * targetHoriz + lateral.z;
        p.y = (physWaterLevel(p.x, p.z) ?? p.y) - 0.05 - this.tension * 0.08;

        // splashes while it thrashes
        this.splashTimer -= dt;
        if (this.splashTimer <= 0) {
          this.impacts.spawnSplash(p);
          this.splashTimer = 0.5 + Math.random() * 0.7;
        }

        // rod bend + shake scale with tension
        this._pose(this.tension);

        // HUD bar
        if (this.tensionFill) {
          this.tensionFill.style.width = `${(this.tension * 100).toFixed(0)}%`;
          this.tensionFill.style.background =
            this.tension < 0.55 ? '#7fc35a' : this.tension < 0.8 ? '#e0b33c' : '#d6452f';
        }

        if (this.lineLen <= 2.3) this._catch();
        break;
      }
      case 'reeling': {
        const p = this.bobber.position;
        this.vm.getMuzzleWorld(this.camera, _tip);
        _v.copy(_tip).sub(p);
        const d = _v.length();
        if (d < 1.0) {
          this.bobber.visible = false;
          this.line.visible = false;
          this.state = 'idle';
          this.vm.extraPose = null;
        } else {
          p.addScaledVector(_v.normalize(), Math.min(RETRIEVE_SPEED * dt, d));
          // skim: don't drag underground
          const ground = getHeight(p.x, p.z) + 0.05;
          const lvl = getWaterLevel(p.x, p.z);
          p.y = Math.max(p.y, lvl !== null ? lvl + 0.02 : ground);
          this.tickTimer -= dt;
          if (this.tickTimer <= 0) {
            playReelTick();
            this.tickTimer = 0.11;
          }
        }
        this._pose(0.15);
        break;
      }
      case 'caught': {
        if (!this.prize) break; // GLB still loading
        const pr = this.prize;
        if (pr.t < 1) {
          pr.t = Math.min(pr.t + dt / 0.85, 1);
          // arc: water exit -> in front of the camera, overshooting apex
          this.camera.getWorldDirection(_fwd);
          _v.copy(this.camera.position)
            .addScaledVector(_fwd, 0.95)
            .addScaledVector(this.camera.up, -0.18);
          const t = pr.t;
          const apexY = Math.max(pr.from.y, _v.y) + 1.7;
          if (pr.obj) {
            pr.obj.position.lerpVectors(pr.from, _v, t);
            pr.obj.position.y +=
              (apexY - (pr.from.y + (_v.y - pr.from.y) * 0.5)) * 4 * t * (1 - t) * 0.5;
            pr.obj.rotation.y += 6 * dt;
          }
          if (pr.t >= 1) this._finishCatch();
        } else {
          pr.hold += dt;
          if (pr.obj) {
            // dangle in front of the camera, wiggling
            this.camera.getWorldDirection(_fwd);
            pr.obj.position
              .copy(this.camera.position)
              .addScaledVector(_fwd, 0.95)
              .addScaledVector(this.camera.up, -0.18);
            pr.obj.rotation.set(
              Math.sin(this.elapsed * 14) * 0.2,
              pr.obj.rotation.y + 2.5 * dt,
              Math.sin(this.elapsed * 19) * 0.3
            );
          }
          if (pr.hold > 1.7) {
            this._clearPrize();
            this.line.visible = false;
            this.state = 'idle';
            this.vm.extraPose = null;
          }
        }
        this._pose(0.1);
        break;
      }
      default:
        this.vm.extraPose = null;
    }

    this._updateLine();
  }

  // Rod pose: raised + bent back by tension, with a shake on top.
  _pose(tension) {
    const shake = tension > 0.02 ? Math.sin(this.elapsed * 31) * 0.02 * tension : 0;
    const flick = this.castFlick > 0 ? -0.5 * (this.castFlick / 0.22) : 0;
    this.vm.extraPose = {
      rx: 0.18 * tension + shake + flick,
      py: -0.02 * tension,
      rz: shake * 0.6,
    };
  }

  _updateLine() {
    if (!this.line.visible) return;
    this.vm.getMuzzleWorld(this.camera, _tip);
    const end =
      this.state === 'caught' && this.prize?.obj
        ? this.prize.obj.position
        : this.bobber.position;
    const dist = _tip.distanceTo(end);
    // sag: taut while fighting/flying, lazy droop while floating
    const sagBase =
      this.state === 'fighting' ? 0.02 : this.state === 'flying' ? 0.08 : 0.3;
    const sag = Math.min(sagBase * dist, 2.5);
    const pos = this.line.geometry.attributes.position;
    for (let i = 0; i < LINE_PTS; i++) {
      const t = i / (LINE_PTS - 1);
      _v.lerpVectors(_tip, end, t);
      _v.y -= sag * 4 * t * (1 - t);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
    pos.needsUpdate = true;
  }
}
