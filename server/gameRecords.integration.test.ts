import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Player } from '../src/core/types';
import { FileGameRecordStore, replayRecord, trainingRecord, type GameRecord } from './gameRecords';

const serverDir = dirname(fileURLToPath(import.meta.url));
let child: ChildProcess;
let dir: string;
let url: string;
const sockets: WebSocket[] = [];
let logs = '';
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until<T>(fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const result = await fn(); if (result) return result as NonNullable<T>; await delay(); }
  throw new Error(`Timed out. Server output: ${logs}`);
}
function client() {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const messages: any[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  return {
    ws,
    async send(message: object) { await until(() => ws.readyState === ws.OPEN); ws.send(JSON.stringify(message)); },
    async next(type: string): Promise<any> {
      return until(() => { const i = messages.findIndex((m) => m.type === type); return i >= 0 ? messages.splice(i, 1)[0] : undefined; });
    },
  };
}
async function allRecords() {
  const result: GameRecord[] = [];
  for await (const record of new FileGameRecordStore(join(dir, 'game-records')).records()) result.push(record);
  return result;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mongjin-record-integration-'));
  child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir, env: { ...process.env, DATABASE_URL: '', HOST: '127.0.0.1', PORT: '0', MONGJIN_PROFILE_DATA_FILE: join(dir, 'profiles.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (data) => { logs += data; });
  child.stderr!.on('data', (data) => { logs += data; });
  url = await until(() => logs.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]);
}, 15000);
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('실제 빠른 대전: 불법 수 제외, 시작 Elo 고정, 항복 저장과 CLI 내보내기', async () => {
  const a = client(), b = client();
  await a.send({ type: 'HELLO' }); await a.next('IDENTITY');
  await b.send({ type: 'HELLO' }); await b.next('IDENTITY');
  await a.send({ type: 'MATCHMAKE' }); await a.next('PROFILE');
  await b.send({ type: 'MATCHMAKE' });
  const found = await a.next('MATCH_FOUND'); await b.next('MATCH_FOUND');
  const black = found.side === 'BLACK' ? a : b;
  const white = found.side === 'BLACK' ? b : a;
  await black.send({ type: 'MOVE', move: { kind: 'PLACE', to: { r: 99, c: 99 } } });
  await black.next('ERROR');
  const move = legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
  await black.send({ type: 'MOVE', move });
  const state = (await black.next('STATE')).state;
  await white.next('STATE');
  await white.send({ type: 'RESIGN' });
  await black.next('MATCH_RESULT');
  const game = await until(async () => (await allRecords()).find((r) => r.kind === 'random' && r.status === 'completed'));
  expect(game.moves).toEqual([move]);
  expect(game.players.BLACK.rating).toBe(1200);
  expect(game.players.WHITE.rating).toBe(1200);
  expect(game.reason).toBe('resign');
  expect(game.winner).toBe('BLACK');
  expect(replayRecord(game)).toEqual(state);
  expect(trainingRecord(game, { minElo: 1200, both: true, includeBots: false, includeForfeits: false })).toBeNull();
  const out = join(dir, 'training.jsonl');
  const exporter = spawn(process.execPath, ['--import', 'tsx', 'exportGames.ts', '--min-elo', '1200', '--both', '--include-forfeits', '--out', out], {
    cwd: serverDir, env: { ...process.env, DATABASE_URL: '', MONGJIN_PROFILE_DATA_FILE: join(dir, 'profiles.json') }, stdio: 'pipe',
  });
  const code = await new Promise((resolve) => exporter.on('exit', resolve));
  expect(code).toBe(0);
  const exported = JSON.parse((await readFile(out, 'utf8')).trim());
  expect(exported.moves).toEqual([move]);
  expect(exported.eligibleSides).toEqual(['BLACK', 'WHITE']);
  expect(exported).not.toHaveProperty('token');
}, 15000);

it('친구 대전을 실제 합법 수로 끝내고 전체 기보를 재생한다', async () => {
  const a = client(), b = client();
  await a.send({ type: 'HELLO' }); await a.next('IDENTITY');
  await b.send({ type: 'HELLO' }); await b.next('IDENTITY');
  await a.send({ type: 'CREATE' }); const created = await a.next('CREATED');
  await b.send({ type: 'JOIN', roomId: created.roomId });
  await b.next('JOINED'); await a.next('STATE');
  await a.next('MATCH_FOUND'); await b.next('MATCH_FOUND');
  let state: GameState = created.state;
  // Cooperative legal king route: black advances; white shuttles along its back rank.
  for (let ply = 0; ply < 30; ply++) {
    const side: Player = state.turn;
    const moves = legalMoves(state, DEFAULT_CONFIG);
    const move = side === 'BLACK'
      ? moves.find((m) => m.kind === 'MOVE' && m.to.r === m.from.r - 1)
      : moves.find((m) => m.kind === 'MOVE' && m.to.r === m.from.r);
    expect(move).toBeDefined();
    await (side === 'BLACK' ? a : b).send({ type: 'MOVE', move });
    state = (await a.next('STATE')).state;
    await b.next('STATE');
    const { getResult } = await import('../src/core/result');
    if (getResult(state, DEFAULT_CONFIG)) break;
  }
  const game = await until(async () => (await allRecords()).find((r) => r.kind === 'friend' && r.status === 'completed'));
  expect(replayRecord(game)).toEqual(state);
  expect(game.reason).toBe('goal');
  expect(trainingRecord(game, { minElo: 1200, both: true, includeBots: false, includeForfeits: false })).not.toBeNull();
}, 15000);

it('매칭 후 착수 전 연결 종료도 상대의 기권승으로 저장한다', async () => {
  const a = client(), b = client();
  await a.send({ type: 'HELLO' }); await a.next('IDENTITY');
  await b.send({ type: 'HELLO' }); await b.next('IDENTITY');
  await a.send({ type: 'MATCHMAKE' }); await a.next('PROFILE');
  await b.send({ type: 'MATCHMAKE' }); await a.next('MATCH_FOUND'); const found = await b.next('MATCH_FOUND');
  a.ws.close();
  expect(await b.next('MATCH_RESULT')).toMatchObject({ winner: found.side, reason: 'forfeit' });
  const game = await until(async () => (await allRecords()).find((r) => r.kind === 'random' && r.status === 'completed' && r.reason === 'disconnect'));
  expect(game.moves).toEqual([]);
  expect(game.reason).toBe('disconnect');
  expect(game.winner).toBe(found.side);
});

it('서버 봇 대국은 사람과 봇 진영을 구분하고 착수 후 종료를 저장한다', async () => {
  const a = client();
  await a.send({ type: 'HELLO' }); await a.next('IDENTITY');
  await a.send({ type: 'MATCHMAKE_BOT' });
  const found = await a.next('MATCH_FOUND');
  let state: GameState = found.state;
  if (state.turn !== found.side) state = (await a.next('STATE')).state;
  const move = legalMoves(state, DEFAULT_CONFIG)[0]!;
  await a.send({ type: 'MOVE', move });
  state = (await a.next('STATE')).state;
  await a.send({ type: 'RESIGN' }); await a.next('MATCH_RESULT');
  const game = await until(async () => (await allRecords()).find((r) => r.kind === 'bot' && r.status === 'completed'));
  const humanSide = found.side as Player;
  expect(game.players[humanSide]).toEqual({ kind: 'human', rating: 1200 });
  expect(game.players[humanSide === 'BLACK' ? 'WHITE' : 'BLACK'].kind).toBe('bot');
  expect(replayRecord(game).history.slice(0, state.history.length)).toEqual(state.history);
  expect(trainingRecord(game, { minElo: 0, both: false, includeBots: false, includeForfeits: true })).toBeNull();
  expect(trainingRecord(game, { minElo: 0, both: false, includeBots: true, includeForfeits: true })?.eligibleSides).toEqual([humanSide]);
}, 15000);


it('고정 봇은 랭킹에 나타나고 사람과의 승패가 양쪽에 반영되며 다음 상대가 바뀐다', async () => {
  const a = client();
  await a.send({ type: 'HELLO' }); await a.next('IDENTITY');
  await a.send({ type: 'MATCHMAKE_BOT' });
  const found = await a.next('MATCH_FOUND');
  const { RANKED_BOTS } = await import('./rankedBots');
  expect(RANKED_BOTS.map((bot) => bot.name)).toContain(found.opponent.name);
  const boardUrl = url.replace('ws:', 'http:') + '/leaderboard';
  const before = await (await fetch(boardUrl)).json() as any;
  const row = before.entries.find((entry: any) => entry.name === found.opponent.name);
  expect(row.rating).toBe(found.opponent.rating);
  expect(row).not.toHaveProperty('botLearning');
  expect(row).not.toHaveProperty('token');
  await a.send({ type: 'RESIGN' });
  const result = await a.next('MATCH_RESULT');
  expect(result.profile.losses).toBe(1);
  const after = await (await fetch(boardUrl)).json() as any;
  const updated = after.entries.find((entry: any) => entry.name === found.opponent.name);
  expect(updated.wins).toBe(row.wins + 1);
  expect(updated.rating).toBeGreaterThan(row.rating);
  await a.send({ type: 'MATCHMAKE_BOT' });
  const rematch = await a.next('MATCH_FOUND');
  expect(rematch.opponent.name).not.toBe(found.opponent.name);
  await a.send({ type: 'RESIGN' }); await a.next('MATCH_RESULT');
}, 15000);
