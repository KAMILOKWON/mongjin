import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.studiozzzg.mongjin',
  appName: '몽진',
  webDir: 'dist',
  backgroundColor: '#f1eee8',
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
