// Voxelcraft — Phase 1: Block registry.
//
// Every block type has a numeric id (0 = air, reserved). The registry is an
// array indexed by id so lookups are O(1). Fields:
//   name        : display name
//   textures    : [top, bottom, north, south, east, west] tile names in the
//                 atlas (Phase 2). 'all' shorthand filled out to 6 entries.
//   transparent : doesn't cull neighbour faces / light passes (water, leaves,
//                 glass, air)
//   solid       : blocks player + entity movement
//   liquid      : water/lava — special fluid handling (Phase 13+)
//   light       : emitted block light 0..15 (torches 14, lava 15)
//   hardness    : seconds to break by hand (mining tier scales this)
//   tool        : best tool class ('pickaxe' | 'axe' | 'shovel' | 'sword' | 'none')
//   drops       : block id dropped when broken (default: self). null = nothing.
//   shape       : 'cube' (default) or 'cross' (X-shaped plant: flowers, grass).
//                 Cross blocks emit 2 diagonal quads, no cube faces, non-solid.
//
// v1 ships with a working subset; the full ~80 Overworld blocks land as later
// phases need them (ores in Phase 9, woods/plants in Phase 10, crafted blocks
// in Phase 16). The registry is append-only — never reuse a retired id.

export const BLOCK = {
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  SAND: 5,
  WATER: 6,
  WOOD_LOG: 7,
  LEAVES: 8,
  GLASS: 9,
  BEDROCK: 10,
  SANDSTONE: 11,
  SNOW: 12,
  ICE: 13,
  PLANKS: 14,
  COAL_ORE: 15,
  IRON_ORE: 16,
  GOLD_ORE: 17,
  DIAMOND_ORE: 18,
  GRAVEL: 19,
  CLAY: 20,
  LAVA: 21,
  DEEPSLATE: 22,
  COBBLED_DEEPSLATE: 23,
  COPPER_ORE: 24,
  REDSTONE_ORE: 25,
  LAPIS_ORE: 26,
  EMERALD_ORE: 27,
  DEEPSLATE_COAL_ORE: 28,
  DEEPSLATE_IRON_ORE: 29,
  DEEPSLATE_GOLD_ORE: 30,
  DEEPSLATE_DIAMOND_ORE: 31,
  DEEPSLATE_COPPER_ORE: 32,
  DEEPSLATE_REDSTONE_ORE: 33,
  DEEPSLATE_LAPIS_ORE: 34,
  DEEPSLATE_EMERALD_ORE: 35,
  BIRCH_LOG: 36,
  BIRCH_LEAVES: 37,
  SPRUCE_LOG: 38,
  SPRUCE_LEAVES: 39,
  JUNGLE_LOG: 40,
  JUNGLE_LEAVES: 41,
  ACACIA_LOG: 42,
  ACACIA_LEAVES: 43,
  CACTUS: 44,
  TALL_GRASS: 45,
  FERN: 46,
  DANDELION: 47,
  POPPY: 48,
  DEAD_BUSH: 49,
  STONE_BRICKS: 50,
  MOSSY_COBBLESTONE: 51,
  TORCH: 52,
  CRAFTING_TABLE: 53,
  CHEST: 54,
};

const registry = [];

function expandTextures(t) {
  // Accept 'all', [side], [top, side, bottom], or full 6.
  if (typeof t === 'string') {
    const a = [t, t, t, t, t, t];
    return a;
  }
  if (t.length === 1) return [t[0], t[0], t[0], t[0], t[0], t[0]];
  if (t.length === 3) return [t[0], t[2], t[1], t[1], t[1], t[1]];
  if (t.length === 6) return t.slice();
  throw new Error('bad textures spec: ' + JSON.stringify(t));
}

export function registerBlock(id, def) {
  if (registry[id]) throw new Error('block id already registered: ' + id);
  registry[id] = {
    id,
    name: def.name,
    textures: expandTextures(def.textures),
    transparent: !!def.transparent,
    solid: def.solid !== false,
    liquid: !!def.liquid,
    light: def.light || 0,
    hardness: def.hardness ?? 1,
    tool: def.tool || 'none',
    drops: def.drops === undefined ? id : def.drops,
    shape: def.shape || 'cube',
  };
  return registry[id];
}

export function getBlockType(id) {
  return registry[id] || registry[0];
}

export function isTransparent(id) {
  const b = registry[id];
  return !b || b.transparent;
}

export function isSolid(id) {
  const b = registry[id];
  return !!(b && b.solid);
}

export function isCross(id) {
  const b = registry[id];
  return !!(b && b.shape === 'cross');
}

// --- v1 block set ---------------------------------------------------------
registerBlock(BLOCK.AIR, {
  name: 'Air', textures: 'air', transparent: true, solid: false,
  hardness: 0, drops: null,
});
registerBlock(BLOCK.STONE, {
  name: 'Stone', textures: 'stone', hardness: 1.5, tool: 'pickaxe',
  drops: BLOCK.COBBLESTONE,
});
registerBlock(BLOCK.GRASS, {
  name: 'Grass Block', textures: ['grass_top', 'dirt', 'grass_side'],
  hardness: 0.6, tool: 'shovel', drops: BLOCK.DIRT,
});
registerBlock(BLOCK.DIRT, {
  name: 'Dirt', textures: 'dirt', hardness: 0.5, tool: 'shovel',
});
registerBlock(BLOCK.COBBLESTONE, {
  name: 'Cobblestone', textures: 'cobblestone', hardness: 2, tool: 'pickaxe',
});
registerBlock(BLOCK.SAND, {
  name: 'Sand', textures: 'sand', hardness: 0.5, tool: 'shovel',
});
registerBlock(BLOCK.WATER, {
  name: 'Water', textures: 'water', transparent: true, solid: false,
  liquid: true, hardness: 100,
});
registerBlock(BLOCK.WOOD_LOG, {
  name: 'Wood Log', textures: ['wood_log_top', 'wood_log_top', 'wood_log_side'],
  hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.LEAVES, {
  // Opaque (Minecraft "fast" graphics style): the leaf tile is a full noise
  // fill, so rendering it solid looks correct and lets the greedy mesher cull
  // internal leaf/leaf faces. Casts shade under the canopy (blocks skylight).
  name: 'Leaves', textures: 'leaves', hardness: 0.2,
});
registerBlock(BLOCK.GLASS, {
  name: 'Glass', textures: 'glass', transparent: true, hardness: 0.3,
  drops: null,
});
registerBlock(BLOCK.BEDROCK, {
  name: 'Bedrock', textures: 'bedrock', hardness: Infinity,
});
registerBlock(BLOCK.SANDSTONE, {
  name: 'Sandstone', textures: ['sandstone_top', 'sandstone_bottom', 'sandstone_side'],
  hardness: 0.8, tool: 'pickaxe',
});
registerBlock(BLOCK.SNOW, {
  name: 'Snow Block', textures: 'snow', hardness: 0.2, tool: 'shovel',
});
registerBlock(BLOCK.ICE, {
  name: 'Ice', textures: 'ice', transparent: true, hardness: 0.5,
  drops: null,
});
registerBlock(BLOCK.PLANKS, {
  name: 'Wood Planks', textures: 'planks', hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.COAL_ORE, {
  name: 'Coal Ore', textures: 'coal_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.IRON_ORE, {
  name: 'Iron Ore', textures: 'iron_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.GOLD_ORE, {
  name: 'Gold Ore', textures: 'gold_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.DIAMOND_ORE, {
  name: 'Diamond Ore', textures: 'diamond_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.GRAVEL, {
  name: 'Gravel', textures: 'gravel', hardness: 0.6, tool: 'shovel',
});
registerBlock(BLOCK.CLAY, {
  name: 'Clay', textures: 'clay', hardness: 0.6, tool: 'shovel',
});
registerBlock(BLOCK.LAVA, {
  name: 'Lava', textures: 'lava', transparent: true, solid: false,
  liquid: true, light: 15, hardness: 100, drops: null,
});
registerBlock(BLOCK.DEEPSLATE, {
  name: 'Deepslate', textures: 'deepslate', hardness: 3, tool: 'pickaxe',
  drops: BLOCK.COBBLED_DEEPSLATE,
});
registerBlock(BLOCK.COBBLED_DEEPSLATE, {
  name: 'Cobbled Deepslate', textures: 'cobbled_deepslate', hardness: 3.5, tool: 'pickaxe',
});
registerBlock(BLOCK.COPPER_ORE, {
  name: 'Copper Ore', textures: 'copper_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.REDSTONE_ORE, {
  name: 'Redstone Ore', textures: 'redstone_ore', hardness: 3, tool: 'pickaxe',
  light: 4,
});
registerBlock(BLOCK.LAPIS_ORE, {
  name: 'Lapis Ore', textures: 'lapis_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.EMERALD_ORE, {
  name: 'Emerald Ore', textures: 'emerald_ore', hardness: 3, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_COAL_ORE, {
  name: 'Deepslate Coal Ore', textures: 'deepslate_coal_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_IRON_ORE, {
  name: 'Deepslate Iron Ore', textures: 'deepslate_iron_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_GOLD_ORE, {
  name: 'Deepslate Gold Ore', textures: 'deepslate_gold_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_DIAMOND_ORE, {
  name: 'Deepslate Diamond Ore', textures: 'deepslate_diamond_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_COPPER_ORE, {
  name: 'Deepslate Copper Ore', textures: 'deepslate_copper_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_REDSTONE_ORE, {
  name: 'Deepslate Redstone Ore', textures: 'deepslate_redstone_ore', hardness: 4.5, tool: 'pickaxe',
  light: 4,
});
registerBlock(BLOCK.DEEPSLATE_LAPIS_ORE, {
  name: 'Deepslate Lapis Ore', textures: 'deepslate_lapis_ore', hardness: 4.5, tool: 'pickaxe',
});
registerBlock(BLOCK.DEEPSLATE_EMERALD_ORE, {
  name: 'Deepslate Emerald Ore', textures: 'deepslate_emerald_ore', hardness: 4.5, tool: 'pickaxe',
});
// --- Phase 10: woods + plants ---
registerBlock(BLOCK.BIRCH_LOG, {
  name: 'Birch Log', textures: ['birch_log_top', 'birch_log_top', 'birch_log_side'],
  hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.BIRCH_LEAVES, {
  name: 'Birch Leaves', textures: 'birch_leaves', hardness: 0.2,
});
registerBlock(BLOCK.SPRUCE_LOG, {
  name: 'Spruce Log', textures: ['spruce_log_top', 'spruce_log_top', 'spruce_log_side'],
  hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.SPRUCE_LEAVES, {
  name: 'Spruce Leaves', textures: 'spruce_leaves', hardness: 0.2,
});
registerBlock(BLOCK.JUNGLE_LOG, {
  name: 'Jungle Log', textures: ['jungle_log_top', 'jungle_log_top', 'jungle_log_side'],
  hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.JUNGLE_LEAVES, {
  name: 'Jungle Leaves', textures: 'jungle_leaves', hardness: 0.2,
});
registerBlock(BLOCK.ACACIA_LOG, {
  name: 'Acacia Log', textures: ['acacia_log_top', 'acacia_log_top', 'acacia_log_side'],
  hardness: 2, tool: 'axe',
});
registerBlock(BLOCK.ACACIA_LEAVES, {
  name: 'Acacia Leaves', textures: 'acacia_leaves', hardness: 0.2,
});
registerBlock(BLOCK.CACTUS, {
  name: 'Cactus', textures: ['cactus_top', 'cactus_top', 'cactus_side'],
  transparent: true, solid: true, hardness: 0.4,
});
registerBlock(BLOCK.TALL_GRASS, {
  name: 'Tall Grass', textures: 'tall_grass', transparent: true, solid: false,
  hardness: 0, drops: null, shape: 'cross',
});
registerBlock(BLOCK.FERN, {
  name: 'Fern', textures: 'fern', transparent: true, solid: false,
  hardness: 0, drops: null, shape: 'cross',
});
registerBlock(BLOCK.DANDELION, {
  name: 'Dandelion', textures: 'dandelion', transparent: true, solid: false,
  hardness: 0, drops: null, shape: 'cross',
});
registerBlock(BLOCK.POPPY, {
  name: 'Poppy', textures: 'poppy', transparent: true, solid: false,
  hardness: 0, drops: null, shape: 'cross',
});
registerBlock(BLOCK.DEAD_BUSH, {
  name: 'Dead Bush', textures: 'dead_bush', transparent: true, solid: false,
  hardness: 0, drops: null, shape: 'cross',
});
// --- Phase 11: structure blocks ---
registerBlock(BLOCK.STONE_BRICKS, {
  name: 'Stone Bricks', textures: 'stone_bricks', hardness: 1.5, tool: 'pickaxe',
});
registerBlock(BLOCK.MOSSY_COBBLESTONE, {
  name: 'Mossy Cobblestone', textures: 'mossy_cobblestone', hardness: 2, tool: 'pickaxe',
});
// --- Phase 13: light-emitting block ---
registerBlock(BLOCK.TORCH, {
  name: 'Torch', textures: 'torch', transparent: true, solid: false,
  light: 14, hardness: 0, drops: null, shape: 'cross',
});

// --- Phase 16: crafting blocks ---
// CRAFTING_TABLE: top face uses the saw-grid texture, sides the table-leg
// texture, bottom planks. Solid + placeable; right-clicking it opens the 3×3
// crafting grid (wired in main.js, not here).
registerBlock(BLOCK.CRAFTING_TABLE, {
  name: 'Crafting Table',
  textures: ['crafting_table_top', 'planks', 'crafting_table_side'],
  hardness: 2, tool: 'axe',
});
// CHEST: registered now so its recipe + block exist. Storage UI is Phase 22 —
// placing/breaking works today; opening shows a "coming in Phase 22" message.
registerBlock(BLOCK.CHEST, {
  name: 'Chest',
  textures: 'chest',
  hardness: 2, tool: 'axe',
});

export const BLOCK_COUNT = registry.length;
export { registry as BLOCK_REGISTRY };
