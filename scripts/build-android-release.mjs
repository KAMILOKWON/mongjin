import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'ANDROID_KEYSTORE_PATH',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  throw new Error(`Android 서명 환경 변수가 없습니다: ${missing.join(', ')}`);
}

await access(process.env.ANDROID_KEYSTORE_PATH);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'build']);
run('npm', ['run', 'sync:android']);
run('./android/gradlew', ['-p', 'android', 'bundleRelease']);
