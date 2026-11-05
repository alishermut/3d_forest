import GUI from 'three/addons/libs/lil-gui.module.min.js';

// Settings panel (Phase 54): ONE place for every live tunable. lil-gui ships
// inside three's addons, so this adds no dependency. G toggles the panel.
// Opening it releases pointer lock so the sliders are usable; clicking the
// scene again resumes play.
//
// Each later phase adds its own folder: settings.folder('Weather') etc.
// Owners keep their own state — the panel only calls their setters, and
// owners call settings.refresh() when state changes from elsewhere (keys).
export class Settings {
  constructor() {
    this.gui = new GUI({ title: 'Settings  (G)' });
    this.gui.domElement.style.zIndex = '40';
    this.gui.domElement.style.top = '40px'; // below the #mode badge
    this.gui.domElement.addEventListener('mousedown', (e) => e.stopPropagation());
    this.visible = false;
    this.gui.hide();

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyG' || e.repeat) return;
      // Don't steal G while typing into a number field.
      if (e.target instanceof HTMLInputElement) return;
      this.toggle();
    });
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    if (this.visible) {
      this.gui.show();
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      this.gui.hide();
    }
  }

  folder(name) {
    return this.gui.addFolder(name);
  }

  // Re-read every controller's bound value (call after state changed
  // outside the panel, e.g. a keyboard toggle).
  refresh() {
    for (const c of this.gui.controllersRecursive()) c.updateDisplay();
  }
}
