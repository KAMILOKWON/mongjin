/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // GitHub Pages 하위 경로에서도 동작하도록 상대 경로 사용
  test: {
    // 외장 볼륨에서 macOS가 만드는 AppleDouble 파일(._*) 제외
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
  },
});
