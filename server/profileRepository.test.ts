import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { FileProfileRepository, applyEloResult, type StoredProfile } from './profileRepository';

function profile(playerId: string, rating = 1200): StoredProfile {
  return {
    playerId,
    token: `token-${playerId}`,
    name: `player-${playerId}`,
    wins: 0,
    losses: 0,
    rating,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('Elo 결과는 기존 K=24 계산을 유지한다', () => {
  const result = applyEloResult(profile('winner'), profile('loser'), '2026-09-01T01:00:00.000Z');
  assert.equal(result.winner.rating, 1212);
  assert.equal(result.loser.rating, 1188);
  assert.equal(result.winner.wins, 1);
  assert.equal(result.loser.losses, 1);
});

test('같은 matchId는 한 번만 반영한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-profile-store-'));
  const repository = new FileProfileRepository(join(directory, 'profiles.json'));
  await repository.importProfiles([profile('winner'), profile('loser')]);
  const match = {
    matchId: 'match-1',
    roomId: 'ROOM01',
    winnerId: 'winner',
    loserId: 'loser',
    reason: 'goal',
    completedAt: '2026-09-01T01:00:00.000Z',
  };

  assert.equal((await repository.recordMatch(match)).recorded, true);
  assert.equal((await repository.recordMatch(match)).recorded, false);
  const profiles = await repository.loadProfiles();
  assert.equal(profiles.find((item) => item.playerId === 'winner')?.wins, 1);
  assert.equal(profiles.find((item) => item.playerId === 'loser')?.losses, 1);
});

test('기존 JSON 프로필을 ID 기준으로 중복 없이 가져온다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-profile-import-'));
  const repository = new FileProfileRepository(join(directory, 'profiles.json'));
  assert.equal(await repository.importProfiles([profile('a'), profile('b')]), 2);
  assert.equal(await repository.importProfiles([profile('a'), profile('b')]), 0);
  assert.equal((await repository.loadProfiles()).length, 2);
});

test('기존 기기 Elo는 한 프로필에 한 번만 승계한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-profile-legacy-'));
  const repository = new FileProfileRepository(join(directory, 'profiles.json'));
  await repository.importProfiles([profile('legacy')]);
  const claim = {
    name: '따뜻보스',
    wins: 42,
    losses: 18,
    rating: 1799,
    migratedAt: '2026-09-15T00:00:00.000Z',
  };

  const first = await repository.migrateLegacyProfile('legacy', claim);
  const second = await repository.migrateLegacyProfile('legacy', { ...claim, rating: 2000 });
  assert.equal(first.migrated, true);
  assert.equal(first.profile.rating, 1799);
  assert.equal(first.profile.name, '따뜻보스');
  assert.equal(second.migrated, false);
  assert.equal(second.profile.rating, 1799);
});
