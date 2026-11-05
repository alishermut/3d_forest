import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Height fog (Phase 12): replace three's uniform fog math with an
// altitude-dependent version (Quilez height fog). Mist pools near the
// ground and in the lakebed; mountain peaks rise into clear air.
// Patched globally via ShaderChunk BEFORE any material compiles.
// ---------------------------------------------------------------------------
const HF_DENSITY = 0.031;  // density at y = 0
const HF_FALLOFF = 0.09;   // how fast density thins with altitude (1/m)

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif
`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vec4 hfWorldPos = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    hfWorldPos = instanceMatrix * hfWorldPos;
  #endif
  vFogWorldPos = ( modelMatrix * hfWorldPos ).xyz;
#endif
`;
// Density comes from the FogExp2 uniform (fogDensity), so fog can be
// toggled/boosted at runtime (F7, underwater) without shader recompiles.
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogDensity;
  varying vec3 vFogWorldPos;
#endif
`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  // Altitude is clamped just above the waterline (-1.2): density saturates
  // there instead of growing exponentially inside the lake basin — mist
  // sits ON the water rather than burying it.
  float hfCamY = max( cameraPosition.y, -1.2 );
  float hfFragY = max( vFogWorldPos.y, -1.2 );
  float hfDist = length( vFogWorldPos - cameraPosition );
  float hfRayY = ( hfFragY - hfCamY ) / max( hfDist, 1e-4 );
  float hfAmount;
  if ( abs( hfRayY ) < 0.001 ) {
    hfAmount = fogDensity * exp( -hfCamY * ${HF_FALLOFF} ) * hfDist;
  } else {
    hfAmount = ( fogDensity / ${HF_FALLOFF} ) *
      exp( -hfCamY * ${HF_FALLOFF} ) *
      ( 1.0 - exp( -hfDist * hfRayY * ${HF_FALLOFF} ) ) / hfRayY;
  }
  float fogFactor = 1.0 - clamp( exp( -hfAmount ), 0.0, 1.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

// ---------------------------------------------------------------------------
// Phase 28 — Dynamic sun: ONE timeOfDay parameter (0..1; 0.25 sunrise,
// 0.5 noon, 0.75 sunset) drives every light. The exported color/direction
// objects below are LIVE — they are mutated in place each time the clock
// moves, so every consumer that shares the reference (sky dome, water sky
// gradient, godrays light) follows for free.
//
// CALIBRATION: the default timeOfDay (0.35) reproduces the original static
// morning sun exactly — azimuth 65 deg, elevation 34 deg.
// ---------------------------------------------------------------------------
export const SUN_AZIMUTH = THREE.MathUtils.degToRad(65);   // day anchor (legacy)
export const SUN_ELEVATION = THREE.MathUtils.degToRad(34); // day anchor (legacy)

// LIVE objects (mutated by setTimeOfDay):
export const FOG_COLOR = new THREE.Color(0xaebdb6);
export const SUN_COLOR = new THREE.Color(0xffe3b3);
export const ZENITH_COLOR = new THREE.Color(0xa7bfca);
export const sunDirection = new THREE.Vector3(
  Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH)
).normalize();
export const moonDirection = new THREE.Vector3(0, -1, 0);
// Phase 35 impostors bake DAY lighting once; this live tint approximates
// the current light over the baked result (impostors.js shares the ref).
export const impostorTint = new THREE.Color(1, 1, 1);
// Phase 32 crossfade: uniform-shaped LIVE scalars. Insects/birds scale
// their geometry by dayCreatureFade (1 day -> 0 night); fireflies glow by
// nightGlowFade. Consumers share these objects as shader uniforms.
export const dayCreatureFade = { value: 1 };
export const nightGlowFade = { value: 0 };

export const FOG_DENSITY = HF_DENSITY;

// Day-anchor copies (the curve endpoints — never mutated).
const DAY = {
  fog: new THREE.Color(0xaebdb6),
  sun: new THREE.Color(0xffe3b3),
  zenith: new THREE.Color(0xa7bfca),
  hemiSky: new THREE.Color(0xa9c1b8),
  hemiGround: new THREE.Color(0x36402e),
};
const GOLDEN = {
  fog: new THREE.Color(0xd0aa84),
  sun: new THREE.Color(0xffa64d),
  zenith: new THREE.Color(0x6f82a8),
  hemiSky: new THREE.Color(0xc2a78e),
  hemiGround: new THREE.Color(0x3a352a),
};
const NIGHT = {
  fog: new THREE.Color(0x141b29),
  sun: new THREE.Color(0x96b0d8), // (unused while sun is down)
  zenith: new THREE.Color(0x080d18),
  hemiSky: new THREE.Color(0x26334c),
  hemiGround: new THREE.Color(0x0e1212),
  moon: new THREE.Color(0xa9bedd),
};

// Phase 31 cloud body color anchors (the rim color rides SUN_COLOR/moon).
const CLOUD_DAY = new THREE.Color(0xf2f5f8);
const CLOUD_GOLDEN = new THREE.Color(0xf4c08a);
const CLOUD_NIGHT = new THREE.Color(0x1a2030);

const MAX_SUN_EL = THREE.MathUtils.degToRad(58);
const MAX_MOON_EL = THREE.MathUtils.degToRad(48);

let timeOfDay = 0.35;
const _c1 = new THREE.Color();

function pathDirection(out, t, maxEl) {
  // theta: 0 at rise (t 0.25), pi/2 at peak, pi at set.
  const theta = (t - 0.25) * Math.PI * 2;
  const el = Math.sin(theta) * maxEl;
  const az = THREE.MathUtils.degToRad(28) + (theta / Math.PI) * THREE.MathUtils.degToRad(187);
  out.set(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).normalize();
  return out;
}

// Mix helper: night -> golden -> day keyed on the sun's height.
function mixColor(out, day, golden, night, dayMix, goldenMix) {
  out.copy(night).lerp(day, dayMix);
  _c1.copy(golden);
  out.lerp(_c1, goldenMix);
  return out;
}

// The current curve sample — read by createAtmosphere's applyTime and by
// getters main.js consumes (exposure, sun-up state).
const cur = {
  dayMix: 1,
  goldenMix: 0,
  nightMix: 0,
  sunIntensity: 5.5,
  moonIntensity: 0,
  hemiIntensity: 0.95,
  exposure: 1.15,
  starMix: 0,
  sunUp: true,
};

function sampleCurves() {
  const h = sunDirection.y; // sin(elevation)
  cur.dayMix = THREE.MathUtils.smoothstep(h, -0.06, 0.22);
  cur.goldenMix =
    THREE.MathUtils.smoothstep(h, -0.04, 0.07) *
    (1 - THREE.MathUtils.smoothstep(h, 0.2, 0.45));
  cur.nightMix = 1 - cur.dayMix;
  cur.sunIntensity = 5.5 * THREE.MathUtils.smoothstep(h, -0.02, 0.12);
  cur.moonIntensity = 0.55 * THREE.MathUtils.smoothstep(-h, 0.03, 0.18);
  cur.hemiIntensity = THREE.MathUtils.lerp(0.22, 0.95, cur.dayMix);
  cur.exposure =
    THREE.MathUtils.lerp(1.0, 1.15, cur.dayMix) + 0.07 * cur.goldenMix;
  cur.starMix = THREE.MathUtils.smoothstep(-h, 0.02, 0.22);
  cur.sunUp = h > -0.04;
  // Creatures roost just before full dark; glow rises as they go.
  dayCreatureFade.value = THREE.MathUtils.smoothstep(h, -0.02, 0.1);
  nightGlowFade.value = THREE.MathUtils.smoothstep(-h, 0.0, 0.12);

  // Live shared colors.
  mixColor(FOG_COLOR, DAY.fog, GOLDEN.fog, NIGHT.fog, cur.dayMix, cur.goldenMix);
  mixColor(SUN_COLOR, DAY.sun, GOLDEN.sun, GOLDEN.sun, cur.dayMix, cur.goldenMix);
  mixColor(ZENITH_COLOR, DAY.zenith, GOLDEN.zenith, NIGHT.zenith, cur.dayMix, cur.goldenMix);

  // Impostor tint: white by day, warm at golden hour, moonlit-dim at night
  // (approximates current light / baked day light).
  impostorTint.setRGB(1, 1, 1).multiplyScalar(cur.dayMix);
  impostorTint.r += cur.goldenMix * 0.12 + cur.nightMix * 0.085;
  impostorTint.g += cur.goldenMix * 0.02 + cur.nightMix * 0.105;
  impostorTint.b += cur.nightMix * 0.16 - cur.goldenMix * 0.1;
}

export function setTimeOfDay(t) {
  timeOfDay = ((t % 1) + 1) % 1;
  pathDirection(sunDirection, timeOfDay, MAX_SUN_EL);
  pathDirection(moonDirection, timeOfDay + 0.5, MAX_MOON_EL);
  sampleCurves();
}

export function getTimeOfDay() {
  return timeOfDay;
}

export function getExposure() {
  return cur.exposure;
}

// Initialize the live objects to the default time.
setTimeOfDay(timeOfDay);

export function createAtmosphere(scene) {
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = FOG_COLOR.clone();

  // --- Sky dome v2 (Phase 29): day/sunset/night gradient (uniform colors
  // are the LIVE objects), sun disc + halo, moon disc + halo, procedural
  // star field fading in at night.
  const skyUniforms = {
    uHorizon: { value: FOG_COLOR },
    uZenith: { value: ZENITH_COLOR },
    uSunColor: { value: SUN_COLOR },
    uSunDir: { value: sunDirection },
    uMoonDir: { value: moonDirection },
    uSunVis: { value: 1 },
    uMoonVis: { value: 0 },
    uStarMix: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(650, 32, 16), // inside the 700 far plane (Phase 17)
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform float uSunVis;
        uniform float uMoonVis;
        uniform float uStarMix;

        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 sky = mix(uHorizon, uZenith, smoothstep(0.02, 0.5, dir.y));

          // Sun disc + warm halo (fades out as the sun sets).
          float s = max(dot(dir, uSunDir), 0.0);
          sky += uSunColor * pow(s, 350.0) * 1.6 * uSunVis;
          sky += uSunColor * pow(s, 4.5) * 0.85 * uSunVis;

          // Moon: small cool disc + faint halo.
          float m = max(dot(dir, uMoonDir), 0.0);
          sky += vec3(0.82, 0.88, 0.99) * pow(m, 1400.0) * 1.5 * uMoonVis;
          sky += vec3(0.55, 0.62, 0.78) * pow(m, 12.0) * 0.22 * uMoonVis;

          // Stars: hashed cells in azimuth/height space, only above the
          // horizon haze, faded by uStarMix.
          if (uStarMix > 0.001 && dir.y > 0.01) {
            vec2 sc = vec2(atan(dir.x, dir.z) * 38.0, dir.y * 90.0);
            vec2 id = floor(sc);
            vec2 f = fract(sc);
            float h = hash21(id);
            vec2 starPos = vec2(fract(h * 13.7), fract(h * 7.31)) * 0.7 + 0.15;
            float star = step(0.92, h) * smoothstep(0.10, 0.02, length(f - starPos));
            star *= 0.35 + 0.65 * fract(h * 51.3); // brightness variety
            sky += vec3(0.85, 0.9, 1.0) * star * uStarMix
                 * smoothstep(0.02, 0.22, dir.y);
          }

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    })
  );
  sky.name = 'sky';
  scene.add(sky);

  // --- Cloud layer (Phase 31): planar-projected FBM on a dome just inside
  // the sky sphere. Transparent (renders after the opaque sky), wind-
  // drifted, body color from the timeOfDay curves, silver lining toward
  // the ACTIVE light (sun by day, moon by night). Dither kills banding.
  const cloudUniforms = {
    uTime: { value: 0 },
    uLightDir: { value: new THREE.Vector3().copy(sunDirection) },
    uCloudCol: { value: new THREE.Color().copy(CLOUD_DAY) },
    uRimCol: { value: new THREE.Color() },
    uCover: { value: 0.52 },
  };
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(635, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: cloudUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform float uTime;
        uniform vec3 uLightDir;
        uniform vec3 uCloudCol;
        uniform vec3 uRimCol;
        uniform float uCover;

        float chash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float cnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(chash(i), chash(i + vec2(1, 0)), f.x),
            mix(chash(i + vec2(0, 1)), chash(i + vec2(1, 1)), f.x),
            f.y
          );
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int k = 0; k < 4; k++) {
            s += cnoise(p) * a;
            p *= 2.13;
            a *= 0.5;
          }
          return s;
        }

        void main() {
          vec3 dir = normalize(vDir);
          float horizon = smoothstep(0.03, 0.16, dir.y);
          if (horizon <= 0.001) discard;

          // Planar projection: a flat layer high above, converging at the
          // horizon like real stratocumulus. Scale sets the puff size —
          // at 0.9 the visible sky spanned ~2 noise cells (one giant blob
          // or one giant gap, verified live: empty sky).
          vec2 uv = dir.xz / (dir.y + 0.22) * 3.8;
          uv += uTime * vec2(0.016, 0.007); // slow wind drift

          float d = fbm(uv);
          float cloud = smoothstep(uCover, uCover + 0.24, d);
          if (cloud <= 0.002) discard;

          // Internal shading: bright sunlit tops, grey shadowed bases —
          // the contrast is what makes them read as clouds, not haze.
          float lum = 0.62 + 0.9 * (fbm(uv * 2.31 + 7.7) - 0.35);
          float rim = pow(max(dot(dir, uLightDir), 0.0), 4.0);
          vec3 col = uCloudCol * lum + uRimCol * rim;

          float alpha = cloud * horizon * 0.94;
          // Tiny screen-space dither — soft gradients band without it.
          alpha += (chash(gl_FragCoord.xy * 0.7) - 0.5) * 0.02;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
    })
  );
  clouds.name = 'clouds';
  scene.add(clouds);

  // --- Sun + moon. One directional shadow caster at a time (Phase 29):
  // casting SWAPS at the horizon and the old map is disposed.
  const sun = new THREE.DirectionalLight(SUN_COLOR, 5.5);
  const moon = new THREE.DirectionalLight(NIGHT.moon, 0);
  for (const light of [sun, moon]) {
    // bias 0: with this depth range even -0.0006 pushes surfaces ~15 cm
    // into their own shadow. normalBias alone handles acne here.
    light.shadow.bias = 0;
    light.shadow.normalBias = 0.3;
    scene.add(light);
    scene.add(light.target);
  }
  sun.castShadow = true;

  // Fog-aware shadow window: with fog ON a small crisp box follows the
  // player (fog hides its edge); with fog OFF the box expands to ±170 m at
  // 8192px. Applied to BOTH lights' shadow cameras (maps allocate lazily —
  // only the casting light owns one at a time).
  let texelSize = 0;
  let snapQuantum = 0;
  let shadowExtended = false;
  // Perf batch (2026-06-11, "jumping fps"): the shadow window used to snap
  // on EVERY texel (~4 cm) — at walking speed that crossed a boundary every
  // single frame, so the "on-demand" 8k shadow map degenerated to a full
  // re-render per frame while moving (and zero while standing = the fps
  // oscillation). Snapping on a 16-texel quantum (a multiple of the texel,
  // so shadows still never crawl) re-renders every ~0.4-0.7 m of movement
  // instead — a handful of times per second. The window is ±48/±170 m, so
  // recentering up to 0.7 m late is invisible margin.
  const SNAP_TEXELS = 16;
  function applyShadowCam(light) {
    const ext = shadowExtended ? 170 : 48;
    const size = shadowExtended ? 8192 : 4096;
    const cam = light.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = shadowExtended ? 520 : 260;
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.set(size, size);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null; // renderer recreates at the new resolution
      }
    }
    texelSize = (ext * 2) / size;
    snapQuantum = texelSize * SNAP_TEXELS;
  }
  function setShadowRange(extended) {
    shadowExtended = extended;
    applyShadowCam(sun);
    applyShadowCam(moon);
  }
  setShadowRange(false);

  // Forest ambient (deliberately LOW — Phase 12 contrast pass); colors and
  // intensity now ride the timeOfDay curves.
  const hemi = new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, 0.95);
  scene.add(hemi);

  // Texel snapping happens in LIGHT space — the basis must follow the
  // ACTIVE light's direction now that it moves (recomputed on change).
  const lightBasis = new THREE.Matrix4();
  const lightBasisInv = new THREE.Matrix4();
  // Stepped shadow direction (perf batch): while the sun/moon moves (the
  // 25 s day-night tween, [ ] scrubbing) the shadow RIG only follows in
  // ~0.35° steps, so the 8k map re-renders every few frames instead of
  // every tween frame. Map and matrices always move TOGETHER (the rig is
  // frozen between steps — no stale-map swim); sky, colors, and lighting
  // intensities stay perfectly smooth. Only the shadow angle quantizes.
  const _shadowDir = new THREE.Vector3(0, 0, 0); // (0,0,0) forces first sync
  const SHADOW_DIR_EPS_SQ = 0.006 * 0.006;
  const _snap = new THREE.Vector3();
  const _lastSnap = new THREE.Vector3(Infinity, Infinity, Infinity);
  let activeIsSun = true;

  function rebuildBasis(dir) {
    lightBasis.lookAt(dir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    lightBasisInv.copy(lightBasis).invert();
  }
  rebuildBasis(sunDirection);

  // Applies the current curve sample to the light rig. Returns true when
  // the shadow-casting light SWAPPED (sun<->moon) this call.
  function applyTime() {
    sun.color.copy(SUN_COLOR);
    sun.intensity = cur.sunIntensity;
    moon.intensity = cur.moonIntensity;
    hemi.intensity = cur.hemiIntensity;
    mixColor(hemi.color, DAY.hemiSky, GOLDEN.hemiSky, NIGHT.hemiSky, cur.dayMix, cur.goldenMix);
    mixColor(hemi.groundColor, DAY.hemiGround, GOLDEN.hemiGround, NIGHT.hemiGround, cur.dayMix, cur.goldenMix);

    skyUniforms.uSunVis.value = THREE.MathUtils.clamp(cur.dayMix * 1.4, 0, 1);
    skyUniforms.uMoonVis.value = cur.nightMix;
    skyUniforms.uStarMix.value = cur.starMix;

    // Clouds (Phase 31): body color rides the curves; the rim follows the
    // ACTIVE light — warm sun lining by day/golden, faint cool moon lining
    // at night.
    mixColor(cloudUniforms.uCloudCol.value, CLOUD_DAY, CLOUD_GOLDEN, CLOUD_NIGHT, cur.dayMix, cur.goldenMix);
    cloudUniforms.uLightDir.value.copy(cur.sunUp ? sunDirection : moonDirection);
    cloudUniforms.uRimCol.value
      .copy(SUN_COLOR)
      .multiplyScalar(0.35 * cur.dayMix + 0.85 * cur.goldenMix);
    cloudUniforms.uRimCol.value.r += NIGHT.moon.r * 0.18 * cur.nightMix;
    cloudUniforms.uRimCol.value.g += NIGHT.moon.g * 0.18 * cur.nightMix;
    cloudUniforms.uRimCol.value.b += NIGHT.moon.b * 0.22 * cur.nightMix;

    const wantSun = cur.sunUp;
    if (wantSun !== activeIsSun) {
      activeIsSun = wantSun;
      const off = wantSun ? moon : sun;
      const on = wantSun ? sun : moon;
      off.castShadow = false;
      if (off.shadow.map) {
        off.shadow.map.dispose();
        off.shadow.map = null;
      }
      on.castShadow = true;
      applyShadowCam(on);
      _lastSnap.set(Infinity, Infinity, Infinity); // force re-snap + render
      return true;
    }
    return false;
  }

  function update(camera, elapsed = 0) {
    const swapped = applyTime();
    cloudUniforms.uTime.value = elapsed;
    const activeDir = activeIsSun ? sunDirection : moonDirection;
    const activeLight = activeIsSun ? sun : moon;

    // Shadow rig follows the light in STEPS (see _shadowDir above); a swap
    // (sun<->moon) syncs immediately.
    if (
      swapped ||
      _shadowDir.distanceToSquared(activeDir) > SHADOW_DIR_EPS_SQ
    ) {
      _shadowDir.copy(activeDir);
      rebuildBasis(_shadowDir);
      _lastSnap.set(Infinity, Infinity, Infinity);
    }

    _snap.copy(camera.position).applyMatrix4(lightBasisInv);
    // Coarse snap quantum (still texel-aligned — see SNAP_TEXELS).
    _snap.x = Math.round(_snap.x / snapQuantum) * snapQuantum;
    _snap.y = Math.round(_snap.y / snapQuantum) * snapQuantum;
    // Z (along the light axis) MUST be quantized too: it never affects the
    // shadow image (a uniform depth shift cancels in the depth comparison)
    // but it leaked every camera movement into the light position, so
    // `moved` fired EVERY frame while walking — the root cause of the
    // "8k shadow re-render per frame while moving" fps oscillation.
    _snap.z = Math.round(_snap.z / snapQuantum) * snapQuantum;
    _snap.applyMatrix4(lightBasis);

    activeLight.target.position.copy(_snap);
    activeLight.position.copy(_snap).addScaledVector(_shadowDir, 130);

    // Background rides the live fog color. The scene.fog COLOR is main.js's
    // job — it owns the underwater-murk override and copies FOG_COLOR only
    // while the camera is above water.
    scene.background.copy(FOG_COLOR);

    // Sky + cloud domes track the camera so they never clip.
    sky.position.copy(camera.position);
    clouds.position.copy(camera.position);

    const moved = !_snap.equals(_lastSnap);
    _lastSnap.copy(_snap);
    return { moved: moved || swapped, swapped, sunUp: cur.sunUp };
  }

  return { update, sun, moon, setShadowRange };
}
