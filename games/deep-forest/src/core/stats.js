// Lightweight HUD: fps / frame time / draw calls / triangles.
// Reads renderer.info each frame; updates the DOM 4x per second.
export class Stats {
  constructor(renderer, onToggle = null) {
    this.renderer = renderer;
    this.el = document.getElementById('stats');
    this.frames = 0;
    this.accum = 0;
    this.visible = true;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.classList.toggle('hidden', !this.visible);
        if (onToggle) onToggle(this.visible); // report to the controls panel
      }
    });
  }

  update(dt) {
    this.frames++;
    this.accum += dt;
    if (this.accum < 0.25) return;

    const fps = this.frames / this.accum;
    const ms = (this.accum / this.frames) * 1000;
    const info = this.renderer.info.render;
    this.el.textContent =
      `fps   ${fps.toFixed(0)}\n` +
      `ms    ${ms.toFixed(2)}\n` +
      `calls ${info.calls}\n` +
      `tris  ${info.triangles.toLocaleString()}`;

    this.frames = 0;
    this.accum = 0;
  }
}
