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


// Misty morning, sun low and warm, fog dense enough that the forest
// dissolves at ~70-100 m like the reference shots.
export const SUN_AZIMUTH = THREE.MathUtils.degToRad(65);
export const SUN_ELEVATION = THREE.MathUtils.degToRad(34);
export const FOG_COLOR = new THREE.Color(0xaebdb6);
// Drives the height-fog formula's base density via the fogDensity uniform.
export const FOG_DENSITY = HF_DENSITY;

// Exported so the water shader can reproduce the exact sky gradient + sun
// for its fresnel reflection (keeps water + sky dome in agreement).
export const SUN_COLOR = new THREE.Color(0xffe3b3);
export const ZENITH_COLOR = new THREE.Color(0xa7bfca);

// Unit vector pointing FROM the scene TOWARD the sun.
export const sunDirection = new THREE.Vector3(
  Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH)
).normalize();

export function createAtmosphere(scene) {
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = FOG_COLOR.clone();

  // --- Sky dome: horizon blends into the fog color so the world edge is
  // invisible; warm glow + disc where the sun sits.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(650, 32, 16), // inside the 700 far plane (Phase 17)
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uHorizon: { value: FOG_COLOR },
        uZenith: { value: ZENITH_COLOR },
        uSunColor: { value: SUN_COLOR },
        uSunDir: { value: sunDirection },
      },
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
        void main() {
          vec3 dir = normalize(vDir);
          vec3 sky = mix(uHorizon, uZenith, smoothstep(0.02, 0.5, dir.y));
          float s = max(dot(dir, uSunDir), 0.0);
          sky += uSunColor * pow(s, 350.0) * 1.6;  // sun disc
          sky += uSunColor * pow(s, 4.5) * 0.85;   // broad warm halo
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    })
  );
  sky.name = 'sky';
  scene.add(sky);

  // --- Sun + shadows. The shadow camera is a tight box that follows the
  // player (updated each frame) so 4k of shadow map stays crisp nearby.
  const sun = new THREE.DirectionalLight(SUN_COLOR, 5.5);
  sun.castShadow = true;
  // bias 0: with this depth range even -0.0006 pushes surfaces ~15 cm
  // into their own shadow — a full-scene darkness blanket. normalBias alone
  // handles acne here.
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.3;
  scene.add(sun);
  scene.add(sun.target);

  // Fog-aware shadow window: with fog ON a small crisp box follows the
  // player (fog hides its edge); with fog OFF the edge would be plainly
  // visible, so the box expands to ±170 m at 8192px (similar texel density,
  // boundary pushed past visual relevance). True infinite range = CSM,
  // researched and deferred (conflicts with our patched materials+godrays).
  let texelSize = 0;
  function setShadowRange(extended) {
    const ext = extended ? 170 : 48;
    const size = extended ? 8192 : 4096;
    const cam = sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = extended ? 520 : 260;
    // three.js never does this for you: without it the camera keeps its
    // previous frustum and the bounds above are ignored.
    cam.updateProjectionMatrix();
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null; // renderer recreates at the new resolution
      }
    }
    texelSize = (ext * 2) / size;
  }
  setShadowRange(false);

  // Forest ambient: deliberately LOW (Phase 12 contrast pass) — shadowed
  // forest goes properly dark, lit pools pop. The reference-screenshot look.
  scene.add(new THREE.HemisphereLight(0xa9c1b8, 0x36402e, 0.95));

  // (The old depthTest-off glow sprite is gone — it glowed THROUGH the
  // canopy. Real bloom + godrays + the sky's sun disc do this correctly.)

  // Texel snapping must happen in LIGHT space (along the shadow camera's
  // right/up axes), not world axes — the sun is angled, so world-axis steps
  // don't align with shadow-map texels and every shadow edge crawls as the
  // player moves. Pure-rotation basis: light looks along -sunDirection.
  const lightBasis = new THREE.Matrix4().lookAt(
    sunDirection,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  );
  const lightBasisInv = lightBasis.clone().invert();
  const _snap = new THREE.Vector3();
  const _lastSnap = new THREE.Vector3(Infinity, Infinity, Infinity);

  // Returns TRUE when the snapped shadow window moved this frame. The sun
  // is static and so is everything that casts shadows (leaves sway but
  // don't cast), so the caller only needs to re-render the expensive
  // shadow map when this reports movement.
  function update(camera, elapsed) {
    // Shadow box follows the player (full 3D — mountains need the vertical
    // recenter too), snapped to whole texels in light space so shadows stay
    // world-stable while walking.
    _snap.copy(camera.position).applyMatrix4(lightBasisInv);
    _snap.x = Math.round(_snap.x / texelSize) * texelSize;
    _snap.y = Math.round(_snap.y / texelSize) * texelSize;
    _snap.applyMatrix4(lightBasis);

    sun.target.position.copy(_snap);
    sun.position.copy(_snap).addScaledVector(sunDirection, 130);

    // Sky dome tracks the camera so it never clips.
    sky.position.copy(camera.position);

    const moved = !_snap.equals(_lastSnap);
    _lastSnap.copy(_snap);
    return moved;
  }

  return { update, sun, setShadowRange };
}

// (Fake additive shaft planes removed in Phase 12 — replaced by raymarched
// godrays sampling the real shadow map. See main.js GodraysPass.)

