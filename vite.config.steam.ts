import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@apps-in-toss/web-framework': path.resolve(__dirname, 'src/stubs/apps-in-toss.ts')
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'apps/steam/game'),
    emptyOutDir: true
  }
});
