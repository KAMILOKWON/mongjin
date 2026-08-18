import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'mongjin',
  brand: {
    displayName: '몽진',
    primaryColor: '#e0b35c',
    icon: '', // TODO: 앱인토스 콘솔에 업로드한 아이콘 이미지 URL
  },
  web: {
    host: 'localhost',
    port: 5174,
    commands: {
      // ait는 dist/ 산출물을 dist/web/으로 옮기므로 Sites용 dist/client 와 분리
      dev: 'vite dev',
      build: 'vite build --outDir dist',
    },
  },
  permissions: [],
  outdir: 'dist',
});
