// Always-visible controls panel (Phase 15): movement keys + every toggle
// with LIVE state. Owners of state (main.js, stats.js) REPORT changes via
// hud.set(key, value) instead of poking DOM classes inline; this module owns
// the #controls panel and the #mode badge. F1 hides/shows the panel.
export class Hud {
  constructor() {
    this.panel = document.getElementById('controls');
    this.modeEl = document.getElementById('mode');
    this.visible = true;
    this.state = {
      stats: true,
      ao: true,
      bloom: true,
      rays: true,
      fog: false,
      fly: false,
      swim: false,
    };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') {
        e.preventDefault(); // browsers open Help on F1
        this.visible = !this.visible;
        this.panel.classList.toggle('hidden', !this.visible);
      }
    });

    this.render();
  }

  set(key, value) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.render();
  }

  render() {
    const s = this.state;
    const mode = s.fly ? 'FLY' : s.swim ? 'SWIM' : 'WALK';

    // Top-right badge: only when not plain walking.
    this.modeEl.textContent = mode;
    this.modeEl.classList.toggle('hidden', mode === 'WALK');

    const onOff = (v) =>
      `<b class="${v ? 'on' : 'off'}">${v ? 'ON' : 'OFF'}</b>`;

    this.panel.innerHTML =
      `WASD walk · Shift sprint\n` +
      `Space jump · F fly\n` +
      `<span class="dim">fly: Space/C up/down\n` +
      `water: Space/C surface/dive</span>\n` +
      `\n` +
      `F1 this panel\n` +
      `F3 stats  ${onOff(s.stats)}\n` +
      `F4 AO     ${onOff(s.ao)}\n` +
      `F5 bloom  ${onOff(s.bloom)}\n` +
      `F6 rays   ${onOff(s.rays)}\n` +
      `F7 fog    ${onOff(s.fog)}\n` +
      `\n` +
      `mode <b class="on">${mode}</b>`;
  }
}
