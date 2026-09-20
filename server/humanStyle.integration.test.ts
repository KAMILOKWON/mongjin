import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { chooseMove } from '../src/ai/ai';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { getResult } from '../src/core/result';
import { legalMoves } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import { FIRST_PLACE_STYLE } from './firstPlaceStyle';
import { FileProfileRepository, type StoredProfile } from './profileRepository';
import { RANKED_BOTS } from './rankedBots';

const serverDir = dirname(fileURLToPath(import.meta.url));
const TARGET_ID = 'ranked-bot-first-place';
const TARGET_NAME = '1등찍고접기';
const HUMAN_ID = 'human-style-integration-player';
const HUMAN_TOKEN = 'human-style-integration-token';
const NATURAL_GAME_BUDGET_MS = 40_000;
const TARGET_MATCH_ATTEMPTS = 8;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  read: () => T | Promise<T>,
  timeoutMs: number,
  failure: () => string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(10);
  }
  throw new Error(failure());
}

interface RunningServer {
  child: ChildProcess;
  logs: string;
  url: string;
}

async function startServer(profilePath: string): Promise<RunningServer> {
  const running: RunningServer = {
    child: spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: '',
        HOST: '127.0.0.1',
        PORT: '0',
        MONGJIN_PROFILE_DATA_FILE: profilePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    logs: '',
    url: '',
  };
  running.child.stdout!.on('data', (chunk) => { running.logs += String(chunk); });
  running.child.stderr!.on('data', (chunk) => { running.logs += String(chunk); });
  try {
    running.url = await until(
      () => running.logs.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0],
      10_000,
      () => `서버 시작 시간 초과\n${running.logs}`,
    );
    return running;
  } catch (error) {
    await stopServer(running);
    throw error;
  }
}

async function stopServer(running: RunningServer | undefined): Promise<void> {
  if (!running || running.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => running.child.once('exit', () => resolve()));
  running.child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), pause(2_000).then(() => false)]);
  if (!stopped && running.child.exitCode === null) {
    running.child.kill('SIGKILL');
    await exited;
  }
}

interface WireMessage {
  type: string;
  playerId?: string;
  token?: string;
  profile?: Pick<StoredProfile, 'playerId' | 'name' | 'wins' | 'losses' | 'rating'>;
  side?: Player;
  state?: GameState;
  winner?: Player;
  reason?: string;
  opponent?: { name: string; rating: number; isBot?: boolean };
}

interface TestClient {
  ws: WebSocket;
  send(message: object): Promise<void>;
  next(type: string, timeoutMs?: number): Promise<WireMessage>;
  close(): Promise<void>;
}

function createClient(running: RunningServer): TestClient {
  const ws = new WebSocket(running.url);
  const messages: WireMessage[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as WireMessage));
  return {
    ws,
    async send(message) {
      await until(
        () => ws.readyState === WebSocket.OPEN,
        5_000,
        () => `WebSocket 연결 시간 초과\n${running.logs}`,
      );
      ws.send(JSON.stringify(message));
    },
    async next(type, timeoutMs = 6_000) {
      return until(
        () => {
          const index = messages.findIndex((message) => message.type === type);
          return index >= 0 ? messages.splice(index, 1)[0] : undefined;
        },
        timeoutMs,
        () => `${type} 메시지 시간 초과. 수신=${JSON.stringify(messages)}\n${running.logs}`,
      );
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.terminate();
      await closed;
    },
  };
}

async function authenticate(client: TestClient): Promise<WireMessage> {
  await client.send({ type: 'HELLO', playerId: HUMAN_ID, token: HUMAN_TOKEN });
  const identity = await client.next('IDENTITY');
  expect(identity.playerId).toBe(HUMAN_ID);
  expect(identity.token).toBe(HUMAN_TOKEN);
  return identity;
}

async function fetchLeaderboard(running: RunningServer) {
  const response = await fetch(`${running.url.replace('ws:', 'http:')}/leaderboard?limit=100`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<{
    totalPlayers: number;
    entries: Array<{ name: string; rating: number; wins: number; losses: number }>;
  }>;
}

function expectTransition(before: GameState, after: GameState, move: Move): void {
  expect(legalMoves(before, DEFAULT_CONFIG)).toContainEqual(move);
  expect(after).toEqual(applyMove(before, move));
}

async function matchTarget(running: RunningServer): Promise<{
  client: TestClient;
  found: WireMessage & { side: Player; state: GameState };
}> {
  for (let attempt = 0; attempt < TARGET_MATCH_ATTEMPTS; attempt += 1) {
    const client = createClient(running);
    await authenticate(client);
    await client.send({ type: 'MATCHMAKE_BOT' });
    const found = await client.next('MATCH_FOUND');
    if (found.opponent?.name === TARGET_NAME) {
      expect(found.side).toMatch(/^(BLACK|WHITE)$/);
      expect(found.state).toBeDefined();
      return { client, found: found as WireMessage & { side: Player; state: GameState } };
    }
    // The server records a result only after this player has taken a turn. Closing
    // immediately keeps retries from changing Elo or win/loss counters.
    await client.close();
    await pause(30);
  }
  throw new Error(`${TARGET_NAME} 매칭 실패 (${TARGET_MATCH_ATTEMPTS}회 제한)\n${running.logs}`);
}

async function playGame(client: TestClient, found: WireMessage & { side: Player; state: GameState }) {
  const humanSide = found.side;
  let state = found.state;
  let humanMoves = 0;
  let botMoves = 0;
  const deadline = Date.now() + NATURAL_GAME_BUDGET_MS;

  while (!getResult(state, DEFAULT_CONFIG) && state.history.length < 120 && Date.now() < deadline) {
    const before = state;
    if (state.turn === humanSide) {
      const move = chooseMove(state, DEFAULT_CONFIG, {
        maxMs: 60,
        maxDepth: 4,
        maxNodes: 4_000,
        choiceWindow: 8,
        planStrength: 1.5,
        strategyLevel: 3,
        elite: true,
        botSide: humanSide,
        rng: () => 0.37,
      });
      expect(move).not.toBeNull();
      await client.send({ type: 'MOVE', move });
      state = (await client.next('STATE')).state!;
      expectTransition(before, state, move!);
      humanMoves += 1;
    } else {
      state = (await client.next('STATE')).state!;
      const move = state.history.at(-1)!;
      expectTransition(before, state, move);
      botMoves += 1;
    }
  }

  const naturalResult = getResult(state, DEFAULT_CONFIG);
  if (!naturalResult) await client.send({ type: 'RESIGN' });
  const result = await client.next('MATCH_RESULT');
  expect(result.winner).toBe(naturalResult?.winner ?? (humanSide === 'BLACK' ? 'WHITE' : 'BLACK'));
  expect(result.reason).toBe(naturalResult?.reason ?? 'forfeit');
  expect(humanMoves).toBeGreaterThan(0);
  expect(botMoves).toBeGreaterThan(0);
  return { state, result, natural: naturalResult !== null, humanMoves, botMoves };
}

it('실제 서버에서 1등찍고접기와 합법 대국 후 결과를 저장하고 재시작해 한 프로필로 복구한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-human-style-integration-'));
  const profilePath = join(dir, 'profiles.json');
  const targetDefinition = RANKED_BOTS.find((bot) => bot.id === TARGET_ID)!;
  const oldDefinitions = RANKED_BOTS.filter((bot) => bot.id !== TARGET_ID);
  const now = '2026-09-20T00:00:00.000Z';
  const oldProfiles: StoredProfile[] = oldDefinitions.map((bot, index) => ({
    playerId: bot.id,
    token: `old-token-${index}`,
    name: bot.name,
    rating: 100,
    wins: index + 1,
    losses: index + 21,
    createdAt: now,
    updatedAt: now,
  }));
  const humanBefore: StoredProfile = {
    playerId: HUMAN_ID,
    token: HUMAN_TOKEN,
    name: '통합시험사람',
    rating: 1600,
    wins: 7,
    losses: 3,
    createdAt: now,
    updatedAt: now,
  };
  let running: RunningServer | undefined;
  let activeClient: TestClient | undefined;

  try {
    expect(RANKED_BOTS).toHaveLength(15);
    expect(oldDefinitions).toHaveLength(14);
    expect(targetDefinition).toMatchObject({ name: TARGET_NAME, rating: 1600, personality: 'runner' });
    expect(FIRST_PLACE_STYLE).toMatchObject({ version: 1, games: 120 });
    expect(FIRST_PLACE_STYLE.moves).toBeGreaterThan(0);
    expect(Object.keys(FIRST_PLACE_STYLE.positions).length).toBeGreaterThan(0);
    const seed = new FileProfileRepository(profilePath);
    await seed.importProfiles([...oldProfiles, humanBefore]);
    await seed.close();

    running = await startServer(profilePath);
    const initialBoard = await fetchLeaderboard(running);
    expect(initialBoard.totalPlayers).toBe(16);
    expect(initialBoard.entries.filter((entry) => entry.name === TARGET_NAME)).toEqual([
      expect.objectContaining({ rating: 1600, wins: 0, losses: 0 }),
    ]);
    for (const old of oldProfiles) {
      expect(initialBoard.entries.find((entry) => entry.name === old.name)).toMatchObject({
        rating: old.rating,
        wins: old.wins,
        losses: old.losses,
      });
    }

    const matched = await matchTarget(running);
    activeClient = matched.client;
    expect(matched.found.opponent).toEqual({ name: TARGET_NAME, rating: 1600, isBot: true });
    const played = await playGame(activeClient, matched.found);
    const humanWon = played.result.winner === matched.found.side;
    expect(played.result.profile).toMatchObject({
      playerId: HUMAN_ID,
      wins: humanBefore.wins + Number(humanWon),
      losses: humanBefore.losses + Number(!humanWon),
    });

    const boardAfterGame = await fetchLeaderboard(running);
    const targetAfterGameRow = boardAfterGame.entries.find((entry) => entry.name === TARGET_NAME)!;
    expect(targetAfterGameRow).toMatchObject({
      wins: Number(!humanWon),
      losses: Number(humanWon),
    });
    expect(targetAfterGameRow.rating).not.toBe(1600);
    expect(targetAfterGameRow.rating + played.result.profile!.rating).toBe(3200);
    console.info(
      `[human-style integration] ${played.natural ? played.result.reason : 'resign-fallback'} ` +
      `${played.state.history.length} plies (human ${played.humanMoves}, bot ${played.botMoves})`,
    );

    await activeClient.close();
    activeClient = undefined;
    await stopServer(running);
    running = undefined;

    const persisted = await new FileProfileRepository(profilePath).loadProfiles();
    const targetAfterGame = persisted.find((profile) => profile.playerId === TARGET_ID)!;
    const humanAfterGame = persisted.find((profile) => profile.playerId === HUMAN_ID)!;
    expect(targetAfterGame).toMatchObject({
      name: targetAfterGameRow.name,
      rating: targetAfterGameRow.rating,
      wins: targetAfterGameRow.wins,
      losses: targetAfterGameRow.losses,
    });
    expect(humanAfterGame).toMatchObject({
      playerId: played.result.profile!.playerId,
      name: played.result.profile!.name,
      rating: played.result.profile!.rating,
      wins: played.result.profile!.wins,
      losses: played.result.profile!.losses,
    });
    for (const old of oldProfiles) {
      expect(persisted.find((profile) => profile.playerId === old.playerId)).toEqual(old);
    }

    running = await startServer(profilePath);
    const boardAfterRestart = await fetchLeaderboard(running);
    expect(boardAfterRestart.entries.filter((entry) => entry.name === TARGET_NAME)).toEqual([
      expect.objectContaining({
        name: targetAfterGameRow.name,
        rating: targetAfterGameRow.rating,
        wins: targetAfterGameRow.wins,
        losses: targetAfterGameRow.losses,
      }),
    ]);
    activeClient = createClient(running);
    const identityAfterRestart = await authenticate(activeClient);
    expect(identityAfterRestart.profile).toMatchObject({
      playerId: humanAfterGame.playerId,
      name: humanAfterGame.name,
      rating: humanAfterGame.rating,
      wins: humanAfterGame.wins,
      losses: humanAfterGame.losses,
    });

    await activeClient.close();
    activeClient = undefined;
    await stopServer(running);
    running = undefined;
    const afterRestart = await new FileProfileRepository(profilePath).loadProfiles();
    expect(afterRestart.find((profile) => profile.playerId === TARGET_ID)).toEqual(targetAfterGame);
    expect(afterRestart.find((profile) => profile.playerId === HUMAN_ID)).toEqual(humanAfterGame);
    expect(afterRestart.filter((profile) => profile.playerId === TARGET_ID)).toHaveLength(1);
    expect(afterRestart.filter((profile) => RANKED_BOTS.some((bot) => bot.id === profile.playerId))).toHaveLength(15);
  } finally {
    await activeClient?.close();
    await stopServer(running);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
