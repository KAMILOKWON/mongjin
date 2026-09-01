import { Migration } from '@apps-in-toss/web-framework';

const MIGRATION_MARKER_KEY = 'mongjin.ait.sdk3-origin-migrated.v1';
const LEGACY_STORAGE_KEYS = [
  'mongjin.toss.catalog.v1',
  'mongjin.ait.last-quick-name.v1',
  'mongjin.online.identity.v1',
] as const;

/**
 * SDK 3.x의 Origin 변경 전에 저장된 전적·고스트·로그인 세션을 한 번만 복원한다.
 * 새 Origin에 값이 이미 있으면 절대 덮어쓰지 않는다.
 */
export async function migrateSdk3Storage(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_MARKER_KEY) === 'done') return;

    const { previous, current } = await Migration.getOriginStorage();
    if (previous.errors.length > 0 || current.errors.length > 0) {
      console.warn('[mongjin:migration] Origin 저장소 일부를 읽지 못했습니다.', {
        previous: previous.errors,
        current: current.errors,
      });
      return;
    }

    for (const key of LEGACY_STORAGE_KEYS) {
      const currentValue = current.localStorage[key] ?? localStorage.getItem(key);
      const previousValue = previous.localStorage[key];
      if (currentValue == null && previousValue != null) {
        localStorage.setItem(key, previousValue);
      }
    }

    localStorage.setItem(MIGRATION_MARKER_KEY, 'done');
  } catch (error) {
    // 일반 브라우저나 지원하지 않는 토스 앱에서는 기존 현재-Origin 데이터로 계속 실행한다.
    console.warn('[mongjin:migration] SDK 3.x Origin 저장소 이전을 건너뜁니다.', error);
  }
}
