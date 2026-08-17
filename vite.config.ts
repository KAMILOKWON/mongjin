/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // GitHub Pages 하위 경로에서도 동작하도록 상대 경로 사용
  resolve: {
    // 앱인토스 SDK(~수백 MB) 없이 로컬/웹 빌드. 토스 배포 시 이 alias 블록을 제거하고 SDK 설치.
    alias: {
      '@apps-in-toss/web-framework': path.resolve(__dirname, 'src/stubs/apps-in-toss.ts'),
    },
  },
  test: {
    // 외장 볼륨에서 macOS가 만드는 AppleDouble 파일(._*) 제외
    exclude: ['**/node_modules/**', '**/dist/**', '**/sites/**', '**/._*'],
  },
});
