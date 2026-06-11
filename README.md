# Deep Forest

A walkable, foggy, first-person forest scene in the browser. Built with
[Three.js](https://threejs.org) + [Vite](https://vitejs.dev).

![Stack](https://img.shields.io/badge/three.js-r184-blue) ![Vite](https://img.shields.io/badge/vite-8-purple)

## Run

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # static production build in dist/
```

## Controls

| Input | Action |
|-------|--------|
| Click | Enter (locks the mouse) |
| Mouse | Look around |
| `W A S D` | Walk |
| `Shift` | Sprint |
| `Space` | Jump (surface while swimming / ascend in fly mode) |
| `C` | Dive while swimming / descend in fly mode |
| `F` | Toggle fly mode (sandbox spectator, no collision) |
| `Esc` | Release the mouse |
| `F3` | Stats HUD (fps / draw calls / triangles) |
| `F4` / `F5` / `F6` / `F7` | Toggle AO / bloom / god rays / fog |
| `1` / `2` / `3` / `4` (or wheel) | Knife / pistol / rifle / fishing rod |
| `LMB` | Fire — or with the rod: hold to charge a cast, release to throw |
| `R` | Reload |
| `N` / `[` `]` | Day-night cycle / scrub time |

## Fishing

Equip the rod (`4`), hold LMB to charge and release to cast toward the lake.
Watch the bobber: small dips are nibbles — wait for the deep plunge, then
click within the bite window to hook. Fight the fish with the tension bar:
hold LMB to reel (tension climbs), release to let it run (tension falls).
Max tension snaps the line; too much slack and it slips the hook. Land it
to add to your tally.

## What's inside

- **Terrain** — 400×400 m of layered simplex-noise hills with a CC0
  forest-floor texture (Poly Haven). One `getHeight(x, z)` function is the
  single source of truth: the player, trees, grass, and flowers all sample it.
- **Forest** — 750 trees (oak, aspen, pine; two seed variants each) generated
  at runtime by [ez-tree](https://github.com/dgreenheck/ez-tree) and rendered
  as InstancedMesh — the whole forest is ~12 draw calls. Trunk collision,
  fallen logs, leaves swaying in the wind.
- **Atmosphere** — dense `FogExp2`, custom gradient sky dome, warm low sun
  with a 4096 px shadow map that follows the player (texel-snapped), god-ray
  shaft planes, sun glow billboard, ACES tone mapping.
- **Grass** — 260k instanced blades in one draw call, root→tip color
  gradient, gust-like wind in the vertex shader, patchy distribution that
  follows the same noise as the ground texture, in a 70 m field that
  silently relocates blades around the player as you walk.
- **Water** — lake + flowing river with per-pixel shorelines (baked terrain
  height texture), waves the physics rides (buoyant crate, swimming), foam,
  underwater murk.
- **Mountains** — climbable ridges east, rock-textured cliffs, ~220
  collidable boulders on slopes and shoreline.
- **Details** — white/yellow flower clumps and rocks (models from the
  ez-tree demo), reed bands at the lake shore, drifting dust motes, subtle
  head-bob, looping forest ambience.
- **Wildlife** — deer and a stag (animated GLB clips: graze, walk, gallop
  flee), hopping rabbits, hedgehogs, ~10 fish swimming in the lake, plus
  birds, butterflies, flies, and fireflies after dusk. Animals wander a
  biome-aware state machine and freeze beyond the fog for free.
- **Weapons & fishing** — knife, pistol, M16 (GLB viewmodels with
  procedural arms, swept-raycast ballistics, surface-aware impacts) and a
  full fishing loop: charged cast, wave-riding bobber, nibble fakeouts,
  bite window, tension tug-of-war, catch presentation with species/size
  rolls.

## Asset credits

- Animal, fish, weapon, and fishing-rod models by
  [Quaternius](https://quaternius.com) — CC0.
- *Cottontail rabbit* and *Jackrabbit* models by **Poly by Google** —
  [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- Gunshot samples from michorvath's CC0 pack on freesound.org.
- Trees/flowers/ambience from [ez-tree](https://github.com/dgreenheck/ez-tree)
  (MIT); ground/rock textures from Poly Haven (CC0).

Full per-file list in `public/models/LICENSES.md`.

## Performance notes

- Everything heavy is instanced; the whole scene is ~20 draw calls and
  ~10.5 M triangles.
- Leaves deliberately do not cast shadows: at this tree density the leaf
  cards are opaque to the shadow map and blanket the ground. The dense
  branch networks alone produce the dappled light.
- If Chrome feels slow on a dual-GPU laptop, force it onto the discrete GPU:
  Windows Settings → Display → Graphics → add Chrome → High performance.
