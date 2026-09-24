import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { FileGameRecordStore, RECORD_RULES_VERSION, type GameRecord } from './gameRecords';
import { backfillFirstMoves } from './firstMove';
import { FileProfileRepository, type StoredProfile } from './profileRepository';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function profile(playerId: string): StoredProfile {
  return { playerId, token: `token-${playerId}`, name: playerId, wins: 0, losses: 0,
    rating: 1200, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
}
function record(matchId: string, kind: GameRecord['kind'], plies: number, humanSide: 'BLACK' | 'WHITE' = 'BLACK', winner?: 'BLACK' | 'WHITE'): GameRecord {
  return { schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId, kind,
    startedAt: '2026-09-01T00:00:00Z', status: 'completed', revision: 2,
    players: { BLACK: { kind: kind === 'bot' && humanSide === 'WHITE' ? 'bot' : 'human', rating: 1200 },
      WHITE: { kind: kind === 'bot' && humanSide === 'BLACK' ? 'bot' : 'human', rating: 1200 } },
    config: DEFAULT_CONFIG, moves: Array.from({ length: plies }, () => ({ kind: 'PLACE' as const, to: { r: 1, c: 1 } })),
    winner, reason: 'resign' };
}
function event(matchId: string, playerId: string, matchKind: 'bot' | 'random', plyCount: number, outcome?: 'win' | 'loss') {
  return { matchId, roomId: matchId, playerId, matchKind, opponentKind: matchKind === 'bot' ? 'bot' as const : 'human' as const,
    event: 'completed' as const, platform: 'web' as const, plyCount, outcome, reason: 'resign', occurredAt: '2026-09-01T01:00:00Z' };
}

it('과거 봇 첫 수, 백 첫 수, 한 수 빠른 대전과 결과 이유를 보수적으로 복원하고 재시작 후 유지한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mongjin-first-move-')); dirs.push(dir);
  const path = join(dir, 'profiles.json');
  const repo = new FileProfileRepository(path);
  const games = new FileGameRecordStore(join(dir, 'game-records'));
  await repo.importProfiles(['forfeit', 'botOnly', 'white', 'black', 'earlyWhite', 'normal', 'ambiguous', 'opponent',
    'bothBlack', 'bothWhite', 'eventBot', 'botMatchId']
    .map(profile));
  await repo.recordMatch({ matchId: 'forfeit-match', roomId: 'F', winnerId: 'forfeit', loserId: 'opponent',
    reason: 'forfeit', completedAt: '2026-09-01T01:00:00Z' });
  await repo.recordMatchEvent(event('bot-first', 'botOnly', 'bot', 1, 'loss'));
  await repo.recordBotMatch({ matchId: 'bot-first', roomId: 'B1', playerId: 'botOnly', playerWon: false,
    botName: 'bot', botRating: 1200, botSearchRating: 1200, difficultyBand: 'balanced',
    reason: 'forfeit', completedAt: '2026-09-01T01:00:00Z' });
  await games.save(record('bot-first', 'bot', 1, 'WHITE', 'BLACK'));
  await repo.recordMatchEvent(event('bot-white', 'white', 'bot', 2, 'loss'));
  await games.save(record('bot-white', 'bot', 2, 'WHITE', 'BLACK'));
  await repo.recordMatch({ matchId: 'random-one', roomId: 'R', winnerId: 'earlyWhite', loserId: 'black',
    reason: 'forfeit', completedAt: '2026-09-01T01:00:00Z' });
  await games.save(record('random-one', 'random', 1, 'BLACK', 'WHITE'));
  await repo.recordMatch({ matchId: 'normal-result', roomId: 'N', winnerId: 'normal', loserId: 'opponent',
    reason: 'goal', completedAt: '2026-09-01T01:00:00Z' });
  await repo.recordMatchEvent(event('ambiguous-one', 'ambiguous', 'random', 1));
  await games.save(record('ambiguous-one', 'random', 1));
  await repo.recordMatch({ matchId: 'random-two', roomId: 'R2', winnerId: 'bothBlack', loserId: 'bothWhite',
    reason: 'forfeit', completedAt: '2026-09-01T01:00:00Z' });
  await games.save(record('random-two', 'random', 2));
  await repo.recordMatchEvent(event('event-bot-two', 'eventBot', 'bot', 2, 'loss'));
  await repo.recordBotMatch({ matchId: 'bot-without-event', roomId: 'B2', playerId: 'botMatchId', playerWon: false,
    botName: 'bot', botRating: 1200, botSearchRating: 1200, difficultyBand: 'balanced',
    reason: 'forfeit', completedAt: '2026-09-01T01:00:00Z' });
  await games.save(record('bot-without-event', 'bot', 2, 'WHITE', 'BLACK'));

  expect(await backfillFirstMoves(repo, games)).toBe(7);
  const reopened = new FileProfileRepository(path);
  const loaded = await reopened.loadProfiles();
  const flags = new Map(loaded.map((item) => [item.playerId, item.hasPlayedMove]));
  expect(loaded.find((item) => item.playerId === 'forfeit')?.wins).toBe(1);
  expect(loaded.find((item) => item.playerId === 'opponent')?.losses).toBe(2);
  expect(flags.get('forfeit')).toBeFalsy();
  expect(flags.get('opponent')).toBeFalsy();
  expect(flags.get('botOnly')).toBeFalsy();
  expect(flags.get('white')).toBe(true);
  expect(flags.get('black')).toBe(true);
  expect(flags.get('earlyWhite')).toBeFalsy();
  expect(flags.get('normal')).toBe(true);
  expect(flags.get('ambiguous')).toBeFalsy();
  expect(flags.get('bothBlack')).toBe(true);
  expect(flags.get('bothWhite')).toBe(true);
  expect(flags.get('eventBot')).toBe(true);
  expect(flags.get('botMatchId')).toBe(true);
  expect(loaded.find((item) => item.playerId === 'botOnly')?.losses).toBe(1);
  expect(await backfillFirstMoves(reopened, games)).toBe(0);
  const stale = profile('white');
  expect((await reopened.saveProfileMetadata(stale)).hasPlayedMove).toBe(true);
  await reopened.saveProfile(stale);
  expect((await new FileProfileRepository(path).loadProfiles()).find((item) => item.playerId === 'white')?.hasPlayedMove).toBe(true);
});

it('이전 snapshot에 결과 요약 필드가 없어도 이벤트와 기보를 복원한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mongjin-first-move-old-snapshot-')); dirs.push(dir);
  const path = join(dir, 'profiles.json');
  const repo = new FileProfileRepository(path);
  await repo.importProfiles([profile('old')]);
  await repo.recordMatchEvent(event('old-bot', 'old', 'bot', 2));
  const snapshotPath = `${path}.snapshot.json`;
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  delete snapshot.matches;
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const reopened = new FileProfileRepository(path);
  const games = new FileGameRecordStore(join(dir, 'game-records'));
  await games.save(record('old-bot', 'bot', 2, 'WHITE'));
  expect(await backfillFirstMoves(reopened, games)).toBe(1);
  expect((await new FileProfileRepository(path).loadProfiles())[0]?.hasPlayedMove).toBe(true);
});
