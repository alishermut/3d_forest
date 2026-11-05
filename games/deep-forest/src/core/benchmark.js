import * as THREE from 'three';
import { getHeight } from '../world/terrain.js';

// Repeatable perf probe (Phase 54). Flies the camera to fixed spots under a
// FIXED game state, lets streaming/shadows settle, then records per frame:
//   gpu ms — EXT_disjoint_timer_query_webgl2 around the whole frame (the
//            number that matters; not capped by vsync). "n/a" if the
//            browser doesn't expose the extension.
//   cpu ms — JS time spent in the frame loop (main-thread cost).
//   (gpu, cpu and fps are MEDIANS over the window, so one stall doesn't
//    swing the number.)
//   fps    — from rAF; capped at the monitor's refresh rate, so on its own
//            it can't show regressions below that cap.
//   calls / tris — renderer.info totals for the frame.
// Run it before and after every phase. Results: panel text, console.table,
// window.__bench, and markdown rows for PLAN.md.
//
// Spots stress different things:
//   A spawn, eye height, facing the lake  — the everyday view
//   B western foothills, 40 m up, facing east — the whole map in view
//   C east deep forest, eye height — densest trees (becomes ocean, Phase 60)
//   D north forest, eye height — stays forest; the stable comparison point
export const BENCH_SPOTS = [
  { id: 'A spawn', x: -45, z: 15, up: 1.7, look: [1, 0, 0] },
  { id: 'B overview', x: -260, z: 0, up: 40, look: [1, -0.12, 0] },
  { id: 'C east forest', x: 260, z: 90, up: 1.7, look: [0, 0, -1] },
  { id: 'D north forest', x: 60, z: -220, up: 1.7, look: [0, 0, -1] },
];

// Settle: grass/wheat re-place blades around the new camera spot for a few
// dozen frames, shadows re-render, impostors swap. Wait for BOTH a minimum
// time and a minimum frame count so slow machines still settle.
const WARMUP_S = 2.0;
const WARMUP_FRAMES = 90;
const MEASURE_S = 3.0;

export class Benchmark {
  // hooks.applyStandard() puts the game into the benchmark state and
  // returns a restore() function (main.js owns fog/time/effects).
  constructor(renderer, camera, hooks = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.hooks = hooks;
    this.run = null;
    this.results = [];
    this.status = 'idle';

    const gl = renderer.getContext();
    this.gl = gl;
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.query = null;
    this.pending = []; // in-flight GPU queries (results arrive frames later)
    this.cpuStart = 0;
  }

  get running() {
    return this.run !== null;
  }

  // opts (tests only): { warmupS, warmupFrames, measureS } overrides.
  start(onDone, opts = {}) {
    if (this.run) return;
    this.cfg = { warmupS: WARMUP_S, warmupFrames: WARMUP_FRAMES, measureS: MEASURE_S, ...opts };
    this.saved = {
      pos: this.camera.position.clone(),
      quat: this.camera.quaternion.clone(),
      freecam: window.__freecam,
    };
    this.restoreState = this.hooks.applyStandard ? this.hooks.applyStandard() : null;
    window.__freecam = true; // detach the camera from the player capsule
    this.results = [];
    this.pending = [];
    this.gpuMs = BENCH_SPOTS.map(() => []); // per-spot GPU samples (arrive late)
    this.run = { spot: 0, onDone, finishing: -1 };
    this._resetSpot();
    this._place(BENCH_SPOTS[0]);
  }

  _resetSpot() {
    Object.assign(this.run, { t: 0, warmFrames: 0, dts: [], cpus: [], calls: 0, tris: 0 });
  }

  _place(s) {
    const y = getHeight(s.x, s.z) + s.up;
    this.camera.position.set(s.x, y, s.z);
    const d = new THREE.Vector3(...s.look).normalize();
    this.camera.lookAt(this.camera.position.clone().add(d));
    this.status = `measuring ${s.id}…`;
  }

  _measuring() {
    const r = this.run;
    return r.finishing < 0 && r.t >= this.cfg.warmupS && r.warmFrames >= this.cfg.warmupFrames;
  }

  // Call at the very top of the frame loop.
  beginFrame() {
    if (!this.run) return;
    this.cpuStart = performance.now();
    if (this.timer && !this.query && this._measuring()) {
      this.query = this.gl.createQuery();
      this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.query);
    }
  }

  // Call once per frame AFTER everything rendered (renderer.info holds the
  // full frame because main.js accumulates it manually).
  frame(dt) {
    const r = this.run;
    if (!r) return;
    const cpu = performance.now() - this.cpuStart;
    if (this.query) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.pending.push({ q: this.query, spot: r.spot });
      this.query = null;
    }
    this._pollGpu();

    // All spots measured: wait (bounded) for late GPU results, then finish.
    if (r.finishing >= 0) {
      if (this.pending.length && r.finishing++ < 120) return;
      this._finish();
      return;
    }

    const measuring = this._measuring();
    r.t += dt;
    if (!measuring) {
      r.warmFrames++;
      return;
    }
    const info = this.renderer.info.render;
    r.dts.push(dt * 1000);
    r.cpus.push(cpu);
    r.calls += info.calls;
    r.tris += info.triangles;
    if (r.t < this.cfg.warmupS + this.cfg.measureS) return;

    const s = BENCH_SPOTS[r.spot];
    const n = r.dts.length;
    this.results.push({
      spot: s.id,
      gpu: 'n/a', // filled in _finish once the queries land
      cpu: +median(r.cpus).toFixed(2),
      fps: Math.round(1000 / median(r.dts)),
      calls: Math.round(r.calls / n),
      tris: Math.round(r.tris / n),
    });
    r.spot++;
    if (r.spot < BENCH_SPOTS.length) {
      this._resetSpot();
      this._place(BENCH_SPOTS[r.spot]);
    } else {
      r.finishing = 0;
      this.status = 'collecting GPU timings…';
    }
  }

  _pollGpu() {
    const gl = this.gl;
    if (!this.timer || !this.pending.length) return;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const { q, spot } = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      if (!disjoint) this.gpuMs[spot].push(ns / 1e6);
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }

  _finish() {
    const { onDone } = this.run;
    this.run = null;
    for (const { q } of this.pending) this.gl.deleteQuery(q);
    this.pending = [];
    this.results.forEach((res, i) => {
      if (this.gpuMs[i].length) res.gpu = +median(this.gpuMs[i]).toFixed(2);
    });
    this.camera.position.copy(this.saved.pos);
    this.camera.quaternion.copy(this.saved.quat);
    window.__freecam = this.saved.freecam;
    if (this.restoreState) this.restoreState();
    window.__bench = this.results;
    this.status = this.summary();
    console.table(this.results);
    if (onDone) onDone(this.results);
  }

  summary() {
    const res = `${this.renderer.domElement.width}×${this.renderer.domElement.height}`;
    return (
      `canvas ${res}\n` +
      this.results
        .map(
          (r) =>
            `${r.spot}: gpu ${r.gpu} ms · cpu ${r.cpu} ms · ${r.fps} fps\n` +
            `   ${r.calls} calls · ${(r.tris / 1e6).toFixed(2)}M tris`
        )
        .join('\n')
    );
  }

  // Markdown table for PLAN.md perf logs.
  markdown() {
    const res = `${this.renderer.domElement.width}×${this.renderer.domElement.height}`;
    const rows = this.results.map(
      (r) => `| ${r.spot} | ${r.gpu} | ${r.cpu} | ${r.fps} | ${r.calls} | ${r.tris.toLocaleString()} |`
    );
    return [
      `Canvas ${res}, fog off, 08:24, AO/bloom/rays on.`,
      '',
      '| Spot | GPU ms | CPU ms | fps | calls | tris |',
      '|---|---|---|---|---|---|',
      ...rows,
    ].join('\n');
  }
}

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
