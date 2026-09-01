import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateLegacyProfileClaim } from './legacyProfileMigration';

const duringMigration = new Date('2026-09-15T00:00:00.000Z');

test('기존 기기 Elo와 전적을 승계 값으로 검증한다', () => {
  assert.deepEqual(
    validateLegacyProfileClaim(
      { name: '따뜻보스', wins: 42, losses: 18, rating: 1799 },
      duringMigration,
    ),
    { name: '따뜻보스', wins: 42, losses: 18, rating: 1799 },
  );
});

test('전적으로 도달할 수 없는 Elo와 마감 이후 요청은 거부한다', () => {
  assert.throws(
    () => validateLegacyProfileClaim({ name: '조작점수', wins: 1, losses: 0, rating: 1799 }, duringMigration),
    /전적 범위/,
  );
  assert.throws(
    () => validateLegacyProfileClaim(
      { name: '따뜻보스', wins: 42, losses: 18, rating: 1799 },
      new Date('2026-12-02T00:00:00.000Z'),
    ),
    /기간이 종료/,
  );
});
