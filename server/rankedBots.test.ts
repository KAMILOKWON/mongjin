import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { FileProfileRepository, PostgresProfileRepository, type ProfileRepository, type StoredProfile } from './profileRepository';
import { RANKED_BOTS, ensureRankedBots, selectRankedBot } from './rankedBots';
import { createRankedBot, chooseOfficialBotMove } from './officialBot';
import { learnBotOpening, learnedOpeningHints, type BotLearningGame } from './rankedBotLearning';
import { buildLeaderboard } from './leaderboard';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fileRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mongjin-ranked-')); dirs.push(dir);
  const path = join(dir, 'profiles.json');
  return { path, repo: new FileProfileRepository(path) };
}
function finishedGame(): BotLearningGame {
  let state = initialState(DEFAULT_CONFIG);
  for (let ply = 0; ply < 30 && !getResult(state, DEFAULT_CONFIG); ply++) {
    const moves = legalMoves(state, DEFAULT_CONFIG);
    const move = state.turn === 'BLACK'
      ? moves.find((m) => m.kind === 'MOVE' && m.to.r === m.from.r - 1)
      : moves.find((m) => m.kind === 'MOVE' && m.to.r === m.from.r);
    if (!move) throw new Error('Missing fixture move');
    state = applyMove(state, move);
  }
  const result = getResult(state, DEFAULT_CONFIG)!;
  return { moves: state.history, config: DEFAULT_CONFIG, side: 'BLACK', ...result };
}

it('7명만 생성하고 재시작·초기화 시 전적/학습을 유지하며 닉네임 충돌은 거부한다', async () => {
  const { path, repo } = fileRepo();
  const profiles = await ensureRankedBots(repo);
  expect(profiles.map((p) => p.name)).toEqual(RANKED_BOTS.map((b) => b.name));
  await repo.saveProfile({ ...profiles[0]!, rating: 1700, wins: 2 });
  const reopened = await ensureRankedBots(new FileProfileRepository(path));
  expect(reopened).toHaveLength(7);
  expect(reopened[0]!.rating).toBe(1700);
  await repo.saveProfile({ ...profiles[0]!, playerId: 'human', token: 'human' });
  await expect(ensureRankedBots(repo)).rejects.toThrow('겹칩니다');
});

it('가까운 세 선수 중 선택하고 연속 상대를 피하며 대국 중 학습은 고정한다', async () => {
  const { repo } = fileRepo(); const profiles = await ensureRankedBots(repo);
  const selected = selectRankedBot(profiles, 1200, '용광로불주먹', () => 0);
  expect(selected.name).not.toBe('용광로불주먹');
  selected.botLearning = learnBotOpening(undefined, finishedGame());
  const bot = createRankedBot(selected, () => 0);
  expect(bot.name).toBe(selected.name); expect(bot.rating).toBe(selected.rating);
  selected.botLearning.games++;
  expect(bot.learning!.games).toBe(1);
  const state = initialState(DEFAULT_CONFIG);
  expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(chooseOfficialBotMove(bot, state, DEFAULT_CONFIG));
});

it('정상 기보만 학습하고 3회부터 해당 진영/규칙/수순에만 제한된 보너스를 준다', () => {
  const game = finishedGame(); const root = initialState(DEFAULT_CONFIG);
  let memory = learnBotOpening(undefined, game);
  expect(memory.games).toBe(1);
  expect(learnedOpeningHints(memory, root, 'BLACK').moveBonus(root, game.moves[0]!)).toBe(0);
  memory = learnBotOpening(learnBotOpening(memory, game), game);
  const hints = learnedOpeningHints(memory, root, 'BLACK');
  const searchChild = { ...applyMove(root, game.moves[0]!), history: [], positionCounts: {} };
  expect(hints.evalBonus(searchChild)).toBeGreaterThan(0);
  expect(hints.moveBonus(root, game.moves[0]!)).toBeGreaterThan(0);
  expect(hints.evalBonus(applyMove(root, game.moves[0]!))).toBeGreaterThan(0);
  expect(hints.moveBonus(root, game.moves[0]!)).toBeLessThan(16);
  expect(learnedOpeningHints(memory, root, 'WHITE').evalBonus(applyMove(root, game.moves[0]!))).toBe(0);
  for (const reason of ['disconnect', 'resign']) expect(learnBotOpening(memory, { ...game, reason })).toEqual(memory);
  expect(learnBotOpening(memory, { ...game, winner: 'WHITE' })).toEqual(memory);
  expect(learnBotOpening(memory, { ...game, moves: game.moves.slice(0, 2) })).toEqual(memory);
  expect(learnedOpeningHints(memory, root, 'BLACK', { ...DEFAULT_CONFIG, kingCapture: !DEFAULT_CONFIG.kingCapture }).moveBonus(root, game.moves[0]!)).toBe(0);
  let losses = learnBotOpening(undefined, { ...game, side: 'WHITE' });
  losses = learnBotOpening(learnBotOpening(losses, { ...game, side: 'WHITE' }), { ...game, side: 'WHITE' });
  const whiteRoot = applyMove(root, game.moves[0]!);
  expect(learnedOpeningHints(losses, whiteRoot, 'WHITE').moveBonus(whiteRoot, game.moves[1]!)).toBeLessThan(0);
});

async function resultChecks(repo: ProfileRepository, suffix = '') {
  const profiles = await ensureRankedBots(repo);
  const bot = profiles.find((p) => p.playerId === RANKED_BOTS[0].id)!;
  const human: StoredProfile = { ...bot, playerId: `human-${suffix}`, token: `human-token-${suffix}`, name: `human-${suffix}`, rating: 1000, wins: 0, losses: 0, botLearning: undefined };
  await repo.saveProfile(human);
  const match = { matchId: `ranked-test-${suffix}`, roomId: 'ROOM', playerId: human.playerId, playerWon: false,
    botPlayerId: bot.playerId, botName: bot.name, botRating: bot.rating, botSearchRating: 1000,
    difficultyBand: 'balanced', reason: 'goal', completedAt: new Date().toISOString(), learningGame: finishedGame() };
  const results = await Promise.all([repo.recordBotMatch(match), repo.recordBotMatch(match)]);
  expect(results.filter((r) => r.recorded)).toHaveLength(1);
  const after = await repo.loadProfiles(); const learned = after.find((p) => p.playerId === bot.playerId)!;
  expect(learned.wins).toBe(bot.wins + 1);
  expect(learned.rating).toBeGreaterThan(bot.rating);
  expect(learned.botLearning!.games).toBe((bot.botLearning?.games ?? 0) + 1);
  expect(after.find((p) => p.playerId === human.playerId)!.losses).toBe(1);
  expect(buildLeaderboard(after, 100, 0).find((p) => p.name === bot.name)!.rating).toBe(learned.rating);
  const staleHuman = { ...human, name: `renamed-${suffix}` };
  const saved = await repo.saveProfileMetadata(staleHuman);
  expect(saved.losses).toBe(1);
  expect(saved.rating).toBe(after.find((p) => p.playerId === human.playerId)!.rating);
  expect((await repo.loadProfiles()).find((p) => p.playerId === human.playerId)!.losses).toBe(1);
  return match;
}

it('양쪽 Elo·전적과 학습을 한 번 반영하고 재시작해도 중복 반영하지 않는다', async () => {
  const { path, repo } = fileRepo(); const match = await resultChecks(repo);
  const before = await repo.loadProfiles(); const reopened = new FileProfileRepository(path);
  expect(await reopened.loadProfiles()).toEqual(before);
  expect((await reopened.recordBotMatch(match)).recorded).toBe(false);
});

it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('Postgres 양쪽 결과·학습 동시 중복 처리 및 재연결', async () => {
  const repo = new PostgresProfileRepository(process.env.MONGJIN_TEST_DATABASE_URL!);
  try { await repo.initialize(); await resultChecks(repo, `${Date.now()}`); } finally { await repo.close(); }
  const reopened = new PostgresProfileRepository(process.env.MONGJIN_TEST_DATABASE_URL!);
  try { expect((await reopened.loadProfiles()).find((p) => p.playerId === RANKED_BOTS[0].id)!.botLearning!.games).toBeGreaterThan(0); }
  finally { await reopened.close(); }
}, 20000);


it('파일 commit 실패 후 같은 결과를 재시도해도 전적·학습이 정확히 한 번만 저장된다', async () => {
  const { path, repo } = fileRepo();
  const profiles = await ensureRankedBots(repo);
  const bot = profiles[0]!;
  const human = { ...bot, playerId: 'retry-human', token: 'retry-human', name: 'retry-human' };
  await repo.saveProfile(human);
  const before = await repo.loadProfiles();
  const match = { matchId: 'retry-match', roomId: 'retry-room', playerId: human.playerId,
    playerWon: false, botPlayerId: bot.playerId, botName: bot.name, botRating: bot.rating,
    botSearchRating: bot.rating, difficultyBand: 'balanced', reason: 'goal', completedAt: new Date().toISOString(),
    learningGame: finishedGame() };
  mkdirSync(`${path}.snapshot.json.tmp`);
  await expect(repo.recordBotMatch(match)).rejects.toThrow();
  expect(await repo.loadProfiles()).toEqual(before);
  expect(await new FileProfileRepository(path).loadProfiles()).toEqual(before);
  rmSync(`${path}.snapshot.json.tmp`, { recursive: true });
  expect((await repo.recordBotMatch(match)).recorded).toBe(true);
  expect((await repo.recordBotMatch(match)).recorded).toBe(false);
  expect((await repo.loadProfiles()).find((p) => p.playerId === bot.playerId)!.botLearning!.games).toBe(1);
});


it('구버전이 snapshot보다 나중에 바꾼 전적은 조용히 폐기하지 않고 복구를 요구한다', async () => {
  const { path, repo } = fileRepo(); const profiles = await ensureRankedBots(repo);
  writeFileSync(path, JSON.stringify(profiles.map((p) => ({ ...p, wins: p.wins + 1 }))));
  const later = new Date(Date.now() + 10000); utimesSync(path, later, later);
  expect(() => new FileProfileRepository(path)).toThrow('명시적으로 병합');
});
