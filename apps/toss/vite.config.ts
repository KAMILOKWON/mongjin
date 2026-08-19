import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  // 앱인토스 패키지도 저장소 루트의 공통 배포 환경값을 사용한다.
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src'),
    },
  },
  build: { outDir: 'dist/client' },
  server: { port: 5174 },
});
