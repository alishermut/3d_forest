import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { GodraysPass } from 'three-good-godrays';
import { Stats } from './core/stats.js';
import { Hud } from './core/hud.js';
import { loadTexture } from './core/assets.js';
import { PlayerControls } from './player/controls.js';
import { getHeight, createTerrain, SPAWN } from './world/terrain.js';
import {
  createTrees,
  updateTrees,
  treeColliders,
  logColliders,
  worldTreeFlares,
} from './world/trees.js';
import {
  initPhysics,
  movePlayer,
  stepPhysics,
  teleportPlayer,
  setWaveTime,
  getWaterLevel,
  PLAYER,
} from './core/physics.js';
import {
  createWater,
  updateWater,
  prepareWater,
  setWaterSize,
  WATER_EXCLUDED_LAYER,
} from './world/water.js';
import { createRocks, rockColliders } from './world/rocks.js';
import {
  createAtmosphere,
  sunDirection,
  FOG_DENSITY,
  FOG_COLOR,
  setTimeOfDay,
  getTimeOfDay,
  getExposure,
} from './world/atmosphere.js';
import { createGrass, updateGrass } from './world/grass.js';
import { createWheat, updateWheat } from './world/wheat.js';
import { createFlowers } from './world/flowers.js';
import { createInsects, updateInsects } from './world/insects.js';
import { createBirds, updateBirds, enableBirdCalls } from './world/birds.js';
import { createFireflies, updateFireflies } from './world/fireflies.js';
import { createFish, updateFish } from './world/fish.js';
import { createAnimals, updateAnimals } from './world/animals.js';
import { createDust, updateDust } from './world/dust.js';
import { WeaponSystem } from './weapons/weapons.js';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
// antialias: false (perf batch 2026-06-11) — the composer renders into its
// own HalfFloat buffers and the canvas only ever receives the final
// fullscreen quad; SMAA (in the bloom EffectPass) does the antialiasing.
// With antialias: true the browser still allocates and resolves an MSAA
// backbuffer for that quad every frame — pure waste at dpr 2.
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap is deprecated in three r183+ (auto-converts to PCF with a
// console warning) — use PCFShadowMap directly.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.getElementById('app').appendChild(renderer.domElement);
// Debug handles for the engine arc (perf measurement, freecam inspection).
window.__renderer = renderer;
window.__game = { scene: null, camera: null }; // filled below

// ---------------------------------------------------------------------------
// Scene + camera
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();

// far 900 (Phase 38): the compacted 900 m world fits entirely inside the
// far plane from anywhere — no horizon/rim pop possible. Affordable because
// compaction roughly halved the worst-case vertex load.
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  900
);
window.__game.scene = scene;
window.__game.camera = camera;
// Phase 28 debug: scrub the clock from the console/verification tooling.
window.__game.setTimeOfDay = setTimeOfDay;
window.__game.getTimeOfDay = getTimeOfDay;
// Grass/flowers/dust live on this extra layer so the water pre-passes can
// drop them; the main camera still renders everything.
camera.layers.enable(WATER_EXCLUDED_LAYER);
camera.position.set(SPAWN.x, getHeight(SPAWN.x, SPAWN.z) + 1.7, SPAWN.z);
// Spawn facing the sun so the first thing you see is light through fog.
camera.lookAt(
  camera.position.clone().add(new THREE.Vector3(sunDirection.x, 0, sunDirection.z))
);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
async function buildWorld() {
  const [diff, nor, arm, rock] = await Promise.all([
    loadTexture('/textures/forest_floor_diff.jpg', renderer),
    loadTexture('/textures/forest_floor_nor.jpg', renderer),
    loadTexture('/textures/forest_floor_arm.jpg', renderer),
    loadTexture('/textures/rock_diff.jpg', renderer),
  ]);

  const terrain = createTerrain({
    map: diff,
    normalMap: nor,
    armMap: arm,
    rockMap: rock,
  });
  scene.add(terrain);

  createTrees(scene, renderer); // renderer: impostor atlas bake (Phase 35)
  createGrass(scene, SPAWN);
  createWheat(scene);
  createDust(scene);
  createWater(scene, renderer, camera);
  await Promise.all([
    createFlowers(scene, SPAWN),
    createRocks(scene, renderer),
    createFish(scene),
    createAnimals(scene),
  ]);
  createInsects(scene); // after flowers: butterflies anchor to flowerPatches
  createBirds(scene);
  createFireflies(scene);
}

// ---------------------------------------------------------------------------
// Atmosphere: fog, sky, sun + shadows, god rays
// ---------------------------------------------------------------------------
const atmosphere = createAtmosphere(scene);
window.__game.atmosphere = atmosphere; // debug: drive update() externally

// User preference: fog OFF by default, F7 turns it on.
let fogEnabled = false;
scene.fog.density = 0;
// No fog to hide the shadow-window edge -> use the extended window.
atmosphere.setShadowRange(true);

// ---------------------------------------------------------------------------
// Post-processing (Phase 10): SSAO grounds everything, bloom makes the sun
// and bright fog glow for real. F4 toggles AO, F5 toggles bloom (A/B test).
// ---------------------------------------------------------------------------
// multisampling: 0 — MSAA is intentionally OFF. With it on, the MSAA depth
// buffer has to be resolved/blitted for the two depth-consuming passes (N8AO +
// godrays), and that shared depth path produced a GL_INVALID_OPERATION
// "texture format / sampler type" mismatch every frame on some drivers. We do
// antialiasing with SMAA (an EffectPass effect) instead, which works on the
// resolved color image and never touches the depth attachment.
const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
  multisampling: 0,
});
composer.addPass(new RenderPass(scene, camera));

const aoPass = new N8AOPostPass(
  scene,
  camera,
  window.innerWidth,
  window.innerHeight
);
aoPass.configuration.aoRadius = 1.8;
aoPass.configuration.distanceFalloff = 3.0;
aoPass.configuration.intensity = 3.5;
// Half-res AO with n8ao's built-in smart upsample: visually equivalent for
// an outdoor scene, roughly halves the AO cost at 2558x1388.
aoPass.configuration.halfRes = true;
composer.addPass(aoPass);

// Real volumetric godrays: raymarches the sun's shadow map, so shafts form
// exactly where light actually breaks through the canopy.
// gammaCorrection: false because the bloom EffectPass after this encodes.
// Balance (2026-06-11, A/B-tuned at the lake shore facing the sun): the
// compositor lerps the scene toward a flat bright color by the accumulated
// amount, and accumulation saturates with ray length — with the old
// density 1/110 + maxDensity 0.42 everything beyond ~60-90 m hit the cap
// and distant trees bleached to cream. Lower density pushes saturation past
// ~150 m and the lower cap keeps far silhouettes readable; in-forest shafts
// are short-range occlusion contrast and keep their punch.
const godraysPass = new GodraysPass(atmosphere.sun, camera, {
  density: 1 / 180,
  maxDensity: 0.23,
  distanceAttenuation: 2.4,
  color: new THREE.Color(0xfff0d2),
  raymarchSteps: 60,
  blur: true,
  gammaCorrection: false,
});
composer.addPass(godraysPass);

// ANGLE/D3D11 workaround (Windows Chrome): three r183+ stores PCF shadow
// depth in a comparison-mode depth texture. three-good-godrays handles that
// by blitting the depth into a plain copy texture each frame, but on D3D11
// that depth blit silently yields an empty texture (all 1.0 = "no occluder
// anywhere"), so the raymarch accumulates to max density on every ray and the
// whole frame washes out to a flat haze — bloom then smears it into the
// structureless grey screen. Fix: sample the original comparison texture with
// sampler2DShadow (hardware depth compare, free 2x2 PCF) and skip the copy.
{
  const illumMat = godraysPass.illumPass.material;
  illumMat.fragmentShader = illumMat.fragmentShader
    .replace(
      'uniform sampler2D shadowMap;',
      'uniform highp sampler2DShadow shadowMap;'
    )
    .replace(
      /vec4 packedDepth=texture2D\(shadowMap,shadowMapUV\.xy\);[\s\S]*?float difference=lightDist-depth;return vec2\(float\(difference>0\.0\),lightDist\);/,
      'float visibility=texture(shadowMap,vec3(shadowMapUV.xy,shadowMapUV.z));' +
        'float lightDist=(lightCameraNear+(lightCameraFar-lightCameraNear)*shadowMapUV.z);' +
        'return vec2(1.0-visibility,lightDist);'
    );
  if (illumMat.fragmentShader.includes('sampler2DShadow')) {
    illumMat.needsUpdate = true;
    // With comparison sampling there is nothing to copy — keep the original
    // depth texture bound (updateUniforms already binds shadow.map.depthTexture).
    godraysPass.illumPass.checkForDepthCopy = function () {
      this.needsDepthCopy = false;
    };
  } else {
    console.warn(
      '[godrays] shader patch did not apply — lib build changed? ' +
        'Falling back to the library depth-copy path.'
    );
  }
}

const BLOOM_INTENSITY = 0.55;
const bloomEffect = new BloomEffect({
  intensity: BLOOM_INTENSITY,
  luminanceThreshold: 0.72,
  luminanceSmoothing: 0.25,
  mipmapBlur: true,
});
// SMAA replaces the composer's old MSAA. It runs last (on the final composited
// image) so it antialiases the bloom result too. Combined into the bloom pass
// so we don't add another full-screen pass.
const smaaEffect = new SMAAEffect();
const bloomPass = new EffectPass(camera, bloomEffect, smaaEffect);
composer.addPass(bloomPass);
// Debug handles (same arc as __renderer/__game above).
window.__composer = composer;
window.__passes = { aoPass, godraysPass, bloomPass };

// Controls panel (Phase 15): owns #controls + the #mode badge; every toggle
// below REPORTS its state here instead of poking the DOM itself. F1 = panel.
const hud = new Hud();

// Phase 28: user's godray intent (the loop ANDs it with daytime).
let raysUserOn = true;
function timeLabel() {
  const h = getTimeOfDay() * 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Phase 30 — day-night transition: N (or clicking the HUD row) tweens
// timeOfDay through a full cinematic sunset/sunrise, always flowing
// FORWARD through the cycle (sun sets; next press rides through dawn).
const CYCLE_DAY_T = 0.35;   // the calibrated morning anchor
const CYCLE_NIGHT_T = 0.97; // moon high, stars out
const CYCLE_DURATION = 25;  // seconds
let cycleTransition = null; // {from, to, elapsed}
let lastSunUp = true;

function startCycleTransition() {
  const from = getTimeOfDay();
  const goingNight = lastSunUp;
  let to = goingNight ? CYCLE_NIGHT_T : CYCLE_DAY_T;
  while (to <= from) to += 1; // forward through the wrap
  cycleTransition = { from, to, elapsed: 0 };
  hud.set('cycle', goingNight ? '&rarr; NIGHT' : '&rarr; DAY');
}
hud.onCycle = startCycleTransition; // HUD row click = same as N

window.addEventListener('keydown', (e) => {
  if (e.code === 'F4') {
    e.preventDefault();
    aoPass.enabled = !aoPass.enabled;
    hud.set('ao', aoPass.enabled);
  }
  if (e.code === 'F5') {
    e.preventDefault();
    // Toggle the EFFECT, not the pass: bloom is the final pass in the
    // chain, and disabling it leaves nothing rendering to screen (freeze).
    bloomEffect.intensity = bloomEffect.intensity > 0 ? 0 : BLOOM_INTENSITY;
    hud.set('bloom', bloomEffect.intensity > 0);
  }
  if (e.code === 'F6') {
    e.preventDefault();
    // User INTENT only — the loop gates the actual pass on sun-up too
    // (godrays sample the SUN's shadow map, which the moon owns at night).
    raysUserOn = !raysUserOn;
    hud.set('rays', raysUserOn);
  }
  // Phase 28 debug scrub: [ / ] step timeOfDay (hold for continuous).
  // Scrubbing cancels a running day-night transition (manual wins).
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    e.preventDefault();
    cycleTransition = null;
    setTimeOfDay(getTimeOfDay() + (e.code === 'BracketLeft' ? -0.004 : 0.004));
    renderer.shadowMap.needsUpdate = true;
    hud.set('time', timeLabel());
  }
  // Phase 30: the cinematic sunset/sunrise.
  if (e.code === 'KeyN') {
    startCycleTransition();
  }
  if (e.code === 'F7') {
    e.preventDefault();
    fogEnabled = !fogEnabled;
    scene.fog.density = fogEnabled ? FOG_DENSITY : 0;
    // Fog on -> small crisp shadow window (fog hides its edge);
    // fog off -> extended window so the edge sits past visual relevance.
    atmosphere.setShadowRange(!fogEnabled);
    // setShadowRange disposes/recreates the shadow map. The godrays pass
    // binds the shadow depth texture once (shadowMapSet latch) — reset it so
    // the pass rebinds the NEW texture instead of sampling a disposed one.
    godraysPass.illumPass.shadowMapSet = false;
    // Shadows are on-demand now — force a rebuild for the new map/window.
    renderer.shadowMap.needsUpdate = true;
    hud.set('fog', fogEnabled);
  }
});

// ---------------------------------------------------------------------------
// Controls + UI
// ---------------------------------------------------------------------------
const player = new PlayerControls(camera, renderer.domElement);

// Combat arc (v4): created in init() AFTER initPhysics — bullets raycast
// the physics world, so the colliders must exist first.
let weapons = null;

// Fly mode (Phase 12): sandbox-style spectator. F toggles; leaving fly
// drops the capsule at the camera's position and gravity takes over.
let flyMode = false;
let wasSubmerged = false;
const underwaterEl = document.getElementById('underwater');
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && player.locked) {
    flyMode = !flyMode;
    hud.set('fly', flyMode); // hud owns the #mode badge + panel state
    if (!flyMode) {
      teleportPlayer(
        camera.position.x,
        camera.position.y - PLAYER.eyeOffset,
        camera.position.z
      );
    }
  }
});

const prompt = document.getElementById('prompt');
prompt.addEventListener('click', () => player.lock());
// Ambient forest audio (ships in the ez-tree package, same as the demo).
// Starts on first pointer lock — that user gesture satisfies autoplay rules.
const ambience = new Audio('/audio/ambience.mp3');
ambience.loop = true;
ambience.volume = 0.3;
let ambienceStarted = false;

player.onLock(() => {
  prompt.classList.add('hidden');
  document.body.classList.add('playing'); // belt-and-suspenders cursor hide
  if (!ambienceStarted) {
    ambienceStarted = true;
    ambience.play().catch(() => {});
  }
  enableBirdCalls(); // same user gesture satisfies autoplay rules
});
player.onUnlock(() => {
  prompt.classList.remove('hidden');
  document.body.classList.remove('playing');
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  setWaterSize(renderer);
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const stats = new Stats(renderer, (visible) => hud.set('stats', visible));

// With EffectComposer, info resets on every internal pass — accumulate
// manually so the F3 HUD shows real frame totals.
renderer.info.autoReset = false;

// On-demand shadows: the sun never moves and neither does anything that
// casts shadows (leaves sway but don't cast), so the 8k shadow map only
// needs re-rendering when the texel-snapped shadow window moves — i.e.
// when the player moves. atmosphere.update() reports that; standing still
// this saves a full-scene depth render every frame.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

function loop() {
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.1);

  // Floating bodies + the swimmer ride the same waves the shader draws.
  setWaveTime(clock.elapsedTime);

  // Input -> desired velocity; Rapier resolves collisions and slopes.
  // window.__freecam = true detaches the camera (debug/inspection only).
  if (!window.__freecam) {
    if (flyMode) {
      player.updateFly(dt);
    } else {
      const desiredVelocity = player.update(dt);
      const pos = movePlayer(
        desiredVelocity,
        dt,
        player.consumeJump(),
        player.getSwimVertical()
      );
      camera.position.set(
        pos.x,
        pos.y + PLAYER.eyeOffset + player.bobOffset,
        pos.z
      );
    }
  }
  stepPhysics(dt);

  // Weapons (v4): input/state/projectiles/impacts. After movePlayer (camera
  // is at its final pose for the frame) and after stepPhysics (impulses from
  // hits land on fresh transforms next step).
  if (weapons) weapons.update(dt);

  // Underwater camera: tint + dense fog while the eye is below the surface.
  const camWaterLevel = getWaterLevel(camera.position.x, camera.position.z);
  const submerged =
    camWaterLevel !== null && camera.position.y < camWaterLevel - 0.05;
  // Swimming indicator: body (capsule center) below the surface. hud.set
  // no-ops when unchanged, so this is free per frame.
  hud.set(
    'swim',
    !flyMode &&
      camWaterLevel !== null &&
      camera.position.y - PLAYER.eyeOffset < camWaterLevel
  );
  if (submerged !== wasSubmerged) {
    wasSubmerged = submerged;
    underwaterEl.classList.toggle('hidden', !submerged);
    if (submerged) {
      scene.fog.color.set(0x33555c);
      scene.fog.density = 0.32; // water murk, regardless of the fog toggle
    } else {
      scene.fog.density = fogEnabled ? FOG_DENSITY : 0;
    }
  }
  // Fog rides the live time-of-day color (Phase 28) unless underwater murk
  // owns it.
  if (!submerged) scene.fog.color.copy(FOG_COLOR);

  // With fog off there's nothing to hide the distance cutoff — disable it
  // (frustum culling still drops cells behind the camera).
  updateTrees(clock.elapsedTime, camera.position, fogEnabled ? 110 : Infinity);
  updateGrass(clock.elapsedTime, camera.position);
  updateWheat(clock.elapsedTime, camera.position); // pos: near-field densifier
  updateInsects(clock.elapsedTime);
  updateBirds(clock.elapsedTime, dt, camera.position);
  updateFireflies(clock.elapsedTime);
  updateFish(clock.elapsedTime, dt, camera.position);
  updateAnimals(clock.elapsedTime, dt, camera.position);
  updateDust(dt, camera.position);
  updateWater(clock.elapsedTime);

  // Phase 30: ride the day-night tween (smoothstep ease over ~25 s).
  if (cycleTransition) {
    cycleTransition.elapsed += dt;
    const p = Math.min(1, cycleTransition.elapsed / CYCLE_DURATION);
    const ease = p * p * (3 - 2 * p);
    setTimeOfDay(
      cycleTransition.from + (cycleTransition.to - cycleTransition.from) * ease
    );
    // No unconditional shadow rebuild here (perf batch): the shadow rig
    // follows the tweening sun in ~0.35° steps inside atmosphere.update,
    // and sky.moved below triggers the re-render exactly on those steps —
    // a few times a second instead of every frame for 25 s.
    hud.set('time', timeLabel());
    if (p >= 1) cycleTransition = null;
  }

  const sky = atmosphere.update(camera, clock.elapsedTime);
  if (sky.moved) renderer.shadowMap.needsUpdate = true;
  if (sky.swapped) {
    // The casting light changed (sun<->moon): the godrays pass holds a
    // one-time binding to the SUN's shadow map — rebind when it returns.
    godraysPass.illumPass.shadowMapSet = false;
  }
  // Godrays need the sun's shadow map — gate on daytime AND user intent.
  godraysPass.enabled = raysUserOn && sky.sunUp;
  // Exposure curve: bright day, +golden hour, dimmer night.
  renderer.toneMappingExposure = getExposure();
  // Phase 30: HUD cycle state (DAY / NIGHT / transitioning).
  lastSunUp = sky.sunUp;
  if (!cycleTransition) hud.set('cycle', sky.sunUp ? 'DAY' : 'NIGHT');

  // Water reflection + refraction/depth pre-pass (renders the scene without
  // water into off-screen targets) must run before the main composed image.
  prepareWater(renderer, scene, camera);

  composer.render(dt);
  // First-person viewmodel (v4): forward overlay render on top of the
  // composed frame with a depth clear — the gun never clips into world
  // geometry and never touches the composer's (fragile) depth pipeline.
  if (weapons) weapons.renderViewmodel(renderer);
  stats.update(dt);
}

async function init() {
  await buildWorld();
  await initPhysics(
    scene,
    // World-tree root flares ride the ball-collider path (Phase 39).
    { trunks: treeColliders, logs: logColliders, rocks: [...rockColliders, ...worldTreeFlares] },
    SPAWN
  );
  weapons = new WeaponSystem({ scene, camera, player, hud });
  renderer.setAnimationLoop(loop);
}
init().catch((e) => {
  console.error('[init] failed:', e);
  window.__initError = String(e.stack || e);
});
