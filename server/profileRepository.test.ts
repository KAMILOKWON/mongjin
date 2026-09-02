import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  FileProfileRepository,
  applyBotEloResult,
  applyEloResult,
  type StoredProfile,
} from './profileRepository';

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

test('공식 봇 대전도 같은 K=24로 승패와 Elo를 반영한다', () => {
  const won = applyBotEloResult(profile('player'), 1200, true, '2026-09-01T01:00:00.000Z');
  const lost = applyBotEloResult(profile('player'), 1200, false, '2026-09-01T01:00:00.000Z');

  assert.equal(won.wins, 1);
  assert.equal(won.losses, 0);
  assert.equal(won.rating, 1212);
  assert.equal(lost.wins, 0);
  assert.equal(lost.losses, 1);
  assert.equal(lost.rating, 1188);
});

test('공식 봇 경기 결과는 이용자에게 한 번만 반영하고 봇 프로필은 만들지 않는다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-bot-match-'));
  const repository = new FileProfileRepository(join(directory, 'profiles.json'));
  await repository.importProfiles([profile('player')]);
  const match = {
    matchId: 'bot-match-1',
    roomId: 'BOT001',
    playerId: 'player',
    playerWon: true,
    botName: '고요한별',
    botRating: 1200,
    botSearchRating: 1120,
    difficultyBand: 'onboarding',
    reason: 'goal',
    completedAt: '2026-09-01T01:00:00.000Z',
  };

  assert.equal((await repository.recordBotMatch(match)).recorded, true);
  assert.equal((await repository.recordBotMatch(match)).recorded, false);
  const profiles = await repository.loadProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.wins, 1);
  assert.equal(profiles[0]?.rating, 1212);
});

test('공식 봇 완료 횟수와 최근 승패를 난이도 조절용으로 집계한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-bot-progress-'));
  const profileFile = join(directory, 'profiles.json');
  const repository = new FileProfileRepository(profileFile);
  await repository.importProfiles([profile('player')]);
  for (let index = 0; index < 4; index += 1) {
    await repository.recordBotMatch({
      matchId: `bot-match-${index}`,
      roomId: `BOT00${index}`,
      playerId: 'player',
      playerWon: index === 0,
      botName: '고요한별',
      botRating: 1200,
      botSearchRating: 1120,
      difficultyBand: 'onboarding',
      reason: 'goal',
      completedAt: `2026-09-01T0${index}:00:00.000Z`,
    });
  }

  const reopened = new FileProfileRepository(profileFile);
  assert.deepEqual(await reopened.getBotMatchProgress('player', 3), {
    completed: 4,
    recentWins: 0,
    recentLosses: 3,
  });
});

test('대국 생명주기 이벤트는 같은 이용자·단계마다 한 번만 저장한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-match-events-'));
  const profileFile = join(directory, 'profiles.json');
  const repository = new FileProfileRepository(profileFile);
  await repository.importProfiles([profile('player')]);
  const event = {
    matchId: 'match-event-1',
    roomId: 'EVENT1',
    playerId: 'player',
    matchKind: 'bot' as const,
    opponentKind: 'bot' as const,
    event: 'started' as const,
    platform: 'toss' as const,
    plyCount: 0,
    occurredAt: '2026-09-01T00:00:00.000Z',
  };

  await repository.recordMatchEvent(event);
  await repository.recordMatchEvent(event);
  const events = JSON.parse(readFileSync(`${profileFile}.match-events.json`, 'utf8')) as unknown[];
  assert.equal(events.length, 1);
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
