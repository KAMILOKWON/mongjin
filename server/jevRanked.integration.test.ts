import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { legalMoves } from '../src/core/rules';
import { FileProfileRepository } from './profileRepository';
import { ensureRankedBots } from './rankedBots';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('retains the former JEV identity and plays locally even with stale credentials after experiment expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-retired-jev-'));
  let server: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let output = '';
  const until = async <T>(read: () => T | Promise<T>): Promise<NonNullable<T>> => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const value = await read();
      if (value) return value as NonNullable<T>;
      await pause(20);
    }
    throw new Error(`Local replacement timeout: ${output}`);
  };
  try {
    const dataPath = join(dir, 'profiles.json');
    const repo = new FileProfileRepository(dataPath);
    // Keep the converted bot nearest to the test player, avoiding probabilistic matching.
    for (const profile of await ensureRankedBots(repo)) {
      await repo.saveProfile({ ...profile, rating: profile.playerId === 'ranked-bot-jev' ? 1176 : 2400,
        wins: profile.playerId === 'ranked-bot-jev' ? 4 : 0,
        losses: profile.playerId === 'ranked-bot-jev' ? 9 : 0 });
    }
    const preload = join(dir, 'no-gateway.mjs');
    const externalCalls = join(dir, 'external-calls.txt');
    await writeFile(preload, `
import { appendFileSync } from 'node:fs';
Math.random = () => 0;
const originalNow = Date.now;
const offset = Date.parse('2026-10-01T00:00:00Z') - originalNow();
Date.now = () => originalNow() + offset;
globalThis.fetch = async () => {
  appendFileSync(process.env.TEST_EXTERNAL_CALLS, 'unexpected external request\\n');
  throw new Error('External model access is forbidden in a local bot match');
};
`);
    server = spawn(process.execPath, ['--import', preload, '--import', 'tsx', 'index.ts'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: '', DATABASE_URL: '', HOST: '127.0.0.1', PORT: '0',
        MONGJIN_PROFILE_DATA_FILE: dataPath, MONGJIN_JEV_ENABLED: '1',
        AI_GATEWAY_API_KEY: 'test-stale-key-do-not-use', TEST_EXTERNAL_CALLS: externalCalls },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', chunk => { output += chunk; });
    server.stderr!.on('data', chunk => { output += chunk; });
    const url = await until(() => output.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]);
    const health = await (await fetch(`${url.replace('ws:', 'http:')}/health`)).json();
    expect(health).toMatchObject({ botEngine: 'local-search-v1', jev: { acceptingMatches: false, reason: 'retired' } });
    socket = new WebSocket(url);
    const messages: any[] = [];
    const received: any[] = [];
    socket.on('message', raw => { const message = JSON.parse(String(raw)); messages.push(message); received.push(message); });
    const next = (type: string) => until(() => {
      const index = messages.findIndex(message => message.type === type);
      return index >= 0 ? messages.splice(index, 1)[0] : undefined;
    });
    await until(() => socket!.readyState === WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'HELLO' }));
    await next('IDENTITY');
    socket.send(JSON.stringify({ type: 'MATCHMAKE_BOT' }));
    const found = await next('MATCH_FOUND');
    expect(found.opponent).toMatchObject({ name: '침착맨이할때까지', rating: 1176 });
    expect(found.side).toBe('WHITE');
    let state = found.state;
    for (let turn = 0; turn < 3; turn++) {
      const update = await next('STATE');
      const move = update.state.history.at(-1);
      expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(move);
      expect(update.state).toEqual(applyMove(state, move));
      state = update.state;
      if (turn < 2) {
        const response = legalMoves(state, DEFAULT_CONFIG)[0]!;
        socket.send(JSON.stringify({ type: 'MOVE', move: response }));
        state = (await next('STATE')).state;
      }
    }
    socket.send(JSON.stringify({ type: 'RESIGN' }));
    expect(await next('MATCH_RESULT')).toMatchObject({ winner: 'BLACK', reason: 'forfeit' });
    const saved = await new FileProfileRepository(dataPath).loadProfiles();
    expect(saved.find(profile => profile.playerId === 'ranked-bot-jev')).toMatchObject({ name: '침착맨이할때까지', wins: 5, losses: 9 });
    expect(received.some(message => ['ERROR', 'OPPONENT_LEFT'].includes(message.type))).toBe(false);
    await expect(readFile(externalCalls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(output).not.toContain('[jev]');
  } finally {
    socket?.terminate();
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server!.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
