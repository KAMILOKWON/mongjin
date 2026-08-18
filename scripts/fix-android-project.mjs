import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bridge = path.join(root, 'android');
const project = path.join(root, 'apps/android');
const bridgeStat = await lstat(bridge);

if (!bridgeStat.isSymbolicLink()) {
  throw new Error('android 경로는 apps/android를 가리키는 심볼릭 링크여야 합니다.');
}

const settingsPath = path.join(project, 'capacitor.settings.gradle');
const source = await readFile(settingsPath, 'utf8');
const fixed = source.replace(
  "new File('../node_modules/@capacitor/android/capacitor')",
  "new File('../../node_modules/@capacitor/android/capacitor')",
);

if (!fixed.includes("new File('../../node_modules/@capacitor/android/capacitor')")) {
  throw new Error('Capacitor Android 의존성 경로를 확인하지 못했습니다.');
}

if (fixed !== source) await writeFile(settingsPath, fixed);
