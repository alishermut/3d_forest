# Packbrawl — Inventory-Grid Auto-Battler (research + design + feasibility)

**Working title:** Packbrawl (rename freely).
**Genre:** inventory-management auto-battler — the *Backpack Battles* (PlayWithFurcifer)
formula. You arrange items in a grid, the fight resolves itself, you spend
winnings in a shop, repeat. All the skill is in the *arranging*, not the fighting.

**Status:** RESEARCH / DESIGN ONLY. Nothing built yet. This file exists to
decide *what* and *how* before we write code. Treat it like the other
experiment PLANs in this repo (`src/highlands/PLAN.md`, root `PLAN.md`).

---

## 0. Why this doc leads with a hard question

Every other experiment in this repo is a **3D graphics** experiment (forest,
water, highlands, fluid). Backpack Battles is, mechanically, a **2D UI game**:
a grid, drag-and-drop, a shop panel, and a combat log. There is no camera, no
terrain, no shader work in the core loop.

So the first real decision is *how much 3D belongs here at all.* Picking wrong
means either (a) fighting Three.js to build a 2D drag-grid it's bad at, or
(b) building a flat HTML game that doesn't belong in a 3D-graphics sandbox.
Three honest options — see **§5 Technical approach**. My recommendation is the
hybrid (Option B): 2D DOM/Canvas for the grid+shop, optional 3D "diorama" for
the battle. But that's a call for you to make at the first checkpoint.

---

## 1. The reference game in one paragraph

You play an adventurer with a **backpack grid**. Between fights you visit a
**shop**, spend **gold** on items (weapons, armor, potions, food, gems,
companions), and drag/rotate them into your grid. Item **placement and
adjacency** matter: many items buff neighbors or trigger off them. When you're
ready, you fight an opponent's saved build; **combat is fully automatic** —
items fire on individual **cooldowns**, deal damage / apply status effects /
heal, and one fighter hits 0 HP. You keep going until you **win 10 rounds
(victory)** or **lose 5 (run over)**. Then a new run. ~400+ items; depth comes
from synergy discovery and grid-space economy ("does this 4-tile sword earn
its footprint?").

Sources at the bottom.

---

## 2. Mechanics breakdown (the spec to build against)

Numbers below are from the official wikis; treat them as a **starting balance
table**, not gospel — we'll tune our own.

### 2.1 Run structure / win-loss
- Start: **25 HP**, **12 gold**, a small starting grid.
- Loop: `Shop phase` → `Battle phase` → repeat.
- **Win condition:** 10 round wins. **Loss condition:** 5 losses. (Wins and
  losses both accumulate; it's a race between the two counters.)
- No timers anywhere in the shop phase — the whole genre is "take your time,
  think." Important: this means **zero real-time pressure in our UI**.

### 2.2 Economy
- Each shop phase grants **gold** (≈9–15, scales with round number).
- **Leftover gold carries over** between rounds (enables saving).
- **Piggybank** items increase gold income (the "interest"/scaling lever).
- **Reroll** the shop: **1 gold** for the first ~4 rerolls, **2 gold**
  thereafter (within a phase).
- Shop shows **5 items** at a time. **~10% chance an item is on sale at 50% off.**
- Items can be **sold back** for partial value (frees grid space + gold).

### 2.3 The grid (the heart of it)
- A bounded set of tiles (reference: classes start with ~12–14 usable tiles of
  a 63-tile frame). **Bag/expansion items unlock more tiles.**
- Items are **polyominoes** (1×1, 1×2, 2×2, L-shapes, etc.) and can be
  **rotated** (90° steps).
- Placement rules: no overlap, must sit on unlocked tiles.
- **Adjacency is a mechanic**, not decoration:
  - Items have socket-like markers (the reference calls them **Star** and
    **Diamond** slots) that get "filled" by specific neighboring items, which
    activates a bonus. Our generic version: each item can declare
    `adjacencyBuffs` keyed by neighbor type/tag.
  - Some items only work *next to* a specific other (e.g. whetstone next to a
    blade → +crit), so **where** you place a thing changes its output.

### 2.4 Combat resolution (fully automatic; deterministic given seed)
This is a **discrete-event simulation**, not a physics fight. Build it as a
pure function: `simulate(buildA, buildB, seed) → { winner, timeline[] }`.

- Each combat item has a **cooldown** (seconds). When it elapses, the item
  **triggers** its effect (attack, heal, apply status, buff).
- Core stats / effects observed in the reference:
  - **Damage** (with a damage type), **Accuracy** (hit/miss roll),
    **Crit** (×2 damage), **Block** (absorbs 1 damage per stack),
    **Health**, **Healing/Regeneration** (1 HP per stack per 2s),
    **Poison** (1 dmg per stack per 2s), plus burn/freeze/stun-style effects.
  - **Stamina** gates some items (a resource a subset of items consume/produce).
- A fight is: advance a clock, fire items as their cooldowns come due, apply
  effects to the opposing fighter, resolve status ticks, check for death.
- **Determinism matters**: same builds + same seed = same result. This lets us
  replay a battle as an animation *after* simulating it, and makes balancing
  testable. (Reference game fights *saved* enemy builds — async PvP. We start
  vs. AI/canned builds; async-PvP is a stretch goal, see §6.)

### 2.5 Items & crafting
- Items have **rarity** (common → legendary-ish) gating shop appearance.
- **Crafting/recipes:** specific items combine into a stronger item (e.g.
  two components auto-merge or merge on a recipe). This is a major synergy and
  progression lever; model recipes as data (`[ingredientIds] → resultId`).
- **~400 items** in the real game. We do **not** need 400. A vertical slice
  needs ~15–25 well-chosen items that demonstrate every *category* of effect
  (raw damage, scaling, status, healing, space-economy, adjacency, crafting).

### 2.6 Heroes/classes
- Multiple classes (Ranger, Reaper, Berserker, Pyromancer, etc.) differ by
  **starting grid shape**, starting item, and which synergies they lean into.
- Vertical slice: **1 class**. Add classes only once the core loop is fun.

---

## 3. Our core loop (concrete state machine)

```
            ┌─────────────┐   start run / next round   ┌──────────────┐
   START ──▶│  SHOP PHASE │ ─────────────────────────▶ │ BATTLE PHASE │
            │ buy/sell/   │                            │ run sim, then│
            │ arrange/    │ ◀───────────────────────── │ play it back │
            │ reroll      │   win→+1 win, lose→+1 loss  │ as animation │
            └─────────────┘                            └──────────────┘
                  │                                          │
                  └──── 10 wins → VICTORY · 5 losses → DEFEAT ┘
```

Single source of truth = a `RunState` object: `{ hp, gold, wins, losses,
round, grid, inventory, shopOffer, rngSeed }`. Everything (UI, sim, save) reads
from it. This mirrors the repo's existing "single source of truth" discipline
(`getHeight`, biome masks).

---

## 4. Data model (sketch — this is the real design work)

```js
// An item TYPE (static data, ~20 of these for the slice)
Item = {
  id, name, rarity, price,
  shape: [[1,1],[0,1]],         // polyomino footprint (rotatable)
  tags: ['weapon','blade'],     // for adjacency/synergy matching
  combat: {                     // optional — not every item fights
    cooldown: 2.0,              // seconds between triggers
    onTrigger: [{ type:'damage', amount:8, dmgType:'physical' }],
    // or heal / applyStatus:{poison:3} / buffSelf / consumeStamina ...
  },
  adjacency: [                  // optional — placement-dependent bonuses
    { whenNextTo:'blade', grant:{ crit:0.15 } },
  ],
  recipe: ['ironOre','stick'],  // optional — crafts FROM these
}

// An item INSTANCE on the grid
Placed = { itemId, x, y, rotation, runtimeStacks:{...} }
```

The combat sim consumes a flattened list of `Placed` items + the resolved
adjacency bonuses, and never touches the DOM. **Sim is pure and headless** —
we can unit-test it and even run thousands of fights for balancing offline.

---

## 5. Technical approach — the real decision (pick at Checkpoint 0)

| Option | Grid/Shop UI | Battle | Pros | Cons |
|---|---|---|---|---|
| **A. Pure 2D** | HTML/CSS DOM drag-drop (or 2D canvas) | 2D sprites / number popups | Fastest to fun; correct tool for a grid game; trivial drag-drop | Doesn't exercise the 3D sandbox at all — barely "belongs" in this repo |
| **B. Hybrid (recommended)** | 2D DOM/Canvas grid + shop | **3D diorama**: two little characters on a Three.js stage act out the simulated timeline (swings, hit flashes, floating damage, status VFX) | Keeps the repo's 3D identity where it pays off (the *spectacle*), uses the right tool for the *interaction*; sim/animation split is clean | Two render layers to coordinate; more glue |
| **C. Full 3D** | Grid as 3D tiles, raycast drag in 3D | Full 3D battle | Most "3D experiment" | Drag-dropping polyominoes via raycasting is fiddly and worse UX than DOM; high effort, low gameplay payoff |

**Recommendation: B.** The grid is a UI problem — let DOM do what it's great at.
Spend the 3D budget on the part that benefits from it: a satisfying little
**battle diorama** that plays back the deterministic combat timeline. This also
reuses this repo's strengths (lighting, postprocessing, model loading — there's
already a `public/models/` pipeline with Draco set up).

**Stack:** vanilla JS + Vite, matching every other experiment. Three.js only
for the battle stage. New root entry `packbrawl.html` + `src/packbrawl/main.js`
(exactly the `highlands.html` → `src/highlands/main.js` convention). Vite serves
any root `.html` in dev with no config change; for a production build we'd add
it to `rollupOptions.input` later.

**Suggested module layout:**
```
packbrawl.html                 # entry (HUD: hp/gold/wins/losses, shop, grid)
src/packbrawl/
  main.js                      # boots, owns RunState + phase state machine
  data/items.js                # the ~20 item definitions (the slice's content)
  data/recipes.js              # crafting table
  sim/combat.js                # PURE headless simulator → timeline[]   ← test this
  sim/rng.js                   # seeded RNG (determinism)
  ui/grid.js                   # DOM drag-drop grid + placement rules + adjacency calc
  ui/shop.js                   # offer, buy/sell/reroll, sale rolls
  ui/hud.js                    # counters + phase transitions
  battle/stage.js              # Three.js diorama: plays timeline[] back as animation
  PLAN.md                      # this file
```

---

## 6. Suggested phased build (matches repo's checkpoint discipline)

Each phase ends with a browser-verified CHECKPOINT; don't start the next until
the current one is approved. This sequence front-loads *fun* (loop first,
content/spectacle later) so we learn early whether the game's enjoyable.

- **Phase 0 — Decision + scaffold.** Pick Option A/B/C. Stand up
  `packbrawl.html` + empty `main.js`, RunState shell, phase state machine
  cycling Shop↔Battle with placeholder buttons. *CP: the loop advances and
  win/loss counters work end a run.*
- **Phase 1 — The grid.** DOM drag-drop, polyomino placement, rotation,
  overlap rejection, sell. *CP: you can drag/rotate/remove items; illegal
  placements rejected.*
- **Phase 2 — Shop + economy.** 5-item offer, buy/sell, gold income per round,
  reroll cost ramp, sale rolls, leftover carryover. *CP: a full shop phase
  feels like the real economy; gold math checks out.*
- **Phase 3 — Headless combat sim.** Pure `simulate()`: cooldowns, damage,
  block, one status (poison), death check, deterministic by seed. Just print
  the timeline as text. *CP: same seed → same result; a hand-built strong
  build beats a weak one reliably.* **This is the make-or-break phase.**
- **Phase 4 — Adjacency + a few synergies.** Wire `adjacency` bonuses into the
  pre-sim resolve; add 3–4 items whose value is positional. *CP: moving an
  item one tile measurably changes the fight.*
- **Phase 5 — Battle playback.** Option B: the 3D diorama animates the
  Phase-3 timeline (or 2D popups for Option A). *CP: the fight is readable and
  satisfying to watch.*
- **Phase 6 — Content + crafting + 1 class.** Flesh out to ~20 items, add the
  recipe table, one real starting class. *CP: a full ~10-round run is winnable
  and losable, and you discover at least one combo.*
- **Stretch:** more classes; AI opponent that builds (vs. canned builds);
  **async "ghost" PvP** (save your build to localStorage / a tiny backend and
  fight other saved builds); item-art pass; meta-progression/unlocks.

---

## 7. Risks / things that will bite us
- **Combat balance is the whole game.** A pure, testable sim (Phase 3) is the
  hedge — we can run thousands of auto-fights to find degenerate builds.
- **Drag-drop polyominoes** are easy in DOM, painful in 3D — this is the main
  reason to *not* pick Option C.
- **Scope creep via items.** 400 items is content, not design. Resist; ~20
  good ones prove the design.
- **Determinism leaks.** Any `Math.random()` in the sim breaks replay — route
  *all* randomness through the seeded RNG (the repo already learned this lesson
  re: workflow determinism; same principle).
- **It barely uses the 3D engine.** Accept this. The value here is a *different
  genre* of experiment for the collection; the 3D is seasoning (Option B), not
  the substance.

---

## 8. Open questions for you (before Phase 0)
1. **Option A / B / C** for rendering? (I recommend **B**.)
2. **Theme/skin** — fantasy adventurer (like the original), or reskin to fit
   this repo's world (forest creatures? alchemy?)? Affects item art only.
3. **vs. AI or vs. canned builds** for the first playable? (Canned is far less
   work and fine for a slice.)
4. **How far do you want to go** — just prove the loop is fun (Phases 0–4), or
   push to a full winnable run (through Phase 6)?

---

## Sources
- [Backpack Battles — Wikipedia](https://en.wikipedia.org/wiki/Backpack_Battles)
- [Game Mechanics — Backpack Battles Wiki (wiki.gg)](https://backpackbattles.wiki.gg/wiki/Game_Mechanics)
- [Game Mechanics — Backpack Battles Wiki (Fandom)](https://backpack-battles.fandom.com/wiki/Game_Mechanics)
- [Item Synergies and Scaling — Casual Game Guides](https://casualgameguides.com/walkthroughs/backpack-battles/item-synergies-and-scaling)
- [Beginner Tips — TheGamer](https://www.thegamer.com/backpack-battles-beginner-tips-tricks/)
- [Backpack Battles on Steam](https://store.steampowered.com/app/2427700/Backpack_Battles/)
- [Inventory-management auto-battler 1.0 — GamingOnLinux](https://www.gamingonlinux.com/2025/06/challenging-inventory-management-auto-battler-backpack-battles-1-0-is-out-now/)
