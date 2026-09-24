import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';

const serverDir = dirname(fileURLToPath(import.meta.url));
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = await read(); if (result !== undefined) return result; await delay(); }
  throw new Error('서버 응답 시간 초과');
}
async function startServer(path: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir, env: { ...process.env, DATABASE_URL: '', HOST: '127.0.0.1', PORT: '0', MONGJIN_PROFILE_DATA_FILE: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  const url = await until(() => output.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0]);
  return { child, url, output: () => output };
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM'); await exited;
}
function connect(url: string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  return { ws,
    async send(payload: object) { await until(() => ws.readyState === WebSocket.OPEN ? true : undefined); ws.send(JSON.stringify(payload)); },
    next(type: string) { return until(() => {
      const index = messages.findIndex((message) => message.type === type);
      return index < 0 ? undefined : messages.splice(index, 1)[0];
    }); },
  };
}

it('인증된 첫 수 신호와 합법 MOVE만 기록하며 구버전 HELLO도 재시작 후 동일한 프로필을 받는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-first-move-wire-'));
  const path = join(dir, 'profiles.json');
  let server = await startServer(path);
  const sockets: WebSocket[] = [];
  try {
    const black = connect(server.url), white = connect(server.url), local = connect(server.url), unauthenticated = connect(server.url);
    sockets.push(black.ws, white.ws, local.ws, unauthenticated.ws);
    await unauthenticated.send({ type: 'FIRST_MOVE_PLAYED' });
    await unauthenticated.next('ERROR');
    await black.send({ type: 'HELLO' }); const blackIdentity = await black.next('IDENTITY');
    await white.send({ type: 'HELLO' }); const whiteIdentity = await white.next('IDENTITY');
    await local.send({ type: 'HELLO' }); const localIdentity = await local.next('IDENTITY');
    expect([blackIdentity, whiteIdentity, localIdentity].map((item) => item.profile.hasPlayedMove)).toEqual([false, false, false]);
    await black.send({ type: 'CREATE' }); const created = await black.next('CREATED');
    await white.send({ type: 'JOIN', roomId: created.roomId });
    await white.next('JOINED'); await black.next('STATE');
    await black.next('MATCH_FOUND'); await white.next('MATCH_FOUND');
    await black.send({ type: 'MOVE', move: { kind: 'PLACE', to: { r: 99, c: 99 } } });
    await black.next('ERROR');
    await black.send({ type: 'GET_PROFILE' }); expect((await black.next('PROFILE')).profile.hasPlayedMove).toBe(false);
    await black.send({ type: 'MOVE', move: legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0] });
    expect((await black.next('PROFILE')).profile.hasPlayedMove).toBe(true);
    const state = (await black.next('STATE')).state; await white.next('STATE');
    await white.send({ type: 'GET_PROFILE' }); expect((await white.next('PROFILE')).profile.hasPlayedMove).toBe(false);
    await white.send({ type: 'MOVE', move: legalMoves(state, DEFAULT_CONFIG)[0] });
    expect((await white.next('PROFILE')).profile.hasPlayedMove).toBe(true);
    await black.next('STATE'); await white.next('STATE');
    await local.send({ type: 'FIRST_MOVE_PLAYED', wins: 999, rating: 9999 });
    expect((await local.next('PROFILE')).profile).toMatchObject({ hasPlayedMove: true, wins: 0, losses: 0, rating: 1200 });
    await stopServer(server.child);
    server = await startServer(path);
    for (const identity of [blackIdentity, whiteIdentity, localIdentity]) {
      const oldClient = connect(server.url); sockets.push(oldClient.ws);
      await oldClient.send({ type: 'HELLO', playerId: identity.playerId, token: identity.token });
      expect((await oldClient.next('IDENTITY')).profile.hasPlayedMove).toBe(true);
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    await stopServer(server.child);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
