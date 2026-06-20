// Voxelcraft — Phase 5: block highlight overlay + hotbar UI.
//
// Two concerns:
//   1. Block highlight: a wireframe box that snaps to whichever block the
//      player is currently targeting (DDA raycast from camera). Updated each
//      frame; hidden when no target.
//   2. Hotbar: 9-slot bar at the bottom of the screen. In creative v1 each
//      slot holds a block type the player can place. Select with 1-9 or
//      mouse wheel. The selected block is what RMB places.

import * as THREE from 'three';
import { BLOCK, BLOCK_REGISTRY } from '../engine/blocks.js';
import { ITEM_REGISTRY } from '../engine/items.js';
// --- Block highlight ------------------------------------------------------
// A slightly-larger-than-1-unit wireframe cube that follows the targeted block.
export class BlockHighlight {
  constructor(scene) {
    const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.4,
      depthTest: true,
    });
    this.mesh = new THREE.LineSegments(edges, mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 999;
    scene.add(this.mesh);
  }

  // Target is { x, y, z } (block coords) or null.
  update(target) {
    if (!target) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.mesh.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// --- Hotbar ----------------------------------------------------------------
// Displays the first 9 slots of the Inventory. In creative mode, slots have
// infinite blocks. Select with 1-9 or mouse wheel. The selected block is
// what RMB places.
const DEFAULT_HOTBAR = [
  BLOCK.GRASS, BLOCK.STONE, BLOCK.PLANKS, BLOCK.WOOD_LOG,
  BLOCK.GLASS, BLOCK.TORCH, BLOCK.COBBLESTONE, BLOCK.SAND, BLOCK.LEAVES,
];

export class Hotbar {
  constructor(inventory) {
    this.inventory = inventory;
    // Pre-fill hotbar with the default creative palette.
    if (inventory) {
      for (let i = 0; i < DEFAULT_HOTBAR.length; i++) {
        inventory.setSlot(i, DEFAULT_HOTBAR[i], Infinity);
      }
    }
    this.el = document.createElement('div');
    this.el.id = 'hotbar';
    this.el.style.cssText = `
      position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%);
      display: flex; gap: 4px; padding: 4px;
      background: rgba(0, 0, 0, 0.5); border-radius: 4px;
      z-index: 30; pointer-events: none; user-select: none;
    `;
    document.body.appendChild(this.el);
    this.slots = [];
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.style.cssText = `
        width: 44px; height: 44px; display: flex; align-items: center;
        justify-content: center; border: 2px solid rgba(255,255,255,0.2);
        border-radius: 2px; background: rgba(0,0,0,0.3);
        font: 11px/1 Consolas, monospace; color: #ddd;
        position: relative;
      `;
      const num = document.createElement('div');
      num.style.cssText = `position: absolute; top: 1px; left: 3px; font-size: 9px; opacity: 0.6;`;
      num.textContent = String(i + 1);
      slot.appendChild(num);
      const name = document.createElement('div');
      name.style.cssText = `font-size: 9px; text-align: center; padding: 0 2px; word-break: break-word;`;
      slot.appendChild(name);
      this.el.appendChild(slot);
      this.slots.push({ el: slot, name });
    }
    this.render();
  }

  get selected() {
    return this.inventory ? this.inventory.selected : 0;
  }

  get selectedBlock() {
    if (this.inventory) return this.inventory.selectedBlock;
    return DEFAULT_HOTBAR[0];
  }

  select(index) {
    if (this.inventory) {
      this.inventory.select(index);
    }
    this.render();
  }

  cycle(delta) {
    if (this.inventory) this.inventory.cycle(delta);
    this.render();
  }

  render() {
    const selectedIdx = this.inventory ? this.inventory.selected : 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const slot = this.inventory ? this.inventory.slots[i] : null;
      let name = '';
      if (slot) {
        const def = slot.kind === 'item'
          ? ITEM_REGISTRY.get(slot.id)
          : BLOCK_REGISTRY[slot.id];
        name = def ? def.name.split(' ')[0] : '';
      } else if (!this.inventory) {
        const type = BLOCK_REGISTRY[DEFAULT_HOTBAR[i]];
        name = type ? type.name.split(' ')[0] : '';
      }
      s.name.textContent = name;
      if (i === selectedIdx) {
        s.el.style.borderColor = '#ffffff';
        s.el.style.background = 'rgba(255,255,255,0.18)';
      } else {
        s.el.style.borderColor = 'rgba(255,255,255,0.2)';
        s.el.style.background = 'rgba(0,0,0,0.3)';
      }
    }
  }
}
