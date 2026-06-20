// Voxelcraft — Phase 16: crafting recipe matcher.
//
// Two recipe kinds (Minecraft-faithful):
//   - shaped: a 2D pattern of ingredient tokens. Matched against the crafting
//     grid AFTER normalizing (trimming empty rows/cols) so the recipe works in
//     any corner of the grid. Optionally mirrorable on the horizontal axis (MC
//     mirrors most shaped recipes — planks, tools, etc. — but NOT things like
//     the crafting table).
//   - shapeless: a multiset of ingredients; matched regardless of arrangement.
//
// An "ingredient token" is a { kind, id } pair (same shape as an inventory slot
// payload, minus count). A recipe ingredient may accept multiple ids (e.g. any
// wood log → planks) via the `any` array.
//
// matchRecipe(gridCells) takes a flat array of N×N grid slots (null or
// {kind,id,count}) and returns the matched recipe's result, or null. The grid
// is the live crafting input — counts are NOT consumed here; the UI does that
// on output-click.

import { BLOCK } from './blocks.js';
import { ITEM } from './items.js';
import { sameItem } from './items.js';

// Does a single ingredient spec match a placed slot? `spec` is either a
// {kind,id} pair or { any: [{kind,id}...] } (matches any of the listed).
function ingredientMatches(slot, spec) {
  if (!slot || !spec) return false;
  if (spec.any) {
    return spec.any.some((s) => sameItem(slot, s));
  }
  return sameItem(slot, spec);
}

// --- Recipe table ----------------------------------------------------------
// Each shaped recipe's `pattern` is an array of equal-length strings. Each char
// maps to an ingredient via `key`; ' ' = empty cell. Result count >1 for things
// like planks (4) and torches (4).
export const RECIPES = [
  // Planks: any wood log (1 log → 4 planks). Shaped, 1-cell, not mirrored
  // (mirroring a 1-cell recipe is a no-op, but stated for clarity).
  {
    id: 'planks_oak', type: 'shaped', mirror: false,
    pattern: ['L'], key: { L: { any: [{ kind: 'block', id: BLOCK.WOOD_LOG }] } },
    result: { kind: 'block', id: BLOCK.PLANKS, count: 4 },
  },
  {
    id: 'planks_birch', type: 'shaped', mirror: false,
    pattern: ['L'], key: { L: { any: [{ kind: 'block', id: BLOCK.BIRCH_LOG }] } },
    result: { kind: 'block', id: BLOCK.PLANKS, count: 4 },
  },
  {
    id: 'planks_spruce', type: 'shaped', mirror: false,
    pattern: ['L'], key: { L: { any: [{ kind: 'block', id: BLOCK.SPRUCE_LOG }] } },
    result: { kind: 'block', id: BLOCK.PLANKS, count: 4 },
  },
  {
    id: 'planks_jungle', type: 'shaped', mirror: false,
    pattern: ['L'], key: { L: { any: [{ kind: 'block', id: BLOCK.JUNGLE_LOG }] } },
    result: { kind: 'block', id: BLOCK.PLANKS, count: 4 },
  },
  {
    id: 'planks_acacia', type: 'shaped', mirror: false,
    pattern: ['L'], key: { L: { any: [{ kind: 'block', id: BLOCK.ACACIA_LOG }] } },
    result: { kind: 'block', id: BLOCK.PLANKS, count: 4 },
  },

  // Stick: two planks stacked vertically → 4 sticks. Mirrored (symmetric).
  {
    id: 'stick', type: 'shaped', mirror: true,
    pattern: ['P', 'P'], key: { P: { kind: 'block', id: BLOCK.PLANKS } },
    result: { kind: 'item', id: ITEM.STICK, count: 4 },
  },

  // Crafting Table: 2×2 of planks.
  {
    id: 'crafting_table', type: 'shaped', mirror: false,
    pattern: ['PP', 'PP'], key: { P: { kind: 'block', id: BLOCK.PLANKS } },
    result: { kind: 'block', id: BLOCK.CRAFTING_TABLE, count: 1 },
  },

  // Chest: 8 planks in a ring (hollow square) → 1 chest. Needs 3×3.
  {
    id: 'chest', type: 'shaped', mirror: false,
    pattern: ['PPP', 'P P', 'PPP'], key: { P: { kind: 'block', id: BLOCK.PLANKS } },
    result: { kind: 'block', id: BLOCK.CHEST, count: 1 },
  },

  // Furnace: 8 cobblestone in a ring → 1 furnace. Needs 3×3. (Furnace block
  // itself isn't placed as a usable block until Phase 21 smelting, but the
  // recipe + item exist now.)
  {
    id: 'furnace', type: 'shaped', mirror: false,
    pattern: ['CCC', 'C C', 'CCC'], key: { C: { kind: 'block', id: BLOCK.COBBLESTONE } },
    result: { kind: 'block', id: BLOCK.STONE, count: 1 }, // placeholder until FURNACE block id exists (Phase 21)
  },

  // Torch: coal/charcoal on top of a stick → 4 torches. Mirrored.
  {
    id: 'torch', type: 'shaped', mirror: true,
    pattern: ['C', 'S'],
    key: {
      C: { any: [{ kind: 'item', id: ITEM.COAL }, { kind: 'item', id: ITEM.CHARCOAL }] },
      S: { kind: 'item', id: ITEM.STICK },
    },
    result: { kind: 'block', id: BLOCK.TORCH, count: 4 },
  },

  // Stone Bricks: 2×2 of stone → 4 stone bricks.
  {
    id: 'stone_bricks', type: 'shaped', mirror: false,
    pattern: ['SS', 'SS'], key: { S: { kind: 'block', id: BLOCK.STONE } },
    result: { kind: 'block', id: BLOCK.STONE_BRICKS, count: 4 },
  },

  // Mossy Cobblestone: shapeless — cobblestone + any "moss" source. For v1 we
  // accept cobblestone + dirt (no moss-block item yet). Demonstrates shapeless.
  {
    id: 'mossy_cobblestone', type: 'shapeless',
    ingredients: [
      { kind: 'block', id: BLOCK.COBBLESTONE },
      { kind: 'block', id: BLOCK.DIRT },
    ],
    result: { kind: 'block', id: BLOCK.MOSSY_COBBLESTONE, count: 1 },
  },
];

// --- Shaped matching -------------------------------------------------------
// Convert the flat grid into a 2D matrix, trim empty rows/cols, and compare
// against the recipe pattern (and its mirror if mirror:true).
function matchShaped(recipe, flatGrid, size) {
  const grid = toMatrix(flatGrid, size);
  const trimmed = trimEmpty(grid);
  if (!trimmed) return false;
  const candidates = recipe.mirror ? [trimmed, mirrorHorizontal(trimmed)] : [trimmed];
  for (const cand of candidates) {
    if (patternsEqual(cand, recipe, /*requireExact=*/true)) return true;
  }
  return false;
}

function toMatrix(flatGrid, size) {
  const m = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(flatGrid[r * size + c] || null);
    m.push(row);
  }
  return m;
}

// Remove all-empty border rows/cols so a recipe in the corner matches.
function trimEmpty(matrix) {
  let top = 0, bot = matrix.length - 1, left = 0, right = matrix[0].length - 1;
  const isEmpty = (r, c) => !matrix[r] || !matrix[r][c];
  while (top <= bot && rowEmpty(matrix, top)) top++;
  if (top > bot) return null; // entirely empty
  while (rowEmpty(matrix, bot)) bot--;
  while (colEmpty(matrix, left, top, bot)) left++;
  while (colEmpty(matrix, right, top, bot)) right--;
  const out = [];
  for (let r = top; r <= bot; r++) {
    const row = [];
    for (let c = left; c <= right; c++) row.push(matrix[r][c]);
    out.push(row);
  }
  return out;
}
function rowEmpty(m, r) { return m[r].every((cell) => !cell); }
function colEmpty(m, c, top, bot) {
  for (let r = top; r <= bot; r++) if (m[r][c]) return false;
  return true;
}

function mirrorHorizontal(matrix) {
  return matrix.map((row) => [...row].reverse());
}

function patternsEqual(grid, recipe, requireExact) {
  const pat = recipe.pattern;
  if (grid.length !== pat.length) return false;
  for (let r = 0; r < pat.length; r++) {
    if (grid[r].length !== pat[r].length) return false;
    for (let c = 0; c < pat[r].length; c++) {
      const ch = pat[r][c];
      const cell = grid[r][c];
      if (ch === ' ') {
        if (cell) return false; // expected empty, found an item
      } else {
        const spec = recipe.key[ch];
        if (!ingredientMatches(cell, spec)) return false;
      }
    }
  }
  return true;
}

// --- Shapeless matching ----------------------------------------------------
function matchShapeless(recipe, flatGrid) {
  // Collect non-null grid cells.
  const placed = flatGrid.filter((s) => s);
  if (placed.length !== recipe.ingredients.length) return false;
  // Each ingredient must match a unique placed cell (greedy assignment).
  const used = new Array(placed.length).fill(false);
  for (const spec of recipe.ingredients) {
    let found = false;
    for (let i = 0; i < placed.length; i++) {
      if (!used[i] && ingredientMatches(placed[i], spec)) {
        used[i] = true; found = true; break;
      }
    }
    if (!found) return false;
  }
  return used.every(Boolean);
}

// --- Public entry ----------------------------------------------------------
// `flatGrid` = array of size*size slots (null or {kind,id,count}). `size` = 2
// or 3. Returns the matched recipe object (so the caller can read .result),
// or null. The grid's counts are NOT modified — the caller consumes on craft.
export function matchRecipe(flatGrid, size) {
  // Quick reject: entirely empty grid → no match.
  if (flatGrid.every((s) => !s)) return null;
  for (const recipe of RECIPES) {
    if (recipe.type === 'shaped') {
      if (matchShaped(recipe, flatGrid, size)) return recipe;
    } else if (recipe.type === 'shapeless') {
      if (matchShapeless(recipe, flatGrid)) return recipe;
    }
  }
  return null;
}
