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
      time: '08:24', // timeOfDay 0.35 default (Phase 28)
      cycle: 'DAY',  // DAY / NIGHT / -> transitioning (Phase 30)
      weapon: 'M16', // combat arc (Phase 40)
      catches: 0,    // fishing arc (Phase 52)
    };
    // Phase 30: the cycle row doubles as a BUTTON (usable outside pointer
    // lock). Delegated — render() rebuilds innerHTML, killing listeners.
    this.onCycle = null;
    this.panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="cycle"]') && this.onCycle) this.onCycle();
    });

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
      `LMB fire · R reload\n` +
      `1-4·wheel  <b class="on">${s.weapon}</b>\n` +
      (s.catches > 0 ? `fish caught  <b class="on">${s.catches}</b>\n` : '') +
      `\n` +
      `F1 this panel\n` +
      `F3 stats  ${onOff(s.stats)}\n` +
      `F4 AO     ${onOff(s.ao)}\n` +
      `F5 bloom  ${onOff(s.bloom)}\n` +
      `F6 rays   ${onOff(s.rays)}\n` +
      `F7 fog    ${onOff(s.fog)}\n` +
      `[ ] time  <b class="on">${s.time}</b>\n` +
      `<span data-act="cycle" style="cursor:pointer">N  cycle  <b class="on">${s.cycle}</b></span>\n` +
      `\n` +
      `mode <b class="on">${mode}</b>`;
  }
}
