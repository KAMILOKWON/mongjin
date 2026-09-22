import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { jevMoveId, jevStateHash } from './jevPolicy';
import { RANKED_BOTS } from './rankedBots';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, timeoutMs = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(20);
  }
  throw new Error('Timeout waiting for condition');
}

interface WsMessage {
  type: string;
  roomId?: string;
  side?: string;
  state?: any;
  opponent?: any;
  profile?: any;
  winner?: string;
  reason?: string;
  message?: string;
}

const mockPreloadScript = `
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
const originalDateNow = Date.now;
// Use the same offset in the server and every later worker. Resetting each
// worker to a fixed epoch makes its absolute deadline stale after a long wait.
const clockOffset = Number(process.env.MOCK_JEV_CLOCK_OFFSET_MS);
Date.now = () => originalDateNow() + clockOffset;

Math.random = () => 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes('ai-gateway.vercel.sh/v1/evaluate')) {
    if (originalFetch) return originalFetch(input, init);
    throw new Error(\`Unexpected fetch URL: \${url}\`);
  }

  const oncePath = process.env.MOCK_JEV_FAIL_ONCE_PATH;
  const failOnce = oncePath && !existsSync(oncePath);
  if (failOnce) {
    writeFileSync(oncePath, 'failed', { flag: 'wx' });
    if (process.env.MOCK_JEV_FAILURE_KIND === 'network') throw new TypeError('mock disconnected');
    if (process.env.MOCK_JEV_FAILURE_KIND === 'provider-alias') {
      return new Response(readFileSync(process.env.MOCK_JEV_ALIAS_BODY_PATH, 'utf8'), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  const recoverPath = process.env.MOCK_JEV_RECOVER_PATH;
  const waitingForRecovery = recoverPath && !existsSync(recoverPath);
  const forcedStatus = Number(process.env.MOCK_JEV_HTTP_STATUS || '0');
  if (forcedStatus || failOnce || waitingForRecovery) {
    // The transport status must win over a conflicting provider body field.
    return new Response(JSON.stringify({ status: 503, error: 'mock gateway failure' }), {
      status: forcedStatus || 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const delayMs = Number(process.env.MOCK_JEV_DELAY_MS || '0');
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const body = JSON.parse(String(init?.body || '{}'));
  const questions = body.questions || {};
  const answers = {};

  let choiceAlternator = 0;
  for (const [qId, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const criteria = question.criteria || {};
      const keys = Object.keys(criteria);
      let chosenKey = keys[0];

      if (qId === 'move') {
        chosenKey = keys[keys.length - 1];
      } else {
        const pickIndex = (choiceAlternator % 2 === 0) ? 0 : Math.min(1, keys.length - 1);
        chosenKey = keys[pickIndex];
        choiceAlternator++;
      }

      const probabilities = {};
      for (const k of keys) {
        probabilities[k] = (k === chosenKey) ? 1 : 0;
      }

      answers[qId] = {
        type: 'choice',
        choice: chosenKey,
        probabilities,
        confidence: 0.95,
      };
    } else if (question.type === 'boolean') {
      answers[qId] = {
        type: 'boolean',
        probability: 0.1,
      };
    }
  }

  const payload = {
    model: 'typesafe-ai/jev',
    answers,
    usage: { inputTokens: 120, outputTokens: 25 },
    providerMetadata: {
      gateway: {
        cost: 0,
        generationId: 'mock-gen-0',
      },
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
`;

interface SpawnedTestServer {
  tempDir: string;
  profileDataFile: string;
  server: ChildProcess;
  url: string;
  httpUrl: string;
  recoveryFlagPath: string;
  output: () => string;
  cleanup: () => Promise<void>;
}

async function startTestServer(options: {
  mock503?: boolean;
  mockStatus?: number;
  failOnce?: '503' | 'network' | 'provider-alias';
  recoverAfterFlag?: boolean;
  startRecovered?: boolean;
  mockDelayMs?: number;
  botRating?: number;
}): Promise<SpawnedTestServer> {
  const tempDir = await mkdtemp(join(tmpdir(), 'jev-ranked-test-'));
  const mockScriptPath = join(tempDir, 'mock.mjs');
  await writeFile(mockScriptPath, mockPreloadScript, 'utf8');

  const profileDataFile = join(tempDir, 'profiles.json');
  const recoveryFlagPath = join(tempDir, 'gateway-recovered');
  if (options.startRecovered) await writeFile(recoveryFlagPath, 'recover', 'utf8');
  // Most engine tests isolate JEV by rating; matchmaking tests use an equal-rated roster.
  const seededBots = RANKED_BOTS.map((bot) => ({
    playerId: bot.id,
    token: `token-${bot.id}`,
    name: bot.name,
    wins: 0,
    losses: 0,
    rating: options.botRating ?? 100,
    createdAt: new Date('2026-09-20T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-20T00:00:00.000Z').toISOString(),
  }));
  await writeFile(profileDataFile, JSON.stringify(seededBots, null, 2), 'utf8');

  const serverDir = dirname(fileURLToPath(import.meta.url));
  const nodeOptions = [process.env.NODE_OPTIONS, `--import ${mockScriptPath}`].filter(Boolean).join(' ');

  const server = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      MONGJIN_PROFILE_DATA_FILE: profileDataFile,
      MONGJIN_JEV_ENABLED: '1',
      AI_GATEWAY_API_KEY: 'mock-test-key-safe',
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_URL: '',
      MOCK_JEV_CLOCK_OFFSET_MS: String(Date.parse('2026-09-20T12:00:00+09:00') - Date.now()),
      MOCK_JEV_HTTP_STATUS: String(options.mockStatus ?? (options.mock503 ? 503 : 0)),
      MOCK_JEV_FAIL_ONCE_PATH: options.failOnce ? join(tempDir, 'gateway-failed-once') : '',
      MOCK_JEV_FAILURE_KIND: options.failOnce ?? '',
      MOCK_JEV_RECOVER_PATH: options.recoverAfterFlag ? recoveryFlagPath : '',
      MOCK_JEV_ALIAS_BODY_PATH: join(serverDir, 'fixtures', 'jev-provider-alias-unavailable.json'),
      MOCK_JEV_DELAY_MS: String(options.mockDelayMs ?? 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout!.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr!.on('data', (chunk) => { serverOutput += chunk; });

  const url = await until(() => serverOutput.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]);
  const httpUrl = url.replace('ws://', 'http://');

  const cleanup = async () => {
    if (server.exitCode === null) {
      const stopped = new Promise((resolve) => server.once('exit', resolve));
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(tempDir, { recursive: true, force: true });
  };

  return {
    tempDir,
    profileDataFile,
    server,
    url,
    httpUrl,
    recoveryFlagPath,
    output: () => serverOutput,
    cleanup,
  };
}

describe('JEV Ranked WebSocket Integration', () => {
  it('preserves human matching, prioritizes idle JEV, and falls back while busy or after the same opponent', async () => {
    const testEnv = await startTestServer({ botRating: 1200 });
    const sockets: WebSocket[] = [];
    const connect = async () => {
      const socket = new WebSocket(testEnv.url);
      sockets.push(socket);
      const messages: WsMessage[] = [];
      socket.on('message', raw => messages.push(JSON.parse(String(raw))));
      const next = (type: string) => until(() => {
        const index = messages.findIndex(message => message.type === type);
        return index >= 0 ? messages.splice(index, 1)[0] : undefined;
      });
      const send = (type: string) => socket.send(JSON.stringify({ type }));
      await until(() => socket.readyState === WebSocket.OPEN);
      send('HELLO');
      await next('IDENTITY');
      return { send, next };
    };
    try {
      const first = await connect();
      const second = await connect();
      const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
      expect(health.jev).toMatchObject({ acceptingMatches: true, matchmakingPolicy: 'idle-priority-v1' });

      // A free JEV must never intercept two people asking for human matchmaking.
      first.send('MATCHMAKE');
      await until(async () => (await (await fetch(`${testEnv.httpUrl}/health`)).json()).queued === 1);
      second.send('MATCHMAKE');
      const humanFirst = await first.next('MATCH_FOUND');
      const humanSecond = await second.next('MATCH_FOUND');
      expect(humanFirst.roomId).toBe(humanSecond.roomId);
      expect(humanFirst.side).not.toBe(humanSecond.side);
      expect(humanFirst.opponent.isBot).not.toBe(true);
      expect(humanSecond.opponent.isBot).not.toBe(true);
      first.send('RESIGN');
      await first.next('MATCH_RESULT');
      await second.next('MATCH_RESULT');

      first.send('MATCHMAKE_BOT');
      expect((await first.next('MATCH_FOUND')).opponent.name).toBe('침착맨이할때까지');
      second.send('MATCHMAKE_BOT');
      const busyFallback = await second.next('MATCH_FOUND');
      expect(busyFallback.opponent.isBot).toBe(true);
      expect(busyFallback.opponent.name).not.toBe('침착맨이할때까지');

      first.send('RESIGN');
      await first.next('MATCH_RESULT');
      // The JEV slot is free again, but this player just completed a JEV game.
      first.send('MATCHMAKE_BOT');
      const repeatFallback = await first.next('MATCH_FOUND');
      expect(repeatFallback.opponent.isBot).toBe(true);
      expect(repeatFallback.opponent.name).not.toBe('침착맨이할때까지');

      second.send('RESIGN');
      await second.next('MATCH_RESULT');
      second.send('MATCHMAKE_BOT');
      expect((await second.next('MATCH_FOUND')).opponent.name).toBe('침착맨이할때까지');
    } finally {
      sockets.forEach(socket => socket.terminate());
      await testEnv.cleanup();
    }
  }, 35_000);

  it(
    'matches JEV, verifies leaderboard JEV 1200, handles delayed in-flight resign without stale STATE and changes Elo once',
    async () => {
      // 1200ms gateway delay allows clean in-flight resign window
      const testEnv = await startTestServer({ mockDelayMs: 1200 });
      let socket: WebSocket | undefined;

      try {
        // 1. Leaderboard & profile verification
        const lbRes = await fetch(`${testEnv.httpUrl}/leaderboard`);
        expect(lbRes.ok).toBe(true);
        const lbData = (await lbRes.json()) as {
          totalPlayers: number;
          entries: Array<{ rank: number; name: string; rating: number }>;
        };

        // Existing roster plus the opt-in JEV profile (1200).
        expect(lbData.totalPlayers).toBe(RANKED_BOTS.length + 1);
        expect(lbData.entries[0]).toMatchObject({
          name: '침착맨이할때까지',
          rating: 1200,
        });

        // 2. Connect WebSocket client
        socket = new WebSocket(testEnv.url);
        const messages: WsMessage[] = [];

        socket.on('message', (raw) => {
          messages.push(JSON.parse(String(raw)));
        });

        const next = (type: string, timeoutMs = 15000) =>
          until(() => {
            const idx = messages.findIndex((m) => m.type === type);
            return idx >= 0 ? messages.splice(idx, 1)[0] : undefined;
          }, timeoutMs);

        await until(() => socket!.readyState === WebSocket.OPEN);

        // Handshake
        socket.send(JSON.stringify({ type: 'HELLO' }));
        const identity = await next('IDENTITY');
        expect(identity.profile.rating).toBe(1200);

        // Request Ranked Bot Matchmaking
        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        const matchFound = await next('MATCH_FOUND');

        // Verify match parameters: Human WHITE, JEV BLACK (bot starts first)
        expect(matchFound.side).toBe('WHITE');
        expect(matchFound.opponent).toMatchObject({
          name: '침착맨이할때까지',
          rating: 1200,
          isBot: true,
        });

        // Normal state is legal
        expect(matchFound.state).toBeDefined();
        expect(matchFound.state.turn).toBe('BLACK');
        expect(matchFound.state.board).toHaveLength(9);

        // No API key exposure in messages or logs
        expect(JSON.stringify(messages)).not.toContain('mock-test-key-safe');
        expect(testEnv.output()).not.toContain('mock-test-key-safe');

        // Wait 750ms so JEV decision / gateway fetch is in-flight
        await pause(750);

        // Human resigns while JEV decision is in-flight
        socket.send(JSON.stringify({ type: 'RESIGN' }));

        const matchResult = await next('MATCH_RESULT');
        expect(matchResult.winner).toBe('BLACK');
        expect(matchResult.reason).toBe('forfeit');

        // Human lost Elo from 1200 (1200 -> 1188 with K=24)
        const newRating = matchResult.profile.rating;
        expect(newRating).toBeLessThan(1200);
        expect(newRating).toBe(1188);

        // Wait 1500ms for delayed gateway response to arrive and be discarded
        await pause(1500);

        // Assert NO stale STATE message arrives after MATCH_RESULT
        const staleStates = messages.filter((m) => m.type === 'STATE');
        expect(staleStates).toHaveLength(0);

        // Verify human profile rating was updated exactly once
        const profilesJson = JSON.parse(
          await readFile(testEnv.profileDataFile, 'utf8'),
        ) as Array<{ playerId: string; rating: number }>;
        const humanStored = profilesJson.find(
          (p) => p.playerId === identity.profile.playerId,
        );
        expect(humanStored).toBeDefined();
        expect(humanStored?.rating).toBe(1188);

        const jevStored = profilesJson.find((p) => p.playerId === 'ranked-bot-jev');
        expect(jevStored).toBeDefined();
        expect(jevStored?.rating).toBe(1212);
      } finally {
        socket?.terminate();
        await testEnv.cleanup();
      }
    },
    35000,
  );

  it(
    'preserves the board through a full failed 503 turn and applies exactly one late recovered move',
    async () => {
      const testEnv = await startTestServer({ recoverAfterFlag: true });
      let socket: WebSocket | undefined;

      try {
        socket = new WebSocket(testEnv.url);
        const messages: WsMessage[] = [];
        const received: WsMessage[] = [];

        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          messages.push(message);
          received.push(message);
        });

        const next = (type: string, timeoutMs = 20_000) =>
          until(() => {
            const idx = messages.findIndex((m) => m.type === type);
            return idx >= 0 ? messages.splice(idx, 1)[0] : undefined;
          }, timeoutMs);

        await until(() => socket!.readyState === WebSocket.OPEN);

        socket.send(JSON.stringify({ type: 'HELLO' }));
        const identity = await next('IDENTITY');
        expect(identity.profile.rating).toBe(1200);

        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        const matchFound = await next('MATCH_FOUND');
        expect(matchFound.opponent.name).toBe('침착맨이할때까지');
        const fixedState = structuredClone(matchFound.state);

        await until(() => testEnv.output().includes('"event":"match_recovery_wait"'), 45_000);

        const waitingHealth = await (await fetch(`${testEnv.httpUrl}/health`)).json();
        expect(waitingHealth).toMatchObject({ rooms: 1, jev: {
          matchRecoveryPolicy: 'preserve-v1', waitingMatches: 1,
          acceptingMatches: false, reason: 'transient_cooldown',
        } });
        expect(received.some(message => ['ERROR', 'STATE', 'OPPONENT_LEFT', 'MATCH_RESULT'].includes(message.type))).toBe(false);

        await writeFile(testEnv.recoveryFlagPath, 'recover', 'utf8');
        const update = await next('STATE', 50_000).catch((error) => {
          const messages = received.map(message => ({ type: message.type, message: message.message,
            plies: message.state?.history?.length }));
          throw new Error(`${String(error)}\nmessages=${JSON.stringify(messages)}\nserver=${testEnv.output()}`);
        });
        expect(update.state.history).toHaveLength(1);
        expect(legalMoves(fixedState, DEFAULT_CONFIG)).toContainEqual(update.state.history[0]);
        expect(applyMove(fixedState, update.state.history[0])).toEqual(update.state);

        expect(received.filter(message => message.type === 'STATE')).toHaveLength(1);
        expect(received.some(message => ['ERROR', 'OPPONENT_LEFT', 'MATCH_RESULT'].includes(message.type))).toBe(false);

        const records = await until(async () => {
          const files = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter(file => file.endsWith('.json'));
          const saved = await Promise.all(files.map(async file => JSON.parse(
            await readFile(join(testEnv.tempDir, 'jev-decisions', file), 'utf8'),
          )));
          return saved.filter(record => record.status === 'applied').length === 1 ? saved : null;
        });
        expect(records.filter(record => record.status === 'applied')).toHaveLength(1);
        expect(new Set(records.map(record => record.stateHash))).toEqual(new Set([jevStateHash(fixedState)]));
        expect(records.every(record => record.ply === 0)).toBe(true);

        const recoveredHealth = await (await fetch(`${testEnv.httpUrl}/health`)).json();
        expect(recoveredHealth.jev).toMatchObject({ matchRecoveryPolicy: 'preserve-v1', waitingMatches: 0,
          acceptingMatches: true, reason: null, successfulMoves: 1 });
        const profiles = JSON.parse(await readFile(testEnv.profileDataFile, 'utf8')) as Array<{ playerId: string; rating: number }>;
        expect(profiles.find(profile => profile.playerId === identity.profile.playerId)?.rating).toBe(1200);
        expect(profiles.find(profile => profile.playerId === 'ranked-bot-jev')?.rating).toBe(1200);
      } finally {
        socket?.terminate();
        await testEnv.cleanup();
      }
    },
    90_000,
  );

  it.each(['resign', 'disconnect'] as const)(
    'voids a recovering match without Elo when the player leaves by %s',
    async (departure) => {
      const testEnv = await startTestServer({ recoverAfterFlag: true, startRecovered: true });
      let socket: WebSocket | undefined;
      try {
        socket = new WebSocket(testEnv.url);
        const messages: WsMessage[] = [];
        socket.on('message', raw => messages.push(JSON.parse(String(raw))));
        const next = (type: string, timeoutMs = 20_000) => until(() => {
          const index = messages.findIndex(message => message.type === type);
          return index < 0 ? undefined : messages.splice(index, 1)[0];
        }, timeoutMs);
        await until(() => socket!.readyState === WebSocket.OPEN);
        socket.send(JSON.stringify({ type: 'HELLO' }));
        const identity = await next('IDENTITY');
        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        await next('MATCH_FOUND');
        const opening = await next('STATE');
        expect(opening.state.history).toHaveLength(1);
        await rm(testEnv.recoveryFlagPath);
        const humanMove = legalMoves(opening.state, DEFAULT_CONFIG)[0]!;
        socket.send(JSON.stringify({ type: 'MOVE', move: humanMove }));
        const fixed = await next('STATE');
        expect(fixed.state.history).toHaveLength(2);
        expect(fixed.state.history[1]).toEqual(humanMove);
        await until(async () => (await (await fetch(`${testEnv.httpUrl}/health`)).json()).jev.waitingMatches === 1);
        expect(messages.some(message => message.type === 'ERROR')).toBe(false);
        expect((await (await fetch(`${testEnv.httpUrl}/health`)).json()).jev).toMatchObject({
          matchRecoveryPolicy: 'preserve-v1', waitingMatches: 1,
        });
        messages.length = 0;

        if (departure === 'resign') {
          socket.send(JSON.stringify({ type: 'RESIGN' }));
          await next('OPPONENT_LEFT');
        } else {
          socket.terminate();
          socket = undefined;
        }
        await until(async () => {
          const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
          return health.rooms === 0 && health.jev.waitingMatches === 0;
        });
        await pause(300);
        expect(messages.some(message => ['ERROR', 'STATE', 'MATCH_RESULT'].includes(message.type))).toBe(false);

        const gameRecord = await until(async () => {
          const files = (await readdir(join(testEnv.tempDir, 'game-records'))).filter(file => file.endsWith('.json'));
          if (!files.length) return null;
          return JSON.parse(await readFile(join(testEnv.tempDir, 'game-records', files[0]!), 'utf8'));
        });
        expect(gameRecord).toMatchObject({ reason: 'jev_recovery_player_left', moves: fixed.state.history });
        expect(gameRecord.moves).toHaveLength(2);
        const profiles = JSON.parse(await readFile(testEnv.profileDataFile, 'utf8')) as Array<{ playerId: string; rating: number }>;
        expect(profiles.find(profile => profile.playerId === identity.profile.playerId)?.rating).toBe(1200);
        expect(profiles.find(profile => profile.playerId === 'ranked-bot-jev')?.rating).toBe(1200);
      } finally {
        socket?.terminate();
        await testEnv.cleanup();
      }
    },
    60_000,
  );

  it.each(['503', 'network', 'provider-alias'] as const)('recovers a single %s failure inside the same turn and applies exactly one JEV move', async (failure) => {
    const testEnv = await startTestServer({ failOnce: failure });
    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(testEnv.url);
      const messages: WsMessage[] = [];
      socket.on('message', raw => messages.push(JSON.parse(String(raw))));
      const next = (type: string) => until(() => messages.find(message => message.type === type));
      await until(() => socket!.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'HELLO' }));
      await next('IDENTITY');
      socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
      const matchFound = await next('MATCH_FOUND');
      expect(matchFound.opponent.name).toBe('침착맨이할때까지');
      const update = await next('STATE');
      expect(update.state.history).toHaveLength(1);
      expect(applyMove(matchFound.state, update.state.history[0])).toEqual(update.state);
      expect(messages.filter(message => message.type === 'STATE')).toHaveLength(1);
      expect(messages.some(message => ['ERROR', 'OPPONENT_LEFT', 'MATCH_RESULT'].includes(message.type))).toBe(false);
      const traces = await until(async () => {
        const files = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter(file => file.endsWith('.json'));
        const records = await Promise.all(files.map(async file => JSON.parse(await readFile(join(testEnv.tempDir, 'jev-decisions', file), 'utf8'))));
        return records.length === 1 && records[0]?.status === 'applied' ? records : null;
      });
      const applied = traces[0];
      const retriedStage = applied.stages.find((stage: any) => stage.attempts?.length === 2);
      expect(retriedStage).toBeDefined();
      expect(retriedStage.attempts[0]).toMatchObject({ attempt: 1,
        error: failure === 'provider-alias' ? 'provider_unavailable' : 'http_error' });
      expect(retriedStage.attempts[0].httpStatus).toBe(
        failure === '503' ? 503 : failure === 'provider-alias' ? 400 : undefined,
      );
      expect(retriedStage.attempts[1]).toMatchObject({ attempt: 2, result: { cost: 0 } });
      expect(retriedStage.error).toBeUndefined();
      expect(retriedStage.result).toEqual(retriedStage.attempts[1].result);
      expect(applied.selection.id).toBe(jevMoveId(update.state.history[0]));
      expect(applied.recovery.attempt).toBe(1);
      const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
      expect(health.jev).toMatchObject({ acceptingMatches: true, reason: null, turns: 1,
        successfulMoves: 1, failures: 0, attempts: 1, attemptFailures: 0, retries: 0,
        recoveredTurns: 0, waitingMatches: 0, matchRecoveryPolicy: 'preserve-v1' });
      const profiles = JSON.parse(await readFile(testEnv.profileDataFile, 'utf8'));
      expect(profiles.find((profile: any) => profile.playerId === 'ranked-bot-jev').rating).toBe(1200);
      expect(testEnv.output()).not.toContain('mock-test-key-safe');
    } finally { socket?.terminate(); await testEnv.cleanup(); }
  }, 60_000);

  it.each([400, 403])('preserves generic HTTP %i through the worker and does not retry a misleading 503 response body', async (status) => {
    const testEnv = await startTestServer({ mockStatus: status });
    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(testEnv.url);
      const messages: WsMessage[] = [];
      socket.on('message', raw => messages.push(JSON.parse(String(raw))));
      await until(() => socket!.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'HELLO' }));
      await until(() => messages.find(message => message.type === 'IDENTITY'));
      socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
      await until(() => messages.find(message => message.type === 'OPPONENT_LEFT'));
      expect(messages.some(message => message.type === 'ERROR')).toBe(false);
      const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
      expect(health.jev).toMatchObject({ acceptingMatches: false, reason: `http_${status}`, attempts: 1,
        retries: 0, failures: 1, lastError: { status, retryable: false } });
      expect(messages.some(message => ['STATE', 'MATCH_RESULT'].includes(message.type))).toBe(false);
      const files = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter(file => file.endsWith('.json'));
      expect(files).toHaveLength(1);
      const trace = JSON.parse(await readFile(join(testEnv.tempDir, 'jev-decisions', files[0]!), 'utf8'));
      expect(trace.errorStatus).toBe(status);
      expect(trace.stages[0].httpStatus).toBe(status);
      expect(trace.stages[0].response.status).toBe(503);
      messages.length = 0;
      socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
      const fallback = await until(() => messages.find(message => message.type === 'MATCH_FOUND'));
      expect(fallback.opponent.isBot).toBe(true);
      expect(fallback.opponent.name).not.toBe('침착맨이할때까지');
    } finally { socket?.terminate(); await testEnv.cleanup(); }
  }, 35_000);

  it(
    'executes a complete legal opening move at delay 0 and saves applied trace with matching hashes and 2 API stages',
    async () => {
      const testEnv = await startTestServer({ mockDelayMs: 0 });
      let socket: WebSocket | undefined;

      try {
        socket = new WebSocket(testEnv.url);
        const messages: WsMessage[] = [];

        socket.on('message', (raw) => {
          messages.push(JSON.parse(String(raw)));
        });

        const next = (type: string, timeoutMs = 20000) =>
          until(() => {
            const idx = messages.findIndex((m) => m.type === type);
            return idx >= 0 ? messages.splice(idx, 1)[0] : undefined;
          }, timeoutMs);

        await until(() => socket!.readyState === WebSocket.OPEN);

        socket.send(JSON.stringify({ type: 'HELLO' }));
        await next('IDENTITY');

        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        const matchFound = await next('MATCH_FOUND');
        expect(matchFound.opponent.name).toBe('침착맨이할때까지');

        // Wait for JEV's move (STATE message)
        const stateMsg = await next('STATE', 20000);
        const newState = stateMsg.state;

        // Verify history length is 1 (one move completed)
        expect(newState.history).toHaveLength(1);

        const init = initialState(DEFAULT_CONFIG);
        const legals = legalMoves(init, DEFAULT_CONFIG);
        const movePlayed = newState.history[0];

        // Move matches a legal move from initial state and applying it matches state exactly
        expect(legals).toContainEqual(movePlayed);
        expect(applyMove(init, movePlayed)).toEqual(newState);

        // Verify preserved applied JEV decision trace in storage
        const decisionFiles = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter((f) =>
          f.endsWith('.json'),
        );
        expect(decisionFiles).toHaveLength(1);

        const trace = JSON.parse(
          await readFile(join(testEnv.tempDir, 'jev-decisions', decisionFiles[0]!), 'utf8'),
        );

        expect(trace.status).toBe('applied');
        expect(trace.selection?.id).toBe(jevMoveId(movePlayed));
        expect(trace.expectedAfterHash).toBe(trace.appliedStateHash);
        expect(trace.appliedStateHash).toBe(jevStateHash(newState));

        // 2 API stages: proposal (6 choice + 5 boolean) and final
        expect(trace.stages).toHaveLength(2);

        // Stage 1: proposals
        const stage1Questions = trace.stages[0].request.questions;
        const choices = Object.values(stage1Questions).filter((q: any) => q.type === 'choice');
        const booleans = Object.values(stage1Questions).filter((q: any) => q.type === 'boolean');
        expect(choices).toHaveLength(6);
        expect(booleans).toHaveLength(5);

        // Stage 2: final
        const stage2Questions = trace.stages[1].request.questions;
        expect(Object.keys(stage2Questions)).toEqual(['move']);
        expect(stage2Questions.move.type).toBe('choice');

        // Raw secrets not exposed in trace, messages, or server logs
        expect(JSON.stringify(trace)).not.toContain('mock-test-key-safe');
        expect(JSON.stringify(messages)).not.toContain('mock-test-key-safe');
        expect(testEnv.output()).not.toContain('mock-test-key-safe');
      } finally {
        socket?.terminate();
        await testEnv.cleanup();
      }
    },
    35000,
  );
});
