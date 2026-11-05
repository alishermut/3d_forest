// Combat audio (Phase 45) — real CC0 recordings for the gunshots, WebAudio
// synthesis for everything else (impacts, reload foley, whoosh). Samples:
// michorvath's CC0 gun pack on freesound.org (9mm pistol #427592, AR15
// rifle #427596 — the AR15 being the civilian M16 — and "rifle clip
// empty" #427603 for dry fire). The context is created lazily on first
// use, which always happens after a pointer-lock click, so autoplay rules
// are satisfied; the mp3 bytes are fetched eagerly at module load so the
// first shot already has its sample decoded.

const SAMPLE_FILES = {
  shot_pistol: '/audio/shot_pistol.mp3',
  shot_rifle: '/audio/shot_rifle.mp3',
  dry_fire: '/audio/dry_fire.mp3',
};
const sampleBytes = {};
for (const [name, url] of Object.entries(SAMPLE_FILES)) {
  sampleBytes[name] = fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
}

let ctx = null;
let master = null;
let noiseBuf = null;
const buffers = {}; // name -> decoded AudioBuffer (synth fallback until set)
let decodeStarted = false;

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // 2 s of shared white noise; every synth effect plays a slice of it.
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (!decodeStarted) {
    decodeStarted = true;
    for (const name of Object.keys(sampleBytes)) {
      sampleBytes[name].then((ab) => {
        if (!ab) return;
        ctx.decodeAudioData(ab).then(
          (buf) => (buffers[name] = buf),
          () => {} // bad/missing file -> synth fallback stays
        );
      });
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Returns false when the sample isn't (yet) available — caller falls back
// to the synthesized version.
function playSample(name, { gain = 0.5, rate = 1 } = {}) {
  const buf = buffers[name];
  if (!buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start();
  return true;
}

// Filtered noise burst: the workhorse for shots, foley and impacts.
function noiseBurst({
  duration = 0.2,
  gain = 0.5,
  lowpass = 6000,
  highpass = 80,
  attack = 0.001,
} = {}) {
  ensure();
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = highpass;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

  src.connect(lp).connect(hp).connect(g).connect(master);
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + duration + 0.05);
}

// Pitch-dropping sine: the low-end body of a gunshot.
function thump({ from = 150, to = 45, duration = 0.12, gain = 0.7 } = {}) {
  ensure();
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playShot(weapon) {
  ensure();
  const name = weapon === 'pistol' ? 'shot_pistol' : 'shot_rifle';
  // pitch jitter keeps rapid fire from sounding like one looped sample;
  // a quiet synth thump underneath restores the low end the mic lost
  const played = playSample(name, {
    gain: weapon === 'pistol' ? 0.5 : 0.42,
    rate: 0.96 + Math.random() * 0.08,
  });
  if (played) {
    thump({ from: 120, to: 45, duration: 0.08, gain: 0.18 });
    return;
  }
  // synth fallback (samples still decoding or failed to load)
  if (weapon === 'pistol') {
    noiseBurst({ duration: 0.16, gain: 0.55, lowpass: 6500, highpass: 250 });
    thump({ from: 170, to: 60, duration: 0.09, gain: 0.5 });
  } else {
    noiseBurst({ duration: 0.24, gain: 0.6, lowpass: 4200, highpass: 160 });
    thump({ from: 130, to: 42, duration: 0.13, gain: 0.65 });
  }
}

export function playDryClick() {
  ensure();
  if (playSample('dry_fire', { gain: 0.45 })) return;
  noiseBurst({ duration: 0.03, gain: 0.25, lowpass: 3000, highpass: 800 });
}

// stage: 'out' (mag drop), 'in' (mag seat), 'rack' (charging handle)
export function playReload(stage) {
  if (stage === 'out') {
    noiseBurst({ duration: 0.05, gain: 0.3, lowpass: 2500, highpass: 400 });
  } else if (stage === 'in') {
    noiseBurst({ duration: 0.06, gain: 0.38, lowpass: 1800, highpass: 250 });
  } else {
    noiseBurst({ duration: 0.08, gain: 0.42, lowpass: 3500, highpass: 600 });
  }
}

export function playWhoosh() {
  ensure();
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(500, t0);
  bp.frequency.exponentialRampToValueAtTime(1800, t0 + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.3, t0 + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
  src.connect(bp).connect(g).connect(master);
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + 0.25);
}

// ---------------------------------------------------------------------------
// Fishing (Phase 50-53) — all synth.
// ---------------------------------------------------------------------------

// Tiny "plip": a nibble dipping the bobber.
export function playPlip(distance = 10) {
  ensure();
  const att = Math.min(1, 1 / (1 + distance * 0.08));
  if (att < 0.05) return;
  thump({ from: 900, to: 420, duration: 0.06, gain: 0.22 * att });
  noiseBurst({ duration: 0.05, gain: 0.12 * att, lowpass: 2400, highpass: 500 });
}

// The real bite: a deep bloop + small splash.
export function playBite(distance = 10) {
  ensure();
  const att = Math.min(1, 1 / (1 + distance * 0.08));
  thump({ from: 420, to: 110, duration: 0.18, gain: 0.5 * att });
  noiseBurst({ duration: 0.22, gain: 0.3 * att, lowpass: 1600, highpass: 250, attack: 0.015 });
}

// Reel ratchet tick — fired repeatedly while reeling.
export function playReelTick() {
  ensure();
  noiseBurst({ duration: 0.018, gain: 0.16, lowpass: 5200, highpass: 1400 });
}

// Line snap: bright twang dying fast.
export function playLineSnap() {
  ensure();
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1400, t0);
  osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.35, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.18);
  noiseBurst({ duration: 0.06, gain: 0.2, lowpass: 4000, highpass: 800 });
}

// Cheerful two-note catch cue.
export function playCatchJingle() {
  ensure();
  const t0 = ctx.currentTime;
  for (const [freq, at, dur] of [[659, 0, 0.12], [880, 0.1, 0.22]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(0.22, t0 + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
    osc.connect(g).connect(master);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.03);
  }
}

// Surface impacts, attenuated by distance from the camera.
export function playImpact(kind, distance = 5) {
  const att = Math.min(1, 1 / (1 + distance * 0.1));
  if (att < 0.04) return;
  if (kind === 'wood') {
    noiseBurst({ duration: 0.07, gain: 0.45 * att, lowpass: 1600, highpass: 120 });
  } else if (kind === 'rock') {
    noiseBurst({ duration: 0.05, gain: 0.4 * att, lowpass: 5000, highpass: 900 });
  } else if (kind === 'water') {
    noiseBurst({ duration: 0.3, gain: 0.5 * att, lowpass: 1400, highpass: 200, attack: 0.02 });
  } else {
    // dirt
    noiseBurst({ duration: 0.06, gain: 0.35 * att, lowpass: 900, highpass: 80 });
  }
}
