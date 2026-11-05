import * as THREE from 'three';
import { Viewmodel } from './viewmodel.js';
import { ImpactEffects } from './impacts.js';
import { Projectiles } from './projectiles.js';
import { FishingSystem } from './fishing.js';
import { raycastBullet, applyHitImpulse } from '../core/physics.js';
import {
  playShot,
  playDryClick,
  playReload,
  playWhoosh,
  playImpact,
} from './audio.js';

// Weapon framework (Phase 40): knife / pistol / M16-style rifle.
// LMB fire (semi | auto | melee) · R reload · 1/2/3 + wheel switch.
// Owns the viewmodel overlay, projectiles, impact FX and the ammo HUD.

const WEAPONS = {
  knife: {
    label: 'KNIFE',
    melee: true,
    interval: 0.5,
    range: 2.4,
    impulse: 45,
    strikeDelay: 0.12, // hit lands mid-slash, not on click
  },
  pistol: {
    label: 'PISTOL',
    auto: false,
    interval: 0.16,
    mag: 12,
    speed: 110,
    spread: 0.006,
    recoil: 0.8,
    kick: 0.55, // camera pitch impulse, rad/s
    impulse: 14,
    reload: 1.2,
  },
  rifle: {
    label: 'M16',
    auto: true,
    interval: 1 / 12, // ~720 rpm
    mag: 30,
    speed: 150,
    spread: 0.009,
    recoil: 0.55,
    kick: 0.33,
    impulse: 20,
    reload: 1.6,
  },
  rod: {
    label: 'ROD',
    rod: true, // input handled by FishingSystem (press/release)
    interval: 0.15,
  },
};
const ORDER = ['knife', 'pistol', 'rifle', 'rod'];

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class WeaponSystem {
  constructor({ scene, camera, player, hud }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.hud = hud;

    this.viewmodel = new Viewmodel();
    this.impacts = new ImpactEffects(scene);
    this.projectiles = new Projectiles(scene, this.impacts, camera);
    this.fishing = new FishingSystem({
      scene,
      camera,
      viewmodel: this.viewmodel,
      impacts: this.impacts,
      hud,
    });

    // Muzzle light lives in the WORLD scene so shots illuminate nearby
    // trunks/ground. Added once at startup (adding/removing lights later
    // would recompile every material — a guaranteed hitch).
    this.flashLight = new THREE.PointLight(0xffc878, 0, 16, 2);
    scene.add(this.flashLight);

    this.current = 'rifle';
    this.viewmodel.setWeapon(this.current);
    this.ammo = { pistol: WEAPONS.pistol.mag, rifle: WEAPONS.rifle.mag };

    this.cooldown = 0;
    this.mouseDown = false;
    this.bloom = 0; // auto-fire spread growth
    this.kickVel = 0; // camera recoil pitch velocity
    this.reloadTimer = 0;
    this.strikeTimer = 0; // pending knife hit
    this.prevYaw = 0;
    this.prevPitch = 0;
    this._testMode = false; // verification hook: fire without pointer lock

    this.ammoEl = document.getElementById('ammo');

    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.active) return;
      this.mouseDown = true;
      if (this.def().rod) {
        if (!this.busy) this.fishing.press();
        return;
      }
      this.tryFire();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      this.mouseDown = false;
      if (this.def().rod) this.fishing.release();
    });
    window.addEventListener('blur', () => (this.mouseDown = false));
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'Digit1') this.switchTo('knife');
      if (e.code === 'Digit2') this.switchTo('pistol');
      if (e.code === 'Digit3') this.switchTo('rifle');
      if (e.code === 'Digit4') this.switchTo('rod');
      if (e.code === 'KeyR') this.reload();
    });
    window.addEventListener('wheel', (e) => {
      if (!this.active) return;
      const i = ORDER.indexOf(this.current);
      const n = ORDER.length;
      this.switchTo(ORDER[(i + (e.deltaY > 0 ? 1 : n - 1)) % n]);
    });

    this.updateHud();
    window.__weapons = this; // debug/verification handle
  }

  get active() {
    return this.player.locked || this._testMode;
  }

  get busy() {
    return this.viewmodel.switching || this.reloadTimer > 0;
  }

  def() {
    return WEAPONS[this.current];
  }

  switchTo(name) {
    if (name === this.current || this.viewmodel.switching || this.reloadTimer > 0)
      return;
    if (this.def().rod) this.fishing.cancel(); // stow the line with the rod
    this.viewmodel.startSwitch(name, () => {
      this.current = name;
      this.updateHud();
    });
  }

  reload() {
    const def = this.def();
    if (def.melee || def.rod || this.busy || this.ammo[this.current] >= def.mag) return;
    this.reloadTimer = def.reload;
    this.viewmodel.startReload(def.reload, (stage) => playReload(stage));
  }

  tryFire() {
    if (!this.active || this.cooldown > 0 || this.busy) return;
    const def = this.def();
    if (def.rod) return; // fishing input flows through press()/release()

    if (def.melee) {
      this.cooldown = def.interval;
      this.viewmodel.startAttack(0.34);
      this.strikeTimer = def.strikeDelay;
      playWhoosh();
      return;
    }

    if (this.ammo[this.current] <= 0) {
      this.cooldown = 0.3;
      playDryClick();
      this.reload(); // auto-reload on empty trigger pull
      return;
    }

    this.cooldown = def.interval;
    this.ammo[this.current]--;

    // camera basis
    this.camera.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, this.camera.up).normalize();
    _up.crossVectors(_right, _fwd).normalize();

    // origin: the world point that sits on screen exactly at the drawn
    // muzzle, so the tracer visibly leaves the barrel
    this.viewmodel.getMuzzleWorld(this.camera, _origin);

    // direction: from the muzzle, converging onto the crosshair line at
    // ~200 m (so shots still land center screen) + spread (rifle blooms
    // while held)
    const spread = def.spread * (1 + this.bloom * 1.6);
    _dir
      .copy(this.camera.position)
      .addScaledVector(_fwd, 200)
      .sub(_origin)
      .normalize()
      .addScaledVector(_right, (Math.random() * 2 - 1) * spread)
      .addScaledVector(_up, (Math.random() * 2 - 1) * spread)
      .normalize();
    this.projectiles.spawn(_origin, _dir, def.speed, def.impulse);
    if (def.auto) this.bloom = Math.min(this.bloom + 0.3, 1);

    // feedback: viewmodel kick, camera climb, flash sprite + world light
    this.viewmodel.triggerRecoil(def.recoil);
    this.viewmodel.flash();
    this.kickVel += def.kick;
    this.flashLight.position
      .copy(this.camera.position)
      .addScaledVector(_fwd, 1.4);
    this.flashLight.intensity = 130;
    playShot(this.current);

    // shells leave the receiver: a bit behind the muzzle, toward the body
    this.projectiles.ejectShell(
      _origin
        .clone()
        .addScaledVector(_fwd, -0.25)
        .addScaledVector(_up, -0.02),
      _right,
      _up,
      _fwd
    );
    this.updateHud();
  }

  // Knife hit lands mid-swing: short ray straight out of the camera.
  _strike() {
    const def = WEAPONS.knife;
    this.camera.getWorldDirection(_fwd);
    const hit = raycastBullet(this.camera.position, _fwd, def.range);
    if (!hit) return;
    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    this.impacts.spawnImpact(point, normal, hit.kind, { decal: false });
    playImpact(hit.kind, hit.dist);
    if (hit.body) applyHitImpulse(hit.body, _fwd, hit.point, def.impulse);
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.bloom *= Math.exp(-3 * dt);

    // pending knife strike
    if (this.strikeTimer > 0) {
      this.strikeTimer -= dt;
      if (this.strikeTimer <= 0) this._strike();
    }

    // reload completion refills the mag
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.ammo[this.current] = this.def().mag;
        this.updateHud();
      }
    }

    // auto fire while held
    if (this.mouseDown && this.def().auto) this.tryFire();
    // held melee re-swings
    if (this.mouseDown && this.def().melee) this.tryFire();

    // camera recoil climb (decays, integrates into the look pitch)
    if (Math.abs(this.kickVel) > 1e-4) {
      this.camera.rotateX(this.kickVel * dt);
      this.kickVel *= Math.exp(-9 * dt);
    }

    // muzzle light decay (≈2 frames of glow)
    if (this.flashLight.intensity > 0) {
      this.flashLight.intensity *= Math.exp(-30 * dt);
      if (this.flashLight.intensity < 1) this.flashLight.intensity = 0;
    }

    // look velocity for viewmodel sway
    _euler.setFromQuaternion(this.camera.quaternion);
    let yawVel = 0;
    let pitchVel = 0;
    if (dt > 1e-5) {
      let dYaw = _euler.y - this.prevYaw;
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      yawVel = dYaw / dt;
      pitchVel = (_euler.x - this.prevPitch) / dt;
    }
    this.prevYaw = _euler.y;
    this.prevPitch = _euler.x;

    this.fishing.update(dt, this.current === 'rod' && !this.busy);

    this.viewmodel.update(dt, {
      lookYawVel: yawVel,
      lookPitchVel: pitchVel,
      speed: this.player.velocity.length(),
      bobPhase: this.player.bobPhase,
    });
    this.projectiles.update(dt);
    this.impacts.update(dt);
  }

  renderViewmodel(renderer) {
    this.viewmodel.render(renderer);
  }

  updateHud() {
    const def = this.def();
    this.hud.set('weapon', def.label);
    this.ammoEl.textContent =
      def.melee || def.rod
        ? def.rod
          ? 'ROD  hold LMB to cast'
          : def.label
        : `${def.label}  ${this.ammo[this.current]} / ∞`;
  }
}
