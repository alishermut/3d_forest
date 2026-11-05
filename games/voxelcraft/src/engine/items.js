// Voxelcraft — Phase 16: item registry.
//
// A separate namespace for non-block items — things that live in the inventory
// but can't be placed in the world (sticks, ingots, coal, etc.). Blocks and
// items never collide because an inventory slot carries a `kind` discriminator:
//   slot = { kind: 'block' | 'item', id, count }
// Block ids are numbers (BLOCK.*); item ids are strings (ITEM.*).
//
// Each item mirrors enough of the block shape for icon rendering: a `texture`
// tile name looked up in the atlas, plus a display `name`. `placeable: false`
// is always implicit for items (you can't RMB-place a stick).
//
// Tools (pickaxe/axe/sword) are deferred to Phase 17 — they need durability,
// mining-tier gating, and per-tool NBT. This registry holds the raw material
// items the survival loop needs NOW (Phase 16 crafting).

// String ids keep recipes + inventory logic readable and avoid any chance of a
// numeric collision with block ids.
export const ITEM = {
  STICK: 'stick',
  COAL: 'coal',
  CHARCOAL: 'charcoal',
  IRON_INGOT: 'iron_ingot',
  COPPER_INGOT: 'copper_ingot',
  GOLD_INGOT: 'gold_ingot',
  DIAMOND: 'diamond',
  EMERALD: 'emerald',
  LAPIS: 'lapis',
  REDSTONE: 'redstone',
  FLINT: 'flint',
  // Phase 19: mob drops
  WOOL: 'wool',
  MUTTON: 'mutton',
  LEATHER: 'leather',
  BEEF: 'beef',
  PORKCHOP: 'porkchop',
  CHICKEN: 'chicken',
  FEATHER: 'feather',
  EGG: 'egg',
};

// Append-only registry indexed by item id (string). Item ids MUST be unique.
const registry = new Map();

export function registerItem(id, def) {
  if (registry.has(id)) throw new Error(`Duplicate item id: ${id}`);
  registry.set(id, {
    id,
    name: def.name,
    texture: def.texture, // atlas tile name
    kind: 'item', // discriminator — matches slot.kind
    // `placeable` is always false for items; kept out of the shape to avoid
    // any code path thinking an item can be placed as a block.
  });
}

export function getItemType(id) {
  return registry.get(id);
}

export function isItem(id) {
  return registry.has(id);
}

// True if an inventory slot's payload refers to the SAME thing as another
// (block↔block by numeric id, item↔item by string id). Cross-kind is always
// false — a planks block never matches a stick item even if ids overlapped.
export function sameItem(a, b) {
  if (!a || !b) return false;
  if ((a.kind || 'block') !== (b.kind || 'block')) return false;
  return a.id === b.id;
}

// Convenience constructors for slot payloads.
export function blockSlot(blockId, count = 1) {
  return { kind: 'block', id: blockId, count };
}
export function itemSlot(itemId, count = 1) {
  return { kind: 'item', id: itemId, count };
}

// --- Register the v1 item set ---------------------------------------------
// Texture names must be drawn by atlas.js (added in the Phase 16 atlas pass).
registerItem(ITEM.STICK, {
  name: 'Stick',
  texture: 'stick',
});
registerItem(ITEM.COAL, {
  name: 'Coal',
  texture: 'coal',
});
registerItem(ITEM.CHARCOAL, {
  name: 'Charcoal',
  texture: 'charcoal',
});
registerItem(ITEM.IRON_INGOT, {
  name: 'Iron Ingot',
  texture: 'iron_ingot',
});
registerItem(ITEM.COPPER_INGOT, {
  name: 'Copper Ingot',
  texture: 'copper_ingot',
});
registerItem(ITEM.GOLD_INGOT, {
  name: 'Gold Ingot',
  texture: 'gold_ingot',
});
registerItem(ITEM.DIAMOND, {
  name: 'Diamond',
  texture: 'diamond',
});
registerItem(ITEM.EMERALD, {
  name: 'Emerald',
  texture: 'emerald',
});
registerItem(ITEM.LAPIS, {
  name: 'Lapis Lazuli',
  texture: 'lapis',
});
registerItem(ITEM.REDSTONE, {
  name: 'Redstone',
  texture: 'redstone_item',
});
registerItem(ITEM.FLINT, {
  name: 'Flint',
  texture: 'flint',
});

// --- Phase 19: mob-drop items ---
registerItem(ITEM.WOOL, { name: 'Wool', texture: 'wool' });
registerItem(ITEM.MUTTON, { name: 'Raw Mutton', texture: 'mutton' });
registerItem(ITEM.LEATHER, { name: 'Leather', texture: 'leather' });
registerItem(ITEM.BEEF, { name: 'Raw Beef', texture: 'beef' });
registerItem(ITEM.PORKCHOP, { name: 'Raw Porkchop', texture: 'porkchop' });
registerItem(ITEM.CHICKEN, { name: 'Raw Chicken', texture: 'chicken' });
registerItem(ITEM.FEATHER, { name: 'Feather', texture: 'feather' });
registerItem(ITEM.EGG, { name: 'Egg', texture: 'egg' });

export const ITEM_REGISTRY = registry;
export const ITEM_COUNT = registry.size;
