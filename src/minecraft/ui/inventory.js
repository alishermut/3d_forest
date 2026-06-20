// Voxelcraft — Phase 14: inventory + hotbar UI.
//
// Replaces the Phase 5 fixed creative hotbar with a real inventory system:
//   - 36 slots: 9 hotbar (indices 0..8) + 27 main inventory (9..35)
//   - Creative mode: blocks are infinite (count = Infinity). A creative
//     palette grid lets you pick any block into your hotbar.
//   - Press E to open the inventory overlay (releases pointer lock).
//     Click a palette block to add to the selected hotbar slot.
//     Click inventory slots to pick up / swap items.
//
// Item icons use the texture atlas as CSS sprites (background-image with
// background-position per tile).

import { BLOCK, BLOCK_REGISTRY } from '../engine/blocks.js';
import { ITEM_REGISTRY, getItemType, sameItem } from '../engine/items.js';

const MAX_STACK = 64;

// --- Inventory data model --------------------------------------------------
// Slot shape (Phase 16): { kind: 'block'|'item', id, count } or null.
// `kind` discriminates blocks (numeric id) from items (string id) so the two
// namespaces never collide. `sameItem(a,b)` from items.js is the canonical
// equality check everywhere slots are compared.
export class Inventory {
  constructor() {
    this.slots = new Array(36).fill(null);
    this.selected = 0; // hotbar selection 0..8
  }

  // The currently-selected hotbar slot's payload (or null). Replaces the old
  // `selectedBlock` numeric id — callers that place blocks check `.kind==='block'`.
  get selectedItem() {
    return this.slots[this.selected] || null;
  }
  // Back-comat helper for code that only cares about the block id (placement).
  get selectedBlock() {
    const s = this.selectedItem;
    return s && s.kind === 'block' ? s.id : BLOCK.AIR;
  }

  setSlot(i, id, count = Infinity) {
    this.slots[i] = id === BLOCK.AIR ? null : { kind: 'block', id, count };
  }

  // Set a slot from an arbitrary payload ({kind,id,count} or null).
  setSlotItem(i, item) {
    this.slots[i] = item && item.id != null ? item : null;
  }

  // Add `count` of a payload to the inventory. `item` is {kind,id} (count
  // optional here). Returns leftover count that didn't fit.
  addItem(item, count = 1) {
    const kind = item.kind || 'block';
    const id = item.id;
    if ((kind === 'block' && id === BLOCK.AIR) || count <= 0) return 0;
    // First pass: fill existing stacks of the same item.
    for (let i = 0; i < 36; i++) {
      const s = this.slots[i];
      if (s && sameItem(s, { kind, id }) && s.count < MAX_STACK) {
        const room = MAX_STACK - s.count;
        const add = Math.min(room, count);
        s.count += add;
        count -= add;
        if (count <= 0) return 0;
      }
    }
    // Second pass: fill empty slots.
    for (let i = 0; i < 36; i++) {
      if (!this.slots[i]) {
        const add = Math.min(MAX_STACK, count);
        this.slots[i] = { kind, id, count: add };
        count -= add;
        if (count <= 0) return 0;
      }
    }
    return count;
  }

  // Remove `count` from the selected hotbar slot (creative = no-op, infinite).
  removeSelected(count = 1) {
    const s = this.slots[this.selected];
    if (!s) return;
    if (s.count === Infinity) return; // creative
    s.count -= count;
    if (s.count <= 0) this.slots[this.selected] = null;
  }

  // Pick up / swap between slots (click-based, no drag).
  swapWithHeld(slotIndex, held) {
    const tmp = this.slots[slotIndex];
    this.slots[slotIndex] = held;
    return tmp;
  }

  select(index) {
    if (index >= 0 && index <= 8) this.selected = index;
  }

  cycle(delta) {
    this.selected = (this.selected + delta + 9) % 9;
  }
}

// --- Item icon helper ------------------------------------------------------
// Returns CSS background-image + background-position for a slot payload's icon.
// Blocks use their primary atlas face; items use their registered texture tile.
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
    tileName = type.textures[0]; // primary face
  }
  const uv = uvMap.get(tileName);
  if (!uv) return '';
  const [u0, , , v1] = uv;
  const col = Math.round(u0 * 16);
  const row = Math.round((1 - v1) * 16);
  return `background-image:url(${atlasURL});background-position:-${col * 16}px -${row * 16}px;background-size:256px 256px;image-rendering:pixelated;`;
}

// --- Inventory UI overlay --------------------------------------------------
export class InventoryUI {
  constructor(inventory, atlasURL, uvMap) {
    this.inventory = inventory;
    this.atlasURL = atlasURL;
    this.uvMap = uvMap;
    this.isOpen = false;
    this.heldItem = null; // { id, count } carried by cursor
    this.onToggle = null; // callback(open)
    this._buildDOM();
  }

  _buildDOM() {
    // --- Overlay backdrop ---
    this.overlay = document.createElement('div');
    this.overlay.id = 'inventory-overlay';
    this.overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;
      z-index:50;display:none;
    `;
    document.body.appendChild(this.overlay);

    // --- Panel ---
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      background:rgba(40,40,45,0.95);border:2px solid #555;border-radius:8px;
      padding:16px;display:flex;flex-direction:column;gap:12px;
      max-height:80vh;font:13px/1 Consolas,sans-serif;color:#ddd;
    `;
    this.overlay.appendChild(this.panel);

    // --- Crafting grid mount point (Phase 16) ---
    // A CraftingUI (2×2 or 3×3) is attached here when the inventory opens.
    // For the 2×2 (always available) the parent calls setCraftingSize(2); for a
    // Crafting Table block, setCraftingSize(3). null = no crafting grid shown.
    this.craftingMount = document.createElement('div');
    this.craftingMount.style.cssText = `margin-bottom:4px;`;
    this.panel.appendChild(this.craftingMount);
    this.craftingUI = null; // current CraftingUI instance

    // --- Creative palette ---
    const palLabel = document.createElement('div');
    palLabel.textContent = 'Creative — click to add to selected slot';
    palLabel.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:4px;';
    this.panel.appendChild(palLabel);

    this.palette = document.createElement('div');
    this.palette.style.cssText = `
      display:grid;grid-template-columns:repeat(16,32px);gap:2px;
      max-height:200px;overflow-y:auto;padding:4px;
      background:rgba(0,0,0,0.3);border-radius:4px;
    `;
    this.panel.appendChild(this.palette);

    // Fill palette with all placeable blocks, then all items.
    for (let id = 1; id < BLOCK_REGISTRY.length; id++) {
      const type = BLOCK_REGISTRY[id];
      if (!type || type.name === 'Air') continue;
      const cell = document.createElement('div');
      cell.className = 'palette-cell';
      cell.style.cssText = `
        width:32px;height:32px;border:1px solid rgba(255,255,255,0.15);
        border-radius:2px;cursor:pointer;position:relative;
        ${iconStyle({ kind: 'block', id }, this.atlasURL, this.uvMap)}
      `;
      cell.title = type.name;
      cell.dataset.kind = 'block';
      cell.dataset.id = String(id);
      cell.addEventListener('click', () => this._pickFromPalette({ kind: 'block', id }));
      this.palette.appendChild(cell);
    }
    for (const item of ITEM_REGISTRY.values()) {
      const cell = document.createElement('div');
      cell.className = 'palette-cell';
      cell.style.cssText = `
        width:32px;height:32px;border:1px solid rgba(255,255,255,0.15);
        border-radius:2px;cursor:pointer;position:relative;
        ${iconStyle({ kind: 'item', id: item.id }, this.atlasURL, this.uvMap)}
      `;
      cell.title = item.name;
      cell.dataset.kind = 'item';
      cell.dataset.id = item.id;
      cell.addEventListener('click', () => this._pickFromPalette({ kind: 'item', id: item.id }));
      this.palette.appendChild(cell);
    }

    // --- Main inventory (27 slots, 3×9) ---
    const mainLabel = document.createElement('div');
    mainLabel.textContent = 'Inventory';
    mainLabel.style.cssText = 'font-size:11px;opacity:0.7;margin-top:4px;';
    this.panel.appendChild(mainLabel);

    this.mainGrid = document.createElement('div');
    this.mainGrid.style.cssText = `
      display:grid;grid-template-columns:repeat(9,40px);gap:2px;
    `;
    this.panel.appendChild(this.mainGrid);

    // --- Hotbar (9 slots) ---
    this.hotbarGrid = document.createElement('div');
    this.hotbarGrid.style.cssText = `
      display:grid;grid-template-columns:repeat(9,40px);gap:2px;margin-top:4px;
    `;
    this.panel.appendChild(this.hotbarGrid);

    // Create slot elements.
    this.slotEls = [];
    for (let i = 0; i < 36; i++) {
      const slot = this._makeSlot(i);
      this.slotEls.push(slot);
      if (i < 9) this.hotbarGrid.appendChild(slot.el);
      else this.mainGrid.appendChild(slot.el);
    }

    // --- Held item icon (follows cursor) ---
    this.heldEl = document.createElement('div');
    this.heldEl.style.cssText = `
      position:fixed;width:32px;height:32px;pointer-events:none;
      z-index:60;display:none;border:1px solid #fff;border-radius:2px;
    `;
    document.body.appendChild(this.heldEl);

    // Close on overlay click (outside panel) or Escape.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.code === 'Escape') this.close();
    });
    // Track mouse for held item.
    document.addEventListener('mousemove', (e) => {
      if (this.heldEl.style.display !== 'none') {
        this.heldEl.style.left = (e.clientX - 16) + 'px';
        this.heldEl.style.top = (e.clientY - 16) + 'px';
      }
    });
  }

  _makeSlot(index) {
    const el = document.createElement('div');
    el.className = 'inv-slot';
    el.style.cssText = `
      width:40px;height:40px;border:2px solid rgba(255,255,255,0.2);
      border-radius:2px;background:rgba(0,0,0,0.3);position:relative;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
    `;
    if (index < 9) {
      const num = document.createElement('div');
      num.style.cssText = `position:absolute;top:1px;left:2px;font-size:8px;opacity:0.5;`;
      num.textContent = String(index + 1);
      el.appendChild(num);
    }
    const countEl = document.createElement('div');
    countEl.style.cssText = `position:absolute;bottom:0;right:2px;font-size:10px;color:#fff;text-shadow:1px 1px 0 #000;`;
    el.appendChild(countEl);

    el.addEventListener('click', () => this._clickSlot(index));
    return { el, countEl };
  }

  _clickSlot(index) {
    const current = this.inventory.slots[index];
    if (this.heldItem) {
      // Place held item into slot (swap if occupied).
      const swapped = this.inventory.slots[index];
      // If same type, try to merge.
      if (swapped && sameItem(swapped, this.heldItem) && swapped.count < MAX_STACK) {
        const room = MAX_STACK - swapped.count;
        const add = Math.min(room, this.heldItem.count);
        swapped.count += add;
        this.heldItem.count -= add;
        if (this.heldItem.count <= 0) this.heldItem = null;
      } else {
        this.inventory.slots[index] = this.heldItem;
        this.heldItem = swapped;
      }
    } else {
      // Pick up the slot's item.
      this.heldItem = current;
      this.inventory.slots[index] = null;
    }
    this._renderSlots();
    this._renderHeld();
    if (this._onSlotsChanged) this._onSlotsChanged();
  }

  _pickFromPalette(item) {
    // Put the item in the selected hotbar slot (creative = infinite).
    this.inventory.slots[this.inventory.selected] = { kind: item.kind, id: item.id, count: Infinity };
    this._renderSlots();
  }

  _renderSlots() {
    for (let i = 0; i < 36; i++) {
      const { el, countEl } = this.slotEls[i];
      const item = this.inventory.slots[i];
      // Reset styles.
      el.style.backgroundImage = '';
      el.style.backgroundPosition = '';
      el.style.backgroundSize = '';
      countEl.textContent = '';

      if (item) {
        el.style.cssText += iconStyle(item, this.atlasURL, this.uvMap);
        if (item.count !== Infinity && item.count > 1) {
          countEl.textContent = String(item.count);
        }
      }
      // Highlight selected hotbar slot.
      if (i === this.inventory.selected) {
        el.style.borderColor = '#fff';
      } else {
        el.style.borderColor = 'rgba(255,255,255,0.2)';
      }
    }
  }

  _renderHeld() {
    if (this.heldItem) {
      this.heldEl.style.display = 'block';
      this.heldEl.style.cssText += iconStyle(this.heldItem, this.atlasURL, this.uvMap);
    } else {
      this.heldEl.style.display = 'none';
    }
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  // Attach a crafting grid of the given size (2 = inventory, 3 = crafting
  // table). Replaces any existing grid. Pass 0/null to remove it.
  setCraftingSize(size) {
    if (this.craftingUI) {
      // Eject current grid contents back to the inventory before swapping.
      this.craftingUI.ejectToInventory((item, count) => this.inventory.addItem(item, count));
      if (this.craftingUI.root.parentNode) this.craftingUI.root.remove();
      this.craftingUI = null;
    }
    if (!size) { this._renderSlots(); return; }
    // Lazy import avoids a hard cycle at module load.
    import('./crafting.js').then(({ CraftingUI }) => {
      // Creative = free crafting if ALL inventory stacks are infinite. For v1
      // (creative-only game) this is true. Survival consumption is wired and
      // will engage automatically once finite stacks exist.
      const creative = this._isCreative();
      const ui = new CraftingUI(
        size, this.atlasURL, this.uvMap,
        () => this.heldItem,            // held getter
        (v) => { this.heldItem = v; this._renderHeld(); }, // held setter
        creative
      );
      ui.onChange = () => this._renderHeld();
      this.craftingUI = ui;
      this.craftingMount.appendChild(ui.root);
      this._renderSlots();
    });
  }

  _isCreative() {
    // Creative if every occupied slot is an infinite stack (the default hotbar
    // fill). Any finite (picked-up) stack → survival crafting consumes.
    for (const s of this.inventory.slots) {
      if (s && s.count !== Infinity) return false;
    }
    return true;
  }

  open() {
    this.isOpen = true;
    this.overlay.style.display = 'flex';
    this._renderSlots();
    // Default to the 2×2 inventory crafting grid unless a table size was set.
    if (!this.craftingUI) this.setCraftingSize(2);
    if (this.onToggle) this.onToggle(true);
  }

  close() {
    // Eject crafting grid contents back to the inventory.
    if (this.craftingUI) {
      this.craftingUI.ejectToInventory((item, count) => this.inventory.addItem(item, count));
    }
    // Return held item to inventory.
    if (this.heldItem) {
      this.inventory.addItem({ kind: this.heldItem.kind, id: this.heldItem.id }, this.heldItem.count);
      this.heldItem = null;
      this._renderHeld();
    }
    // Reset to 2×2 for next open (a table-open sets 3×3 on demand).
    if (this.craftingUI && this.craftingUI.size !== 2) this.setCraftingSize(2);
    this.isOpen = false;
    this.overlay.style.display = 'none';
    if (this.onToggle) this.onToggle(false);
  }
}
