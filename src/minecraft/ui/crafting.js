// Voxelcraft — Phase 16: crafting grid UI.
//
// A crafting grid (2×2 in the inventory, 3×3 via a Crafting Table) plus an
// output slot. The grid slots accept item placement using the SAME held-item
// mechanic as the inventory (click to place one item from the held stack, click
// empty grid cell to pick the cell back up). Every grid change runs the recipe
// matcher; the output slot shows the result. Clicking the output:
//   - creative mode (held or source stacks are Infinity): produces the result
//     WITHOUT consuming the grid (free crafting — sandbox stays a sandbox).
//   - survival mode: consumes one instance of each ingredient from the grid.
// Either way the result goes into the player's held item (and drops into the
// inventory when the UI closes, handled by InventoryUI.close).
//
// This class owns only the grid + output DOM + the craft logic. It borrows the
// InventoryUI's heldItem (passed by reference) so the cursor item is shared.

import { matchRecipe } from '../engine/recipes.js';
import { BLOCK_REGISTRY } from '../engine/blocks.js';
import { ITEM_REGISTRY, sameItem } from '../engine/items.js';

const MAX_STACK = 64;

// Local CSS for grid slots (matches the inventory slot look).
function slotCSS(extra = '') {
  return `width:40px;height:40px;border:2px solid rgba(255,255,255,0.2);
    border-radius:2px;background:rgba(0,0,0,0.3);position:relative;
    cursor:pointer;display:flex;align-items:center;justify-content:center;${extra}`;
}

// iconStyle mirrors inventory.js's helper (kept local to avoid a circular
// import through the InventoryUI instance). Draws the atlas tile as a CSS bg.
function iconStyle(item, atlasURL, uvMap) {
  if (!item || item.id == null) return '';
  const kind = item.kind || 'block';
  let tileName;
  if (kind === 'item') {
    const it = ITEM_REGISTRY.get(item.id);
    if (!it) return '';
    tileName = it.texture;
  } else {
    const type = BLOCK_REGISTRY[item.id];
    if (!type) return '';
    tileName = type.textures[0];
  }
  const uv = uvMap.get(tileName);
  if (!uv) return '';
  const [u0, , , v1] = uv;
  const col = Math.round(u0 * 16);
  const row = Math.round((1 - v1) * 16);
  return `background-image:url(${atlasURL});background-position:-${col * 16}px -${row * 16}px;background-size:256px 256px;image-rendering:pixelated;`;
}

export class CraftingUI {
  // `heldGetter` / `heldSetter` let us read/write the shared cursor item from
  // the InventoryUI without owning it. `creative` gates consumption behavior.
  constructor(size, atlasURL, uvMap, heldGetter, heldSetter, creative) {
    this.size = size; // 2 or 3
    this.atlasURL = atlasURL;
    this.uvMap = uvMap;
    this._heldGetter = heldGetter;
    this._heldSetter = heldSetter;
    this.creative = creative;
    // The grid: size*size slots, each null or {kind,id,count}.
    this.grid = new Array(size * size).fill(null);
    this.currentResult = null; // recipe result {kind,id,count} or null
    this._build();
    this._update();
  }

  _build() {
    this.root = document.createElement('div');
    this.root.style.cssText = `display:flex;align-items:flex-start;gap:12px;margin-bottom:4px;`;

    // Crafting grid.
    this.gridWrap = document.createElement('div');
    this.gridWrap.style.cssText = `display:grid;grid-template-columns:repeat(${this.size},40px);gap:2px;`;
    this.root.appendChild(this.gridWrap);

    this.gridEls = []; // [{el,countEl}]
    for (let i = 0; i < this.size * this.size; i++) {
      const el = document.createElement('div');
      el.style.cssText = slotCSS();
      const countEl = document.createElement('div');
      countEl.style.cssText = `position:absolute;bottom:0;right:2px;font-size:10px;color:#fff;text-shadow:1px 1px 0 #000;`;
      el.appendChild(countEl);
      const idx = i;
      el.addEventListener('click', () => this._clickCell(idx));
      this.gridWrap.appendChild(el);
      this.gridEls.push({ el, countEl });
    }

    // Arrow / output.
    const arrow = document.createElement('div');
    arrow.textContent = '→';
    arrow.style.cssText = `align-self:center;font-size:22px;color:#bbb;`;
    this.root.appendChild(arrow);

    this.outputEl = document.createElement('div');
    this.outputEl.style.cssText = slotCSS('border-color:#88cc88;');
    this.outputCountEl = document.createElement('div');
    this.outputCountEl.style.cssText = `position:absolute;bottom:0;right:2px;font-size:10px;color:#fff;text-shadow:1px 1px 0 #000;`;
    this.outputEl.appendChild(this.outputCountEl);
    this.outputEl.addEventListener('click', () => this._craft());
    this.root.appendChild(this.outputEl);
  }

  // Click on a grid cell: deposit one from held, or pick up the cell's contents.
  _clickCell(i) {
    const held = this._heldGetter();
    if (held) {
      const cell = this.grid[i];
      if (cell && sameItem(cell, held)) {
        // Stack one more onto the cell (cap MAX_STACK).
        if (cell.count < MAX_STACK) { cell.count++; held.count--; if (held.count <= 0) this._heldSetter(null); }
      } else if (!cell) {
        // Place one item into the empty cell.
        this.grid[i] = { kind: held.kind, id: held.id, count: 1 };
        held.count--;
        if (held.count <= 0) this._heldSetter(null);
      }
      // else: cell holds a different item — ignore (player must clear it first).
    } else {
      // Pick up the whole cell.
      this._heldSetter(this.grid[i]);
      this.grid[i] = null;
    }
    this._update();
  }

  // Click on the output: produce the matched result into held (and consume
  // ingredients unless creative).
  _craft() {
    if (!this.currentResult) return;
    const held = this._heldGetter();
    const res = this.currentResult;
    // If holding something that isn't the result, can't craft (nowhere to put it).
    if (held && !sameItem(held, { kind: res.kind, id: res.id })) return;
    if (held && held.count + res.count > MAX_STACK) return; // would overflow held

    // Deposit result into held.
    if (held) held.count += res.count;
    else this._heldSetter({ kind: res.kind, id: res.id, count: res.count });

    // Consume one of each non-empty grid cell (creative = skip).
    if (!this.creative) {
      for (let i = 0; i < this.grid.length; i++) {
        const c = this.grid[i];
        if (c) { c.count--; if (c.count <= 0) this.grid[i] = null; }
      }
    }
    this._update();
  }

  // Re-render grid + recompute the matched output.
  _update() {
    // Render each grid cell.
    for (let i = 0; i < this.gridEls.length; i++) {
      const { el, countEl } = this.gridEls[i];
      el.style.backgroundImage = ''; el.style.backgroundPosition = ''; el.style.backgroundSize = '';
      countEl.textContent = '';
      const item = this.grid[i];
      if (item) {
        el.style.cssText = slotCSS() + iconStyle(item, this.atlasURL, this.uvMap);
        if (item.count > 1) countEl.textContent = String(item.count);
      }
    }
    // Match recipe.
    const recipe = matchRecipe(this.grid, this.size);
    this.currentResult = recipe ? recipe.result : null;
    // Render output.
    this.outputEl.style.backgroundImage = ''; this.outputEl.style.backgroundPosition = ''; this.outputEl.style.backgroundSize = '';
    this.outputCountEl.textContent = '';
    if (this.currentResult) {
      this.outputEl.style.cssText = slotCSS('border-color:#88cc88;') + iconStyle(this.currentResult, this.atlasURL, this.uvMap);
      if (this.currentResult.count > 1) this.outputCountEl.textContent = String(this.currentResult.count);
    } else {
      this.outputEl.style.cssText = slotCSS('border-color:#88cc88;');
    }
    // Notify parent so it can re-render its held-item icon.
    if (this.onChange) this.onChange();
  }

  // Called by the parent when the held item changed externally (e.g. picked up
  // from main inventory) so we can re-render nothing but stay consistent.
  refreshHeld() { /* grid unchanged; output unchanged */ }

  // On UI close, return any items left in the grid to the inventory. The parent
  // passes an addItem callback.
  ejectToInventory(addItem) {
    for (let i = 0; i < this.grid.length; i++) {
      const c = this.grid[i];
      if (c) { addItem({ kind: c.kind, id: c.id }, c.count); this.grid[i] = null; }
    }
    this._update();
  }
}
