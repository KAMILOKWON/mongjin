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
  side?: string;
  state?: any;
  opponent?: any;
  profile?: any;
  winner?: string;
  reason?: string;
  message?: string;
}

const mockPreloadScript = `
import { existsSync, writeFileSync } from 'node:fs';
const originalDateNow = Date.now;
const realStart = originalDateNow();
const fixedSept20 = Date.parse('2026-09-20T12:00:00+09:00');
Date.now = () => fixedSept20 + (originalDateNow() - realStart);

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
  }
  const forcedStatus = Number(process.env.MOCK_JEV_HTTP_STATUS || '0');
  if (forcedStatus || failOnce) {
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
  output: () => string;
  cleanup: () => Promise<void>;
}

async function startTestServer(options: {
  mock503?: boolean;
  mockStatus?: number;
  failOnce?: '503' | 'network';
  mockDelayMs?: number;
}): Promise<SpawnedTestServer> {
  const tempDir = await mkdtemp(join(tmpdir(), 'jev-ranked-test-'));
  const mockScriptPath = join(tempDir, 'mock.mjs');
  await writeFile(mockScriptPath, mockPreloadScript, 'utf8');

  const profileDataFile = join(tempDir, 'profiles.json');
  // Seed the existing ranked bots with rating 100.
  const seededBots = RANKED_BOTS.map((bot) => ({
    playerId: bot.id,
    token: `token-${bot.id}`,
    name: bot.name,
    wins: 0,
    losses: 0,
    rating: 100,
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
      MOCK_JEV_HTTP_STATUS: String(options.mockStatus ?? (options.mock503 ? 503 : 0)),
      MOCK_JEV_FAIL_ONCE_PATH: options.failOnce ? join(tempDir, 'gateway-failed-once') : '',
      MOCK_JEV_FAILURE_KIND: options.failOnce ?? '',
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
    output: () => serverOutput,
    cleanup,
  };
}

describe('JEV Ranked WebSocket Integration', () => {
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
    'bounds repeated 503 retries, preserves every failed attempt without Elo changes, and reopens matching automatically',
    async () => {
      // Separate server for failure scenario
      const testEnv = await startTestServer({ mock503: true });
      let socket: WebSocket | undefined;

      try {
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

        socket.send(JSON.stringify({ type: 'HELLO' }));
        const identity = await next('IDENTITY');
        expect(identity.profile.rating).toBe(1200);

        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        const matchFound = await next('MATCH_FOUND');
        expect(matchFound.opponent.name).toBe('침착맨이할때까지');

        // JEV opening move runs, encounters 503 gateway error, and abandons match
        const errorMsg = await next('ERROR');
        expect(errorMsg.message).toContain('JEV 실험 대국을 중단했습니다');

        const opponentLeft = await next('OPPONENT_LEFT');
        expect(opponentLeft).toBeDefined();

        // Ensure NO MATCH_RESULT message is ever emitted
        await pause(600);
        expect(messages.some((m) => m.type === 'MATCH_RESULT')).toBe(false);

        // Verify NO Elo change occurred
        const profilesJson = JSON.parse(
          await readFile(testEnv.profileDataFile, 'utf8'),
        ) as Array<{ playerId: string; rating: number }>;
        const humanStored = profilesJson.find(
          (p) => p.playerId === identity.profile.playerId,
        );
        expect(humanStored?.rating).toBe(1200);

        const jevStored = profilesJson.find((p) => p.playerId === 'ranked-bot-jev');
        expect(jevStored?.rating).toBe(1200);

        // Verify preserved game record trace
        const gameRecordFiles = await readdir(join(testEnv.tempDir, 'game-records'));
        const jsonGameFiles = gameRecordFiles.filter((f) => f.endsWith('.json'));
        expect(jsonGameFiles.length).toBeGreaterThan(0);

        const gameRecord = JSON.parse(
          await readFile(
            join(testEnv.tempDir, 'game-records', jsonGameFiles[0]!),
            'utf8',
          ),
        );
        expect(gameRecord.reason).toMatch(/^jev_/);
        expect(gameRecord.reason).toBe('jev_http_error');
        // No board advance
        expect(gameRecord.moves).toEqual([]);

        // Verify preserved JEV decision trace
        const decisionFiles = await readdir(join(testEnv.tempDir, 'jev-decisions'));
        const jsonDecisionFiles = decisionFiles.filter((f) => f.endsWith('.json'));
        expect(jsonDecisionFiles.length).toBeGreaterThan(0);

        const decisionRecord = JSON.parse(
          await readFile(
            join(testEnv.tempDir, 'jev-decisions', jsonDecisionFiles[0]!),
            'utf8',
          ),
        );
        expect(decisionRecord.status).toBe('error');
        expect(decisionRecord.error).toBe('http_error');
        expect(jsonDecisionFiles).toHaveLength(3);
        for (const file of jsonDecisionFiles) {
          const attempt = JSON.parse(await readFile(join(testEnv.tempDir, 'jev-decisions', file), 'utf8'));
          expect(attempt.errorStatus).toBe(503);
          expect(attempt.stages[0].httpStatus).toBe(503);
          expect(attempt.ply).toBe(0);
        }
        const stopped = await (await fetch(`${testEnv.httpUrl}/health`)).json();
        expect(stopped.jev).toMatchObject({ acceptingMatches: false, reason: 'transient_cooldown',
          attempts: 3, retries: 2, failures: 1, attemptFailures: 3,
          lastError: { status: 503, retryable: true } });
        expect(stopped.jev.retryAfterMs).toBeGreaterThan(0);
        await until(async () => (await (await fetch(`${testEnv.httpUrl}/health`)).json()).jev.acceptingMatches, 20_000);
        socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
        const recoveredMatch = await next('MATCH_FOUND');
        expect(recoveredMatch.opponent.name).toBe('침착맨이할때까지');
      } finally {
        socket?.terminate();
        await testEnv.cleanup();
      }
    },
    35000,
  );

  it.each(['503', 'network'] as const)('recovers a single %s failure inside the same turn and applies exactly one JEV move', async (failure) => {
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
      expect((await next('MATCH_FOUND')).opponent.name).toBe('침착맨이할때까지');
      const update = await next('STATE');
      expect(update.state.history).toHaveLength(1);
      expect(messages.filter(message => message.type === 'STATE')).toHaveLength(1);
      expect(messages.some(message => ['ERROR', 'OPPONENT_LEFT', 'MATCH_RESULT'].includes(message.type))).toBe(false);
      const traces = await until(async () => {
        const files = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter(file => file.endsWith('.json'));
        const records = await Promise.all(files.map(async file => JSON.parse(await readFile(join(testEnv.tempDir, 'jev-decisions', file), 'utf8'))));
        return records.length === 2 && records.some(record => record.status === 'applied') ? records : null;
      });
      const failed = traces.find(trace => trace.status === 'error');
      const applied = traces.find(trace => trace.status === 'applied');
      expect(failed.error).toBe('http_error');
      expect(failed.errorStatus).toBe(failure === '503' ? 503 : undefined);
      expect(failed.stateHash).toBe(applied.stateHash);
      expect(applied.selection.id).toBe(jevMoveId(update.state.history[0]));
      expect(applied.recovery.attempt).toBe(2);
      const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
      expect(health.jev).toMatchObject({ acceptingMatches: true, reason: null, turns: 1,
        successfulMoves: 1, failures: 0, attempts: 2, attemptFailures: 1, retries: 1, recoveredTurns: 1 });
      const profiles = JSON.parse(await readFile(testEnv.profileDataFile, 'utf8'));
      expect(profiles.find((profile: any) => profile.playerId === 'ranked-bot-jev').rating).toBe(1200);
      expect(testEnv.output()).not.toContain('mock-test-key-safe');
    } finally { socket?.terminate(); await testEnv.cleanup(); }
  }, 35_000);

  it('preserves actual HTTP 403 through the worker and does not retry a misleading 503 response body', async () => {
    const testEnv = await startTestServer({ mockStatus: 403 });
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
      const health = await (await fetch(`${testEnv.httpUrl}/health`)).json();
      expect(health.jev).toMatchObject({ acceptingMatches: false, reason: 'http_403', attempts: 1,
        retries: 0, failures: 1, lastError: { status: 403, retryable: false } });
      expect(messages.some(message => ['STATE', 'MATCH_RESULT'].includes(message.type))).toBe(false);
      const files = (await readdir(join(testEnv.tempDir, 'jev-decisions'))).filter(file => file.endsWith('.json'));
      expect(files).toHaveLength(1);
      const trace = JSON.parse(await readFile(join(testEnv.tempDir, 'jev-decisions', files[0]!), 'utf8'));
      expect(trace.errorStatus).toBe(403);
      expect(trace.stages[0].httpStatus).toBe(403);
      expect(trace.stages[0].response.status).toBe(503);
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
