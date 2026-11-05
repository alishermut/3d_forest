// Voxelcraft — Phase 6: biome map.
//
// Determines which biome each (x, z) column belongs to, using two noise
// channels: temperature and humidity. We also compute a "continentalness"
// channel that drives ocean vs land. The biome then drives terrain height
// and surface blocks in generator.js.
//
// v1 biomes (11):
//   Ocean, Beach, Plains, Forest, Desert, Mountains, Snowy, Taiga, Jungle,
//   Savanna, Swamp
//
// Biome selection is intentionally simple (threshold table) so it's easy to
// tune. Phase 7+ can add the full MC noise-parameter set.

import { Noise2D } from '../engine/noise.js';

export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  MOUNTAINS: 5,
  SNOWY: 6,
  TAIGA: 7,
  JUNGLE: 8,
  SAVANNA: 9,
  SWAMP: 10,
};

export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Mountains',
  'Snowy', 'Taiga', 'Jungle', 'Savanna', 'Swamp',
];

export class BiomeMap {
  constructor(seed = 1337) {
    // Three independent noise channels.
    this.tempNoise = new Noise2D(seed + 1);
    this.humidNoise = new Noise2D(seed + 2);
    this.continentalNoise = new Noise2D(seed + 3);
    this.mountainNoise = new Noise2D(seed + 4);
  }

  // Returns a biome id for (x, z). Deterministic per seed.
  getBiome(x, z) {
    const cont = this.continentalNoise.fractal(x, z, 4, 0.5, 2, 0.0025); // 0..1, low-freq
    const temp = this.tempNoise.fractal(x, z, 3, 0.5, 2, 0.004);
    const humid = this.humidNoise.fractal(x, z, 3, 0.5, 2, 0.004);
    const mount = this.mountainNoise.fractal(x, z, 4, 0.5, 2, 0.0018); // very low-freq

    // Continentality: < 0.30 = ocean, < 0.36 = beach.
    if (cont < 0.30) return BIOME.OCEAN;
    if (cont < 0.36) return BIOME.BEACH;

    // Land. Mountains are a separate mask.
    if (mount > 0.58) return BIOME.MOUNTAINS;

    // Temperature × humidity grid for the remaining biomes.
    if (temp < 0.35) {
      if (humid < 0.4) return BIOME.SNOWY;
      return BIOME.TAIGA;
    }
    if (temp > 0.65) {
      if (humid < 0.3) return BIOME.DESERT;
      if (humid > 0.65) return BIOME.JUNGLE;
      return BIOME.SAVANNA;
    }
    // Temperate
    if (humid < 0.3) return BIOME.PLAINS;
    if (humid > 0.65) {
      return cont < 0.45 ? BIOME.SWAMP : BIOME.FOREST;
    }
    return BIOME.FOREST;
  }

  // Terrain height (base, before biome modulation). Returns a target surface
  // Y in world space. Driven by continentality + a fractal hill noise.
  getBaseHeight(x, z) {
    const cont = this.continentalNoise.fractal(x, z, 4, 0.5, 2, 0.0025);
    const hills = this.continentalNoise.fractal(x + 1000, z + 1000, 5, 0.5, 2, 0.012);
    const mount = this.mountainNoise.fractal(x, z, 4, 0.5, 2, 0.0018);

    let h;
    if (cont < 0.30) {
      // Deep ocean: floor around Y=40
      h = 38 + hills * 8;
    } else if (cont < 0.36) {
      // Beach: near sea level
      h = 58 + hills * 6;
    } else {
      // Land: 66 + hills, mountains add a lot
      h = 66 + hills * 24;
      if (mount > 0.58) {
        h += (mount - 0.58) * 280; // up to ~+117 at mount=1.0 → peaks ~150+
      }
    }
    return Math.floor(h);
  }
}
