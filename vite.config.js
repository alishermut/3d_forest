import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// One Vite project, many games. Each game lives in games/<name>/ with its own
// index.html; the root index.html is a launcher. Every HTML page must be
// listed here or `npm run build` will skip it.
const page = (p) => resolve(import.meta.dirname, p);

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    rollupOptions: {
      input: {
        launcher: page('index.html'),
        'deep-forest': page('games/deep-forest/index.html'),
        voxelcraft: page('games/voxelcraft/index.html'),
        highlands: page('games/highlands/index.html'),
        tetris: page('games/tetris/index.html'),
        'water-fluid': page('games/water-lab/fluid.html'),
        'water-ocean': page('games/water-lab/ocean.html'),
        'water-pool': page('games/water-lab/pool.html'),
        'water-simple': page('games/water-lab/simplewater.html'),
        'water-lab': page('games/water-lab/waterlab.html'),
      },
    },
  },
});
