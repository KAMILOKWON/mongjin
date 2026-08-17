#!/usr/bin/env node
/**
 * AIT/TDS 패키지는 용량이 큽니다. `npm run ait:install`로만 설치하세요.
 * 일반 웹 개발(`npm run dev`)에는 필요 없습니다.
 */
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const marker = 'node_modules/@apps-in-toss/web-framework/package.json';
if (existsSync(marker)) {
  console.log('AIT 패키지가 이미 설치되어 있습니다.');
  process.exit(0);
}

console.log('앱인토스 SDK + TDS 패키지 설치 중…');
execSync(
  'npm install -D @apps-in-toss/web-framework@^2.4.1 @toss/tds-mobile@^2.4.1 @toss/tds-mobile-ait@^2.4.1 @emotion/react@^11 react@^18 react-dom@^18 @vitejs/plugin-react@^4 @types/react@^18 @types/react-dom@^18',
  { stdio: 'inherit' },
);
