import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildLeaderboard } from './leaderboard';
import type { StoredProfile } from './profileRepository';

function profile(playerId: string, rating: number): StoredProfile {
  return {
    playerId,
    token: `token-${playerId}`,
    name: playerId,
    wins: 0,
    losses: 0,
    rating,
    createdAt: `2026-09-01T00:00:0${playerId.length}.000Z`,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('Elo 동점자는 공동 순위이고 다음 순위는 건너뛴다', () => {
  const entries = buildLeaderboard(
    [profile('a', 1300), profile('b', 1200), profile('c', 1200), profile('d', 1100)],
    10,
    0,
  );
  assert.deepEqual(entries.map(({ rank, rating }) => ({ rank, rating })), [
    { rank: 1, rating: 1300 },
    { rank: 2, rating: 1200 },
    { rank: 2, rating: 1200 },
    { rank: 4, rating: 1100 },
  ]);
});

test('페이지 범위를 적용해도 전체 기준 순위를 유지한다', () => {
  const entries = buildLeaderboard(
    [profile('a', 1300), profile('b', 1200), profile('c', 1100)],
    1,
    1,
  );
  assert.deepEqual(entries.map(({ rank, rating }) => ({ rank, rating })), [{ rank: 2, rating: 1200 }]);
});

test('초대 대상 식별자는 제공하고 인증 정보와 표시 설정은 공개하지 않는다', () => {
  const privateProfile = { ...profile('a', 1200), showOnline: false, tossAccessToken: 'test-private' };
  const [entry] = buildLeaderboard([privateProfile], 10, 0);
  assert.equal(entry!.playerId, 'a');
  assert.equal('token' in entry!, false);
  assert.equal('tossAccessToken' in entry!, false);
  assert.equal('showOnline' in entry!, false);
});

test('접속자 필터는 전체 순위를 유지하고 필터 뒤에 페이지 범위를 적용한다', () => {
  const profiles = [profile('offline', 1500), profile('idle', 1400), profile('hidden', 1300), profile('playing', 1200)];
  const include = (item: StoredProfile) => item.playerId === 'idle' || item.playerId === 'playing';
  assert.deepEqual(buildLeaderboard(profiles, 1, 0, include).map(item => ({ id: item.playerId, rank: item.rank })), [{ id: 'idle', rank: 2 }]);
  assert.deepEqual(buildLeaderboard(profiles, 1, 1, include).map(item => ({ id: item.playerId, rank: item.rank })), [{ id: 'playing', rank: 4 }]);
});
