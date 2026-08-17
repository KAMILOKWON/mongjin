import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** 앱인토스(TDS) 전용 — 산출물: dist/web/index.html + dist/web/assets/ */
export default defineConfig({
  base: './',
  root: path.resolve(__dirname, 'web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@src': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
