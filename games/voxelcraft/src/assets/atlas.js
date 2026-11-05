// Voxelcraft — Phase 2: procedural pixel-art texture atlas.
//
// Generates 16×16 pixel-art tiles into a single atlas texture at load time.
// No external assets, no licensing — classic Minecraft look. Each tile is a
// named entry; the mesher looks up UVs by tile name from the block registry's
// 6-face texture spec.
//
// The atlas is a 16×16 grid of 16×16 tiles = 256×256 px. Tiles are drawn with
// simple seeded-noise patterns in the right palette per block. Swappable for a
// real texture pack later — just replace this module's draw functions with
// ImageBitmap loads.

import * as THREE from 'three';
import { BLOCK_REGISTRY } from '../engine/blocks.js';
import { ITEM_REGISTRY } from '../engine/items.js';

const TILE = 16; // pixels per tile side
const ATLAS_COLS = 16; // tiles per row
const ATLAS_SIZE = TILE * ATLAS_COLS; // 256

// Tiny seeded PRNG so tiles are deterministic per-tile.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fill a tile region of the canvas with a base color + per-pixel HSL jitter.
function paintNoise(ctx, ox, oy, base, jitter, seed) {
  const rnd = mulberry32(seed);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const j = (rnd() - 0.5) * 2 * jitter;
      const r = Math.max(0, Math.min(255, base[0] + j * 30));
      const g = Math.max(0, Math.min(255, base[1] + j * 30));
      const b = Math.max(0, Math.min(255, base[2] + j * 30));
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

// Draw speckles of a spot color on top of an already-painted tile.
function paintSpots(ctx, ox, oy, spot, count, seed, sizeMax = 2) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const x = (rnd() * TILE) | 0;
    const y = (rnd() * TILE) | 0;
    const w = 1 + ((rnd() * sizeMax) | 0);
    const h = 1 + ((rnd() * sizeMax) | 0);
    const j = (rnd() - 0.5) * 30;
    ctx.fillStyle = `rgb(${Math.max(0, spot[0] + j) | 0},${Math.max(0, spot[1] + j) | 0},${Math.max(0, spot[2] + j) | 0})`;
    ctx.fillRect(ox + x, oy + y, w, h);
  }
}

// Per-tile draw dispatch. Names match the texture names in blocks.js.
function drawTile(ctx, name, ox, oy) {
  switch (name) {
    case 'air': return;
    case 'stone':       paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 1); paintSpots(ctx, ox, oy, [100,100,100], 18, 2); break;
    case 'cobblestone': paintNoise(ctx, ox, oy, [110, 110, 110], 0.5, 3); paintSpots(ctx, ox, oy, [80,80,80], 30, 4, 3); paintSpots(ctx, ox, oy, [150,150,150], 15, 5, 2); break;
    case 'dirt':        paintNoise(ctx, ox, oy, [134, 96, 67], 0.4, 7); paintSpots(ctx, ox, oy, [90, 64, 44], 14, 8); break;
    case 'grass_top':   paintNoise(ctx, ox, oy, [95, 159, 53], 0.45, 9); paintSpots(ctx, ox, oy, [70, 130, 40], 16, 10); break;
    case 'grass_side':  paintNoise(ctx, ox, oy, [134, 96, 67], 0.4, 11); paintSpots(ctx, ox, oy, [90, 64, 44], 10, 12); // dirt base
                        // green top strip (4 px)
                        for (let x = 0; x < TILE; x++) for (let y = 0; y < 4; y++) {
                          const j = (mulberry32(x*7+y*13+13)()-0.5)*30;
                          ctx.fillStyle = `rgb(${(95+j)|0},${(159+j)|0},${(53+j)|0})`;
                          ctx.fillRect(ox + x, oy + y, 1, 1);
                        }
                        // jagged green drip
                        for (let x = 0; x < TILE; x++) {
                          const drip = 3 + ((mulberry32(x*5+21)()*3)|0);
                          for (let y = 4; y < drip; y++) {
                            ctx.fillStyle = `rgb(95,159,53)`;
                            ctx.fillRect(ox + x, oy + y, 1, 1);
                          }
                        }
                        break;
    case 'sand':        paintNoise(ctx, ox, oy, [219, 207, 163], 0.25, 13); break;
    case 'water':       paintNoise(ctx, ox, oy, [60, 100, 200], 0.2, 15); break;
    case 'wood_log_top':paintNoise(ctx, ox, oy, [165, 130, 85], 0.2, 17);
                        // rings
                        ctx.strokeStyle = 'rgb(120, 90, 55)';
                        for (let r = 2; r <= 7; r += 2) {
                          ctx.beginPath(); ctx.arc(ox + 8, oy + 8, r, 0, Math.PI * 2); ctx.stroke();
                        }
                        break;
    case 'wood_log_side':paintNoise(ctx, ox, oy, [110, 80, 50], 0.35, 19);
                        // vertical bark streaks
                        for (let x = 0; x < TILE; x += 3) {
                          ctx.fillStyle = 'rgb(80, 55, 30)';
                          ctx.fillRect(ox + x, oy, 1, TILE);
                        }
                        break;
    case 'leaves':      paintNoise(ctx, ox, oy, [60, 110, 40], 0.5, 21); paintSpots(ctx, ox, oy, [40, 80, 25], 24, 22, 2); paintSpots(ctx, ox, oy, [90, 140, 60], 12, 23, 1); break;
    case 'glass':       // mostly transparent with a frame
                        ctx.clearRect(ox, oy, TILE, TILE);
                        ctx.fillStyle = 'rgba(200, 230, 255, 0.15)';
                        ctx.fillRect(ox, oy, TILE, TILE);
                        ctx.strokeStyle = 'rgba(220, 240, 255, 0.8)';
                        ctx.strokeRect(ox + 0.5, oy + 0.5, TILE - 1, TILE - 1);
                        break;
    case 'bedrock':     paintNoise(ctx, ox, oy, [70, 70, 70], 0.5, 25); paintSpots(ctx, ox, oy, [40,40,40], 20, 26, 3); paintSpots(ctx, ox, oy, [110,110,110], 12, 27, 2); break;
    case 'sandstone_top':paintNoise(ctx, ox, oy, [220, 210, 165], 0.2, 29); break;
    case 'sandstone_bottom':paintNoise(ctx, ox, oy, [180, 165, 120], 0.2, 31); break;
    case 'sandstone_side':paintNoise(ctx, ox, oy, [205, 190, 145], 0.2, 33);
                        ctx.fillStyle = 'rgb(180,165,120)'; ctx.fillRect(ox, oy + 4, TILE, 2); ctx.fillRect(ox, oy + 10, TILE, 2);
                        break;
    case 'snow':        paintNoise(ctx, ox, oy, [245, 248, 255], 0.15, 35); break;
    case 'ice':         paintNoise(ctx, ox, oy, [150, 200, 240], 0.2, 37); break;
    case 'planks':      paintNoise(ctx, ox, oy, [165, 130, 85], 0.25, 39);
                        // plank seams every 4px
                        ctx.fillStyle = 'rgb(120, 90, 55)';
                        for (let y = 3; y < TILE; y += 4) ctx.fillRect(ox, oy + y, TILE, 1);
                        break;
    case 'coal_ore':    paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 41); paintSpots(ctx, ox, oy, [30, 30, 30], 10, 42, 2); break;
    case 'iron_ore':    paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 43); paintSpots(ctx, ox, oy, [200, 160, 120], 10, 44, 2); break;
    case 'gold_ore':    paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 45); paintSpots(ctx, ox, oy, [240, 220, 80], 10, 46, 2); break;
    case 'diamond_ore': paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 47); paintSpots(ctx, ox, oy, [100, 230, 230], 10, 48, 2); break;
    case 'copper_ore':  paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 55); paintSpots(ctx, ox, oy, [210, 130, 80], 10, 56, 2); break;
    case 'redstone_ore':paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 57); paintSpots(ctx, ox, oy, [180, 30, 30], 12, 58, 2); break;
    case 'lapis_ore':   paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 59); paintSpots(ctx, ox, oy, [40, 70, 200], 10, 60, 2); break;
    case 'emerald_ore': paintNoise(ctx, ox, oy, [128, 128, 128], 0.4, 61); paintSpots(ctx, ox, oy, [40, 200, 90], 8, 62, 2); break;
    case 'lava':        paintNoise(ctx, ox, oy, [220, 90, 20], 0.4, 63);
                        paintSpots(ctx, ox, oy, [255, 200, 60], 18, 64, 2);
                        paintSpots(ctx, ox, oy, [120, 30, 0], 8, 65, 2);
                        break;
    case 'deepslate':   paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 67); paintSpots(ctx, ox, oy, [50, 50, 55], 16, 68, 2); break;
    case 'cobbled_deepslate': paintNoise(ctx, ox, oy, [65, 65, 70], 0.45, 69); paintSpots(ctx, ox, oy, [45,45,50], 28, 70, 3); paintSpots(ctx, ox, oy, [90,90,95], 12, 71, 2); break;
    case 'deepslate_coal_ore':    paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 72); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 73, 2); paintSpots(ctx, ox, oy, [30, 30, 30], 8, 74, 2); break;
    case 'deepslate_iron_ore':    paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 75); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 76, 2); paintSpots(ctx, ox, oy, [200, 160, 120], 8, 77, 2); break;
    case 'deepslate_gold_ore':    paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 78); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 79, 2); paintSpots(ctx, ox, oy, [240, 220, 80], 8, 80, 2); break;
    case 'deepslate_diamond_ore': paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 81); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 82, 2); paintSpots(ctx, ox, oy, [100, 230, 230], 8, 83, 2); break;
    case 'deepslate_copper_ore':  paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 84); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 85, 2); paintSpots(ctx, ox, oy, [210, 130, 80], 8, 86, 2); break;
    case 'deepslate_redstone_ore':paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 87); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 88, 2); paintSpots(ctx, ox, oy, [180, 30, 30], 10, 89, 2); break;
    case 'deepslate_lapis_ore':   paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 90); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 91, 2); paintSpots(ctx, ox, oy, [40, 70, 200], 8, 92, 2); break;
    case 'deepslate_emerald_ore': paintNoise(ctx, ox, oy, [70, 70, 75], 0.35, 93); paintSpots(ctx, ox, oy, [50, 50, 55], 14, 94, 2); paintSpots(ctx, ox, oy, [40, 200, 90], 6, 95, 2); break;
    case 'gravel':      paintNoise(ctx, ox, oy, [120, 110, 100], 0.5, 49); paintSpots(ctx, ox, oy, [80,75,70], 20, 50, 2); paintSpots(ctx, ox, oy, [160,150,140], 12, 51, 1); break;
    case 'clay':        paintNoise(ctx, ox, oy, [160, 165, 175], 0.2, 53); break;
    // --- Phase 10: wood variants ---
    case 'birch_log_top':  paintNoise(ctx, ox, oy, [220, 210, 180], 0.2, 96); break;
    case 'birch_log_side': paintNoise(ctx, ox, oy, [225, 215, 185], 0.2, 97);
                           // black streaks
                           for (let x = 0; x < TILE; x += 4) {
                             const h = 2 + ((mulberry32(x*9+5)()*4)|0);
                             ctx.fillStyle = 'rgb(40,35,30)';
                             ctx.fillRect(ox + x, oy + h, 1, 3 + ((mulberry32(x*3)()*3)|0));
                           }
                           break;
    case 'birch_leaves':   paintNoise(ctx, ox, oy, [110, 140, 70], 0.4, 98); paintSpots(ctx, ox, oy, [80,110,50], 18, 99, 2); break;
    case 'spruce_log_top': paintNoise(ctx, ox, oy, [110, 80, 50], 0.2, 100);
                           ctx.strokeStyle = 'rgb(80,55,35)';
                           for (let r = 2; r <= 7; r += 2) { ctx.beginPath(); ctx.arc(ox+8, oy+8, r, 0, Math.PI*2); ctx.stroke(); }
                           break;
    case 'spruce_log_side':paintNoise(ctx, ox, oy, [85, 60, 38], 0.35, 101);
                           for (let x = 0; x < TILE; x += 3) { ctx.fillStyle = 'rgb(55,38,22)'; ctx.fillRect(ox + x, oy, 1, TILE); }
                           break;
    case 'spruce_leaves':  paintNoise(ctx, ox, oy, [50, 80, 45], 0.45, 102); paintSpots(ctx, ox, oy, [35,60,30], 20, 103, 2); break;
    case 'jungle_log_top': paintNoise(ctx, ox, oy, [150, 110, 70], 0.2, 104);
                           ctx.strokeStyle = 'rgb(110,80,50)'; for (let r = 2; r <= 7; r += 2) { ctx.beginPath(); ctx.arc(ox+8, oy+8, r, 0, Math.PI*2); ctx.stroke(); }
                           break;
    case 'jungle_log_side':paintNoise(ctx, ox, oy, [100, 75, 45], 0.35, 105);
                           for (let x = 0; x < TILE; x += 3) { ctx.fillStyle = 'rgb(70,50,30)'; ctx.fillRect(ox + x, oy, 1, TILE); }
                           break;
    case 'jungle_leaves':  paintNoise(ctx, ox, oy, [50, 95, 35], 0.5, 106); paintSpots(ctx, ox, oy, [30,70,20], 22, 107, 2); paintSpots(ctx, ox, oy, [80,130,55], 10, 108, 1); break;
    case 'acacia_log_top': paintNoise(ctx, ox, oy, [180, 130, 80], 0.2, 109);
                           ctx.strokeStyle = 'rgb(140,100,60)'; for (let r = 2; r <= 7; r += 2) { ctx.beginPath(); ctx.arc(ox+8, oy+8, r, 0, Math.PI*2); ctx.stroke(); }
                           break;
    case 'acacia_log_side':paintNoise(ctx, ox, oy, [160, 115, 70], 0.35, 110);
                           for (let x = 0; x < TILE; x += 4) { ctx.fillStyle = 'rgb(120,85,50)'; ctx.fillRect(ox + x, oy, 1, TILE); }
                           break;
    case 'acacia_leaves':  paintNoise(ctx, ox, oy, [90, 130, 55], 0.45, 111); paintSpots(ctx, ox, oy, [65,100,40], 18, 112, 2); break;
    case 'cactus_top':     paintNoise(ctx, ox, oy, [70, 130, 60], 0.25, 113);
                           ctx.fillStyle = 'rgb(50,100,45)'; ctx.fillRect(ox+6, oy+6, 4, 4);
                           break;
    case 'cactus_side':    paintNoise(ctx, ox, oy, [75, 135, 65], 0.3, 114);
                           // vertical ridges
                           for (let x = 1; x < TILE; x += 5) { ctx.fillStyle = 'rgb(55,105,50)'; ctx.fillRect(ox + x, oy, 1, TILE); }
                           // spines
                           for (let x = 3; x < TILE; x += 5) { for (let y = 2; y < TILE; y += 4) { ctx.fillStyle = 'rgb(220,220,200)'; ctx.fillRect(ox + x, oy + y, 1, 1); } }
                           break;
    // --- Phase 10: cross plants (transparent background, plant sprite) ---
    case 'tall_grass':     ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [0,0,0], 0, 0); // clear
                           for (let x = 2; x < 14; x += 2) {
                             const h = 8 + ((mulberry32(x*7+3)()*6)|0);
                             ctx.fillStyle = `rgb(${95+((x*13)%20)|0},${159+((x*7)%15)|0},${53+((x*5)%15)|0})`;
                             ctx.fillRect(ox + x, oy + 16 - h, 1, h);
                           }
                           break;
    case 'fern':           ctx.clearRect(ox, oy, TILE, TILE);
                           for (let x = 1; x < 15; x += 3) {
                             const h = 6 + ((mulberry32(x*11+7)()*7)|0);
                             ctx.fillStyle = `rgb(${60+((x*9)%20)|0},${120+((x*5)%20)|0},${45+((x*7)%15)|0})`;
                             ctx.fillRect(ox + x, oy + 16 - h, 1, h);
                             // frond top
                             ctx.fillRect(ox + x - 1, oy + 16 - h, 3, 1);
                           }
                           break;
    case 'dandelion':      ctx.clearRect(ox, oy, TILE, TILE);
                           // stem
                           ctx.fillStyle = 'rgb(60,120,40)'; ctx.fillRect(ox + 8, oy + 10, 1, 6);
                           // flower head
                           paintNoise(ctx, ox + 5, oy + 4, [240, 220, 60], 0.3, 120);
                           ctx.fillStyle = 'rgb(220,200,50)'; ctx.fillRect(ox+5, oy+4, 6, 5);
                           ctx.fillStyle = 'rgb(240,220,60)';
                           for (let i = 0; i < 5; i++) { ctx.fillRect(ox + 5 + i, oy + 3, 1, 1); ctx.fillRect(ox + 5 + i, oy + 9, 1, 1); }
                           break;
    case 'poppy':          ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(60,120,40)'; ctx.fillRect(ox + 8, oy + 10, 1, 6);
                           paintNoise(ctx, ox + 5, oy + 4, [200, 40, 40], 0.3, 121);
                           ctx.fillStyle = 'rgb(180,30,30)'; ctx.fillRect(ox+5, oy+4, 6, 5);
                           ctx.fillStyle = 'rgb(220,50,50)';
                           for (let i = 0; i < 5; i++) { ctx.fillRect(ox + 5 + i, oy + 3, 1, 1); ctx.fillRect(ox + 5 + i, oy + 9, 1, 1); }
                           break;
    case 'dead_bush':      ctx.clearRect(ox, oy, TILE, TILE);
                           for (let x = 2; x < 14; x += 2) {
                             const h = 5 + ((mulberry32(x*17+11)()*7)|0);
                             ctx.fillStyle = `rgb(${110+((x*7)%30)|0},${85+((x*5)%25)|0},${50+((x*9)%20)|0})`;
                             ctx.fillRect(ox + x, oy + 16 - h, 1, h);
                           }
                           // sticks
                           ctx.fillStyle = 'rgb(90,70,40)';
                           ctx.fillRect(ox + 4, oy + 6, 1, 8); ctx.fillRect(ox + 11, oy + 5, 1, 9);
                           break;
    case 'stone_bricks':   paintNoise(ctx, ox, oy, [120, 120, 122], 0.25, 130);
                           // brick pattern: offset rows
                           ctx.fillStyle = 'rgb(85,85,87)';
                           for (let y = 0; y < TILE; y += 4) ctx.fillRect(ox, oy + y, TILE, 1);
                           for (let r = 0; r < TILE; r += 4) {
                             const off = (r % 8 === 0) ? 0 : 4;
                             for (let x = off; x < TILE; x += 8) ctx.fillRect(ox + x, oy + r, 1, 4);
                           }
                           break;
    case 'mossy_cobblestone': paintNoise(ctx, ox, oy, [110, 115, 100], 0.4, 131);
                           paintSpots(ctx, ox, oy, [80,80,75], 24, 132, 3);
                           paintSpots(ctx, ox, oy, [60,100,50], 16, 133, 2);  // moss
                           paintSpots(ctx, ox, oy, [150,150,145], 10, 134, 2);
                           break;
    case 'torch':          ctx.clearRect(ox, oy, TILE, TILE);
                           // stick
                           ctx.fillStyle = 'rgb(120, 85, 50)';
                           ctx.fillRect(ox + 7, oy + 8, 2, 8);
                           // flame
                           ctx.fillStyle = 'rgb(255, 200, 60)';
                           ctx.fillRect(ox + 6, oy + 5, 4, 3);
                           ctx.fillStyle = 'rgb(255, 150, 30)';
                           ctx.fillRect(ox + 7, oy + 4, 2, 2);
                           ctx.fillStyle = 'rgb(255, 240, 150)';
                           ctx.fillRect(ox + 7, oy + 6, 2, 1);
                           break;
    // --- Phase 16: crafting blocks ---
    case 'crafting_table_top': paintNoise(ctx, ox, oy, [150, 110, 70], 0.25, 140);
                           // saw grid: brown base + dark cross + small square marks
                           ctx.fillStyle = 'rgb(90, 65, 40)';
                           ctx.fillRect(ox + 3, oy + 3, 10, 1); ctx.fillRect(ox + 3, oy + 12, 10, 1);
                           ctx.fillRect(ox + 3, oy + 3, 1, 10); ctx.fillRect(ox + 12, oy + 3, 1, 10);
                           ctx.fillRect(ox + 7, oy + 7, 2, 2);
                           break;
    case 'crafting_table_side': paintNoise(ctx, ox, oy, [150, 110, 70], 0.25, 141);
                           // tool shadow strip + lower plank
                           ctx.fillStyle = 'rgb(100, 70, 40)'; ctx.fillRect(ox, oy + 4, TILE, 2);
                           ctx.fillStyle = 'rgb(110, 80, 50)';
                           for (let y = 8; y < TILE; y += 4) ctx.fillRect(ox, oy + y, TILE, 1);
                           break;
    case 'chest':        paintNoise(ctx, ox, oy, [150, 110, 65], 0.2, 142);
                           // lid seam + lock
                           ctx.fillStyle = 'rgb(80, 55, 30)'; ctx.fillRect(ox, oy + 5, TILE, 1);
                           ctx.fillStyle = 'rgb(230, 190, 60)'; ctx.fillRect(ox + 7, oy + 6, 2, 4);
                           break;
    // --- Phase 16: items (drawn flat; icon-only, never on a block face) ---
    case 'stick':        ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(140, 95, 55)';
                           // diagonal stick
                           for (let i = 0; i < 10; i++) {
                             ctx.fillRect(ox + 4 + i, oy + 12 - i, 2, 2);
                           }
                           ctx.fillStyle = 'rgb(100, 70, 40)';
                           for (let i = 0; i < 10; i++) ctx.fillRect(ox + 6 + i, oy + 12 - i, 1, 1);
                           break;
    case 'coal':         ctx.clearRect(ox, oy, TILE, TILE);
                           paintSpots(ctx, ox, oy, [35, 35, 38], 1, 143, 3);
                           paintSpots(ctx, ox + 2, oy + 2, [60, 60, 65], 1, 144, 2);
                           break;
    case 'charcoal':     ctx.clearRect(ox, oy, TILE, TILE);
                           paintSpots(ctx, ox, oy, [45, 40, 40], 1, 145, 3);
                           paintSpots(ctx, ox + 2, oy + 2, [70, 55, 50], 1, 146, 2);
                           break;
    case 'iron_ingot':   ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(220, 220, 225)';
                           ctx.fillRect(ox + 3, oy + 6, 10, 4);   // bar body
                           ctx.fillRect(ox + 5, oy + 5, 6, 1);    // top bevel
                           ctx.fillStyle = 'rgb(170, 170, 178)'; ctx.fillRect(ox + 3, oy + 9, 10, 1);
                           break;
    case 'copper_ingot': ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(215, 140, 80)';
                           ctx.fillRect(ox + 3, oy + 6, 10, 4);
                           ctx.fillStyle = 'rgb(235, 170, 110)'; ctx.fillRect(ox + 5, oy + 5, 6, 1);
                           ctx.fillStyle = 'rgb(170, 100, 55)'; ctx.fillRect(ox + 3, oy + 9, 10, 1);
                           break;
    case 'gold_ingot':   ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(245, 215, 80)';
                           ctx.fillRect(ox + 3, oy + 6, 10, 4);
                           ctx.fillStyle = 'rgb(255, 235, 130)'; ctx.fillRect(ox + 5, oy + 5, 6, 1);
                           ctx.fillStyle = 'rgb(200, 165, 50)'; ctx.fillRect(ox + 3, oy + 9, 10, 1);
                           break;
    case 'diamond':      ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(110, 230, 230)';
                           ctx.beginPath();
                           ctx.moveTo(ox + 8, oy + 2); ctx.lineTo(ox + 14, oy + 8);
                           ctx.lineTo(ox + 8, oy + 14); ctx.lineTo(ox + 2, oy + 8);
                           ctx.closePath(); ctx.fill();
                           ctx.fillStyle = 'rgb(180, 245, 245)';
                           ctx.beginPath();
                           ctx.moveTo(ox + 8, oy + 2); ctx.lineTo(ox + 11, oy + 5);
                           ctx.lineTo(ox + 8, oy + 8); ctx.lineTo(ox + 5, oy + 5);
                           ctx.closePath(); ctx.fill();
                           break;
    case 'emerald':      ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(40, 200, 90)';
                           ctx.fillRect(ox + 6, oy + 2, 4, 12);
                           ctx.fillRect(ox + 4, oy + 5, 8, 6);
                           ctx.fillStyle = 'rgb(110, 240, 140)';
                           ctx.fillRect(ox + 6, oy + 3, 2, 3); ctx.fillRect(ox + 5, oy + 5, 2, 1);
                           break;
    case 'lapis':        ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(30, 60, 200)';
                           ctx.fillRect(ox + 4, oy + 4, 8, 8);
                           ctx.fillStyle = 'rgb(60, 100, 230)';
                           ctx.fillRect(ox + 5, oy + 5, 6, 6);
                           ctx.fillStyle = 'rgb(20, 40, 140)';
                           ctx.fillRect(ox + 9, oy + 9, 2, 2);
                           break;
    case 'redstone_item':ctx.clearRect(ox, oy, TILE, TILE);
                           paintSpots(ctx, ox, oy, [180, 30, 30], 1, 147, 3);
                           paintSpots(ctx, ox + 2, oy + 2, [230, 60, 60], 1, 148, 2);
                           break;
    case 'flint':        ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(50, 50, 55)';
                           ctx.beginPath();
                           ctx.moveTo(ox + 8, oy + 3); ctx.lineTo(ox + 13, oy + 7);
                           ctx.lineTo(ox + 9, oy + 13); ctx.lineTo(ox + 4, oy + 9);
                           ctx.closePath(); ctx.fill();
                           ctx.fillStyle = 'rgb(90, 90, 100)';
                           ctx.fillRect(ox + 7, oy + 6, 2, 2);
                           break;
    // --- Phase 19: mob-drop items ---
    case 'wool':         ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [235, 235, 235], 0.15, 160);
                           paintSpots(ctx, ox, oy, [210, 210, 210], 8, 161, 1);
                           break;
    case 'mutton':       ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [200, 120, 130], 0.25, 162);
                           ctx.fillStyle = 'rgb(245, 240, 240)'; ctx.fillRect(ox + 2, oy + 2, 4, 12);
                           break;
    case 'leather':      ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [140, 90, 50], 0.3, 163);
                           ctx.strokeStyle = 'rgb(90, 55, 30)'; ctx.strokeRect(ox + 3.5, oy + 3.5, TILE - 7, TILE - 7);
                           break;
    case 'beef':         ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [170, 60, 60], 0.25, 164);
                           ctx.fillStyle = 'rgb(245, 230, 220)'; ctx.fillRect(ox + 2, oy + 2, 5, 5); ctx.fillRect(ox + 2, oy + 9, 5, 5);
                           break;
    case 'porkchop':     ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [230, 180, 180], 0.2, 165);
                           ctx.fillStyle = 'rgb(245, 240, 240)'; ctx.fillRect(ox + 2, oy + 4, 4, 8);
                           break;
    case 'chicken':      ctx.clearRect(ox, oy, TILE, TILE);
                           paintNoise(ctx, ox, oy, [235, 200, 180], 0.2, 166);
                           ctx.fillStyle = 'rgb(250, 240, 230)'; ctx.fillRect(ox + 3, oy + 3, 6, 10);
                           break;
    case 'feather':      ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(230, 230, 230)';
                           ctx.beginPath(); ctx.moveTo(ox + 10, oy + 2); ctx.lineTo(ox + 6, oy + 14); ctx.lineTo(ox + 8, oy + 14); ctx.lineTo(ox + 12, oy + 2); ctx.closePath(); ctx.fill();
                           ctx.fillStyle = 'rgb(200, 200, 200)'; ctx.fillRect(ox + 8, oy + 13, 2, 2);
                           break;
    case 'egg':          ctx.clearRect(ox, oy, TILE, TILE);
                           ctx.fillStyle = 'rgb(250, 245, 230)';
                           ctx.beginPath(); ctx.ellipse(ox + 8, oy + 9, 4, 5, 0, 0, Math.PI * 2); ctx.fill();
                           ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.ellipse(ox + 7, oy + 7, 1.5, 2, 0, 0, Math.PI * 2); ctx.fill();
                           break;
    // --- Phase 19: mob body textures (used by mob cube models) ---
    case 'sheep_fleece': paintNoise(ctx, ox, oy, [235, 235, 235], 0.2, 168);
                           paintSpots(ctx, ox, oy, [210, 210, 210], 10, 169, 2);
                           break;
    case 'sheep_skin':   paintNoise(ctx, ox, oy, [220, 215, 200], 0.15, 170); // head/legs
                           break;
    case 'cow_body':     paintNoise(ctx, ox, oy, [110, 80, 55], 0.25, 171); // brown cow
                           paintSpots(ctx, ox, oy, [240, 235, 225], 5, 172, 3);
                           break;
    case 'cow_head':     paintNoise(ctx, ox, oy, [220, 215, 200], 0.15, 173);
                           ctx.fillStyle = 'rgb(60, 40, 30)'; ctx.fillRect(ox + 5, oy + 6, 2, 2); ctx.fillRect(ox + 9, oy + 6, 2, 2);
                           break;
    case 'pig_skin':     paintNoise(ctx, ox, oy, [230, 160, 160], 0.2, 174);
                           break;
    case 'pig_head':     paintNoise(ctx, ox, oy, [235, 170, 170], 0.2, 175);
                           ctx.fillStyle = 'rgb(180, 110, 110)'; ctx.fillRect(ox + 7, oy + 10, 2, 2); // snout
                           break;
    case 'chicken_white':paintNoise(ctx, ox, oy, [245, 245, 245], 0.15, 176);
                           break;
    case 'chicken_red':  paintNoise(ctx, ox, oy, [200, 60, 60], 0.2, 177); // comb/wattle
                           break;
    case 'chicken_beak': ctx.fillStyle = 'rgb(230, 180, 60)'; ctx.fillRect(ox, oy, TILE, TILE); // beak
                           break;
    default:            // magenta missing-texture
                        paintNoise(ctx, ox, oy, [255, 0, 255], 0, 0);
                        ctx.fillStyle = 'rgb(0,0,0)'; ctx.fillRect(ox, oy, TILE/2, TILE/2); ctx.fillRect(ox + TILE/2, oy + TILE/2, TILE/2, TILE/2);
  }
}

// Build the atlas: collect unique tile names from the block registry, lay them
// out in a 16-wide grid, draw to a canvas, return a THREE.Texture + UV lookup.
export function buildAtlas() {
  // Collect unique tile names from BOTH blocks and items (item textures are
  // icon-only — never on a block face — but they need atlas slots so the
  // inventory/hotbar can render them as CSS sprites).
  const names = new Set();
  for (const b of BLOCK_REGISTRY) {
    if (!b) continue;
    for (const t of b.textures) names.add(t);
  }
  // Lazy import to avoid a hard dependency cycle if items.js ever imports atlas.
  for (const it of ITEM_REGISTRY.values()) {
    if (it.texture) names.add(it.texture);
  }
  const ordered = [...names].sort();
  const tileIndex = new Map();
  ordered.forEach((n, i) => tileIndex.set(n, i));

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  for (let i = 0; i < ordered.length; i++) {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    drawTile(ctx, ordered[i], col * TILE, row * TILE);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; // crisp pixels
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  // Per-tile UV rect [u0, v0, u1, v1] with a tiny inset to avoid bleeding.
  const inset = 0.5 / ATLAS_SIZE;
  const uvs = new Map();
  for (const [name, i] of tileIndex) {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    const u0 = (col * TILE) / ATLAS_SIZE + inset;
    const v1 = 1 - (row * TILE) / ATLAS_SIZE - inset;
    const u1 = ((col + 1) * TILE) / ATLAS_SIZE - inset;
    const v0 = 1 - ((row + 1) * TILE) / ATLAS_SIZE + inset;
    uvs.set(name, [u0, v0, u1, v1]);
  }

  return { texture, uvs, tileCount: ordered.length, canvas };
}
