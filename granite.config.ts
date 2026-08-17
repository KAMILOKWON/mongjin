import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'mongjin',
  brand: {
    displayName: '몽진',
    primaryColor: '#e0b35c',
    bridgeColorMode: 'basic',
    icon: '',
  },
  web: {
    host: 'localhost',
    port: 5173,
    commands: {
      dev: 'vite --host --config vite.config.ait.ts',
      build: 'tsc --noEmit -p tsconfig.ait.json && vite build --config vite.config.ait.ts',
    },
  },
  permissions: [],
  outdir: 'dist',
});
