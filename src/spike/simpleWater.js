// ===========================================================================
// Simple water — a LIGHTWEIGHT, large-area water surface.
//
// One shader draw. No simulation textures, no caustics, no ray-marching, no
// reflection/refraction pre-passes. Cost is just the water mesh's pixels, so
// it scales to oceans / rivers / lakes and is cheap enough to leave running
// in the forest app.
//
// Realism comes from cheap-but-effective surface optics:
//   • Gerstner swell (vertex displacement) + scrolling detail normals
//   • analytic sky reflection (matches a gradient sky) + Schlick Fresnel
//   • sun specular glint
//   • depth-based color + shoreline foam from a BAKED per-vertex depth
//     (attribute `aDepth` = waterLevel - terrainHeight) — no depth buffer.
//
// Reusable: createSimpleWater(opts) -> { mesh, material, update }.
// For the forest lake, pass a geometry carrying an `aDepth` attribute (same
// trick src/world/water.js already uses) and the scene's live sun/sky refs.
// For open ocean, omit it — water reads as uniformly deep.
// ===========================================================================

import * as THREE from 'three';

export function createSimpleWater(opts = {}) {
  const {
    size = 500,
    segments = 160,
    waterLevel = 0,
    geometry = null,            // optional custom geo (e.g. lake outline + aDepth)
    sunDir = new THREE.Vector3(0.4, 0.7, 0.35).normalize(),
    sunColor = new THREE.Color(1.0, 0.95, 0.82),
    horizon = new THREE.Color(0.78, 0.86, 0.92),
    zenith = new THREE.Color(0.20, 0.46, 0.74),
    shallow = new THREE.Color(0.18, 0.42, 0.46),
    deep = new THREE.Color(0.02, 0.11, 0.17),
    waveAmp = 0.18,             // swell height (world units)
    waveLen = 9.0,             // base swell wavelength (world units)
    waveSpeed = 1.0,
    detailScale = 1.4,          // fine ripple frequency
    fog = true,
  } = opts;

  let geo = geometry;
  if (!geo) {
    geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
  }
  const hasDepth = !!geo.getAttribute('aDepth');

  const material = new THREE.ShaderMaterial({
    fog,
    transparent: hasDepth,        // only need alpha feather at shorelines
    depthWrite: !hasDepth,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uHorizon: { value: horizon },
        uZenith: { value: zenith },
        uShallow: { value: shallow },
        uDeep: { value: deep },
        uCamPos: { value: new THREE.Vector3() },
        uWaveAmp: { value: waveAmp },
        uWaveLen: { value: waveLen },
        uWaveSpeed: { value: waveSpeed },
        uDetail: { value: detailScale },
      },
    ]),
    defines: hasDepth ? { USE_DEPTH: '' } : {},
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      uniform float uTime, uWaveAmp, uWaveLen, uWaveSpeed;
      #ifdef USE_DEPTH
        attribute float aDepth;
        varying float vDepth;
      #endif
      varying vec3 vWorld;

      // Three Gerstner waves derived from one base wavelength.
      const vec2 D0 = vec2( 0.80,  0.60);
      const vec2 D1 = vec2(-0.45,  0.89);
      const vec2 D2 = vec2( 0.30, -0.95);

      vec3 gerstner(vec2 p, float taper) {
        vec3 disp = vec3(0.0);
        float t = uTime * uWaveSpeed;
        // (direction, wavelength-mult, amp-mult, speed-mult)
        for (int i = 0; i < 3; i++) {
          vec2 dir = i == 0 ? D0 : (i == 1 ? D1 : D2);
          float lenM = i == 0 ? 1.0 : (i == 1 ? 0.55 : 0.30);
          float ampM = i == 0 ? 1.0 : (i == 1 ? 0.55 : 0.30);
          float spdM = i == 0 ? 1.0 : (i == 1 ? 1.3 : 1.8);
          float k = 6.2831853 / (uWaveLen * lenM);
          float a = uWaveAmp * ampM * taper;
          float f = k * dot(dir, p) - spdM * t;
          float c = cos(f);
          disp.y += a * sin(f);
          disp.x += dir.x * a * c * 0.5;
          disp.z += dir.y * a * c * 0.5;
        }
        return disp;
      }

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float taper = 1.0;
        #ifdef USE_DEPTH
          vDepth = aDepth;
          taper = clamp(aDepth / 1.0, 0.0, 1.0); // flatten swell into the shallows
        #endif
        world.xyz += gerstner(world.xz, taper);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world; // name required by <fog_vertex>
        #include <fog_vertex>
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform float uTime, uWaveLen, uWaveSpeed, uWaveAmp, uDetail;
      uniform vec3 uSunDir, uSunColor, uHorizon, uZenith, uShallow, uDeep, uCamPos;
      varying vec3 vWorld;
      #ifdef USE_DEPTH
        varying float vDepth;
      #endif

      const vec2 D0 = vec2( 0.80,  0.60);
      const vec2 D1 = vec2(-0.45,  0.89);
      const vec2 D2 = vec2( 0.30, -0.95);

      // Analytic Gerstner slope (matches the vertex displacement).
      vec2 swellSlope(vec2 p, float taper) {
        vec2 s = vec2(0.0);
        float t = uTime * uWaveSpeed;
        for (int i = 0; i < 3; i++) {
          vec2 dir = i == 0 ? D0 : (i == 1 ? D1 : D2);
          float lenM = i == 0 ? 1.0 : (i == 1 ? 0.55 : 0.30);
          float ampM = i == 0 ? 1.0 : (i == 1 ? 0.55 : 0.30);
          float spdM = i == 0 ? 1.0 : (i == 1 ? 1.3 : 1.8);
          float k = 6.2831853 / (uWaveLen * lenM);
          float a = uWaveAmp * ampM * taper;
          float f = k * dot(dir, p) - spdM * t;
          s += dir * (k * a * cos(f));
        }
        return s;
      }

      vec3 skyColor(vec3 dir) {
        dir = normalize(dir);
        float h = smoothstep(-0.1, 0.55, dir.y);
        vec3 sky = mix(uHorizon, uZenith, clamp(h, 0.0, 1.0));
        float s = max(dot(dir, uSunDir), 0.0);
        sky += uSunColor * pow(s, 800.0) * 2.0;
        sky += uSunColor * pow(s, 6.0) * 0.25;
        return sky;
      }

      void main() {
        float taper = 1.0;
        #ifdef USE_DEPTH
          taper = clamp(vDepth / 1.0, 0.0, 1.0);
        #endif

        // Swell slope + two scrolling detail layers (cheap moving ripples).
        vec2 slope = swellSlope(vWorld.xz, taper);
        float t = uTime * 0.6;
        vec2 q = vWorld.xz * uDetail;
        slope += 0.06 * vec2(
          sin(q.x * 0.9 + t * 1.7) + sin(q.y * 1.3 - t * 1.1),
          cos(q.y * 1.1 - t * 1.5) + sin(q.x * 0.7 + t * 0.9)
        );
        slope += 0.03 * vec2(
          sin(q.x * 2.3 - t * 2.1), cos(q.y * 2.7 + t * 1.9)
        );

        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 V = normalize(uCamPos - vWorld);

        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
        vec3 refl = skyColor(reflect(-V, N));

        // Body color: deep by default; shallower (shows lighter) over shoals.
        vec3 body = uDeep;
        float alpha = 1.0;
        #ifdef USE_DEPTH
          float d = clamp(vDepth / 3.5, 0.0, 1.0);
          body = mix(uShallow, uDeep, d);
          // shoreline foam in the shallowest band
          float foam = 1.0 - smoothstep(0.0, 0.35, vDepth);
          foam *= 0.55 + 0.45 * sin(uTime * 2.0 + vWorld.x * 2.0 + vWorld.z * 1.7);
          body = mix(body, vec3(0.82, 0.88, 0.9), clamp(foam, 0.0, 1.0) * 0.6);
          // feather the very edge so the waterline isn't a hard rule
          alpha = smoothstep(0.0, 0.25, vDepth);
        #endif

        vec3 col = mix(body, refl, clamp(fres, 0.0, 1.0));

        // sun specular glint
        vec3 H = normalize(uSunDir + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), 300.0) * 1.6;

        gl_FragColor = vec4(col, alpha);
        #include <fog_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = waterLevel;
  mesh.frustumCulled = false;

  const _cam = new THREE.Vector3();
  function update(time, camera) {
    material.uniforms.uTime.value = time;
    if (camera) {
      camera.getWorldPosition(_cam);
      material.uniforms.uCamPos.value.copy(_cam);
    }
  }

  return { mesh, material, update };
}
