import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresCommunityStore } from './communityStore';

// 명시적으로 지정한 격리 루프백 DB에서만 실행한다. 기본 포트(5432, 로컬 상시 서비스)는 쓰지 않는다.
const connection = process.env.MONGJIN_TEST_DATABASE_URL;
const isolated = (() => {
  if (!connection) return false;
  const url = new URL(connection);
  return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port !== '' && url.port !== '5432';
})();
const prefix = 'pgtest-' + randomUUID() + ':';
const ns = (name: string) => prefix + name;

afterAll(async () => {
  if (!isolated) return;
  const pool = new Pool({ connectionString: connection });
  await pool.query('DELETE FROM mongjin_community_records WHERE left(namespace, length($1)) = $1', [prefix]);
  await pool.end();
});

describe.skipIf(!isolated)('PostgresCommunityStore', () => {
  it('initializes twice, upserts, deletes, isolates namespaces and survives close/reopen', async () => {
    const store = new PostgresCommunityStore(connection!);
    await store.initialize();
    await store.initialize();
    await store.commit([
      { namespace: ns('a'), key: 'k1', value: { v: 1 } },
      { namespace: ns('a'), key: 'k2', value: { v: 2 } },
      { namespace: ns('b'), key: 'k1', value: 'other' },
    ]);
    await store.commit([
      { namespace: ns('a'), key: 'k1', value: { v: 10, nested: [1, 'x'] } },
      { namespace: ns('a'), key: 'k2', value: null },
      { namespace: ns('a'), key: 'never-existed', value: null },
    ]);
    await store.close();

    const reopened = new PostgresCommunityStore(connection!);
    await reopened.initialize();
    expect(await reopened.get(ns('a'), 'k1')).toEqual({ v: 10, nested: [1, 'x'] });
    expect(await reopened.get(ns('a'), 'k2')).toBeNull();
    expect(await reopened.list(ns('a'))).toEqual([{ v: 10, nested: [1, 'x'] }]);
    expect(await reopened.get(ns('b'), 'k1')).toBe('other');
    expect(await reopened.list(ns('missing'))).toEqual([]);
    await reopened.close();
  });

  it('rolls back every change in a commit when one statement fails, and stays usable', async () => {
    const store = new PostgresCommunityStore(connection!);
    await store.initialize();
    await store.commit([
      { namespace: ns('tx'), key: 'keep', value: { v: 1 } },
      { namespace: ns('tx'), key: 'remove', value: { v: 2 } },
    ]);
    // 마지막 변경은 record NOT NULL 제약을 어겨 트랜잭션 전체가 실패해야 한다.
    await expect(store.commit([
      { namespace: ns('tx'), key: 'keep', value: { v: 99 } },
      { namespace: ns('tx'), key: 'remove', value: null },
      { namespace: ns('tx'), key: 'added', value: { v: 3 } },
      { namespace: ns('tx'), key: 'bad', value: undefined },
    ])).rejects.toThrow();
    expect(await store.get(ns('tx'), 'keep')).toEqual({ v: 1 });
    expect(await store.get(ns('tx'), 'remove')).toEqual({ v: 2 });
    expect(await store.get(ns('tx'), 'added')).toBeNull();
    expect(await store.get(ns('tx'), 'bad')).toBeNull();
    // 실패 후 연결이 풀에 정상 반환되어 다음 커밋이 된다.
    await store.commit([{ namespace: ns('tx'), key: 'after', value: true }]);
    expect(await store.list(ns('tx'))).toHaveLength(3);
    await store.close();
  });
});
