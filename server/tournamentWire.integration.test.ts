import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { initialState, legalMoves } from '../src/core/rules';
import { DEFAULT_CONFIG } from '../src/core/config';
import type { TournamentSnapshot } from '../src/net/tournamentProtocol';

const serverDir = dirname(fileURLToPath(import.meta.url));
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Local tournament response timed out');
}
async function launch(path: string, times: { start: number; cutoff: number; end: number }) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: '', MONGJIN_PUSH_ENABLED: '0', MONGJIN_MATCH_PUSH_ENABLED: '0', HOST: '127.0.0.1', PORT: '0',
      MONGJIN_PROFILE_DATA_FILE: path, MONGJIN_COMMUNITY_DATA_FILE: join(dirname(path), 'community.json'),
      MONGJIN_TOURNAMENT_ID: 'wire210', MONGJIN_TOURNAMENT_STARTS_AT: String(times.start),
      MONGJIN_TOURNAMENT_REGISTRATION_STARTS_AT: '0', MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT: String(times.cutoff),
      MONGJIN_TOURNAMENT_ENDS_AT: String(times.end), MONGJIN_TOURNAMENT_MIN_PARTICIPANTS: '2',
      MONGJIN_TOURNAMENT_MIN_RANKED_MATCHES: '3', MONGJIN_TOURNAMENT_ELO_K: '32', MONGJIN_TOURNAMENT_ELO_SCALE: '400',
      MONGJIN_TOURNAMENT_STARTING_SCORE: '0', MONGJIN_TOURNAMENT_MATCH_COUNTDOWN_MS: '5000', MONGJIN_TOURNAMENT_DATA_FILE: '',
      MONGJIN_TOURNAMENT_NEXT_ID: '', MONGJIN_TOURNAMENT_NEXT_STARTS_AT: '', MONGJIN_TOURNAMENT_NEXT_ENDS_AT: '', },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error('Local test server exited: ' + output);
    return output.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  return { child, url };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await ended;
}
function peer(url: string, platform: 'toss' | 'mobile') {
  const ws = new WebSocket(url, { headers: platform === 'toss' ? { Origin: 'https://appintoss.example.test' } : { 'User-Agent': 'Expo React-Native Test' } });
  const messages: Record<string, any>[] = [];
  let snapshot: TournamentSnapshot | undefined;
  ws.on('message', raw => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (message.type === 'TOURNAMENT_SNAPSHOT') snapshot = message.snapshot;
  });
  return {
    ws, get snapshot() { return snapshot; },
    async send(message: object) { await until(() => ws.readyState === WebSocket.OPEN ? true : undefined); ws.send(JSON.stringify(message)); },
    async command(message: object) { await this.send({ ...message, protocolVersion: 2, tournamentId: 'wire210' }); },
    next(type: string) { return until(() => {
      const index = messages.findIndex(message => message.type === type);
      return index < 0 ? undefined : messages.splice(index, 1)[0];
    }); },
  };
}

it('shares a human queue across Toss/mobile, enforces the server countdown, and restores event Elo separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-tournament-wire-'));
  const now = Date.now();
  const times = { cutoff: now + 3_000, start: now + 4_000, end: now + 3_600_000 };
  const path = join(dir, 'profiles.json');
  let server = await launch(path, times);
  const sockets: WebSocket[] = [];
  try {
    const toss = peer(server.url, 'toss'), mobile = peer(server.url, 'mobile');
    sockets.push(toss.ws, mobile.ws);
    await toss.send({ type: 'HELLO' }); const a = await toss.next('IDENTITY');
    await mobile.send({ type: 'HELLO' }); const b = await mobile.next('IDENTITY');
    await toss.send({ type: 'TOURNAMENT_STATUS' });
    expect((await toss.next('TOURNAMENT_ERROR')).code).toBe('UPDATE_REQUIRED');
    await toss.command({ type: 'TOURNAMENT_REGISTER' });
    await mobile.command({ type: 'TOURNAMENT_REGISTER' });
    await until(() => toss.snapshot?.registered && mobile.snapshot?.registered ? true : undefined);
    expect(toss.snapshot?.status).toBe('idle');
    await until(() => toss.snapshot?.phase === 'active' ? true : undefined);
    await toss.command({ type: 'TOURNAMENT_JOIN' });
    await mobile.command({ type: 'TOURNAMENT_JOIN' });
    await until(() => toss.snapshot?.match?.status === 'preparing' && mobile.snapshot?.match?.status === 'preparing' ? true : undefined);
    const matchId = toss.snapshot!.match!.id;
    expect(mobile.snapshot!.match!.id).toBe(matchId);
    expect(toss.snapshot!.match!.turnDeadline).toBeNull();
    await toss.command({ type: 'TOURNAMENT_READY', matchId });
    await mobile.command({ type: 'TOURNAMENT_READY', matchId });
    await until(() => toss.snapshot?.match?.status === 'countdown' ? true : undefined);
    const countdown = toss.snapshot!;
    expect(countdown.match!.startsAt! - countdown.serverNow).toBeGreaterThanOrEqual(4_900);
    expect(countdown.match!.turnDeadline).toBeNull();
    await toss.command({ type: 'TOURNAMENT_MOVE', matchId, ply: 0, move: legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0] });
    expect((await toss.next('TOURNAMENT_ERROR')).code).toBe('NOT_READY');
    expect(toss.snapshot?.match?.state.history).toHaveLength(0);
    await until(() => toss.snapshot?.match?.status === 'playing' && mobile.snapshot?.match?.status === 'playing' ? true : undefined);
    expect(toss.snapshot!.match!.turnDeadline! - toss.snapshot!.serverNow).toBeGreaterThan(29_000);
    await toss.command({ type: 'TOURNAMENT_RESIGN', matchId });
    await until(() => toss.snapshot?.status === 'result' && mobile.snapshot?.status === 'result' ? true : undefined);
    expect(toss.snapshot!.myStanding).toMatchObject({ points: -16, losses: 1, games: 1, qualified: false });
    expect(mobile.snapshot!.myStanding).toMatchObject({ points: 16, wins: 1, games: 1 });
    await toss.send({ type: 'GET_PROFILE' });
    expect((await toss.next('PROFILE')).profile).toMatchObject({ rating: 1200, wins: 0, losses: 0 });
    await mobile.command({ type: 'TOURNAMENT_NEXT' });
    await until(() => mobile.snapshot?.status === 'queued' ? true : undefined);
    expect(toss.snapshot!.status).toBe('result');
    await stop(server.child);
    server = await launch(path, times);
    for (const [identity, platform, score] of [[a, 'toss', -16], [b, 'mobile', 16]] as const) {
      const restored = peer(server.url, platform); sockets.push(restored.ws);
      await restored.send({ type: 'HELLO', playerId: identity.playerId, token: identity.token });
      await restored.next('IDENTITY');
      await restored.command({ type: 'TOURNAMENT_STATUS' });
      await until(() => restored.snapshot?.myStanding ? true : undefined);
      expect(restored.snapshot!.myStanding).toMatchObject({ points: score, games: 1 });
      expect(restored.snapshot!.status).toBe('idle');
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    await stop(server.child);
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);
