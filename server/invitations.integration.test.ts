import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { INVITATION_FEATURE } from '../src/net/invitationProtocol';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';

type Message = Record<string, any>;
type LeaderboardEntry = { playerId?: string; rank: number; presence?: string; name: string };
type LeaderboardPage = { totalPlayers: number; totalEntries?: number; entries: LeaderboardEntry[] };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, timeoutMs = 8_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value as NonNullable<T>;
    await pause(20);
  }
  throw new Error('초대 서버 통합 검증 시간 초과');
}

class Peer {
  readonly messages: Message[] = [];
  private readonly waiters: Array<{ match: (message: Message) => boolean; resolve: (message: Message) => void; timer: NodeJS.Timeout }> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Message;
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
      } else this.messages.push(message);
    });
  }

  send(message: Record<string, unknown>) { this.socket.send(JSON.stringify(message)); }

  next(type: string, predicate: (message: Message) => boolean = () => true, timeoutMs = 8_000): Promise<Message> {
    const match = (message: Message) => message.type === type && predicate(message);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          const pendingIndex = this.waiters.indexOf(waiter);
          if (pendingIndex >= 0) this.waiters.splice(pendingIndex, 1);
          reject(new Error(`서버 메시지 대기 시간 초과: ${type}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  count(type: string) { return this.messages.filter((message) => message.type === type).length; }
  close() { this.socket.terminate(); }
}

async function openPeer(url: string): Promise<Peer> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Peer(socket);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json() as Promise<T>;
}

function profile(playerId: string, name: string, rating: number) {
  const now = '2026-10-01T00:00:00.000Z';
  return { playerId, token: `token-${playerId}`, name, rating, wins: 0, losses: 0, createdAt: now, updatedAt: now };
}

function terminalMoveSequence(): Move[] {
  let state: GameState = initialState(DEFAULT_CONFIG);
  let random = 12;
  const next = () => { random = (random * 48_271) % 2_147_483_647; return random / 2_147_483_647; };
  const moves: Move[] = [];
  while (!getResult(state, DEFAULT_CONFIG) && moves.length < 100) {
    const legal = legalMoves(state, DEFAULT_CONFIG);
    if (!legal.length) break;
    const move = legal[Math.floor(next() * legal.length)]!;
    moves.push(move);
    state = applyMove(state, move);
  }
  if (!getResult(state, DEFAULT_CONFIG)) throw new Error('테스트용 종료 수순을 만들지 못했습니다');
  return moves;
}

it('handles HELLO/presence races, privacy, same-profile socket reservation, and ranked online pagination over loopback WebSocket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-invitation-loopback-'));
  const profileFile = join(dir, 'profiles.json');
  await writeFile(profileFile, JSON.stringify([
    profile('alice-id', 'Alice', 1300),
    profile('bob-id', 'Bob', 1800),
    profile('cara-id', 'Cara', 1400),
    profile('legacy-id', 'Legacy', 1250),
  ]));

  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: '', HOST: '127.0.0.1', PORT: '0', MONGJIN_PUSH_ENABLED: '0', MONGJIN_MATCH_PUSH_ENABLED: '0',
    MONGJIN_PROFILE_DATA_FILE: profileFile, MONGJIN_COMMUNITY_DATA_FILE: join(dir, 'community.json') };
  for (const key of Object.keys(env)) if (key.startsWith('MONGJIN_TOURNAMENT_')) delete env[key];
  const server: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDirectory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const peers: Peer[] = [];
  let output = '';
  server.stdout!.on('data', (chunk) => { output += chunk; });
  server.stderr!.on('data', (chunk) => { output += chunk; });

  try {
    const match = await until(() => output.match(/몽진 온라인 서버 — ws:\/\/127\.0\.0\.1:(\d+)/));
    const wsUrl = `ws://127.0.0.1:${match[1]}`;
    const httpUrl = `http://127.0.0.1:${match[1]}`;

    async function connect(playerId?: string, token?: string, features: string[] = [INVITATION_FEATURE], presenceFirst = true) {
      const peer = await openPeer(wsUrl);
      peers.push(peer);
      peer.send({ type: 'HELLO', ...(playerId ? { playerId } : {}), ...(token ? { token } : {}), features });
      if (presenceFirst) peer.send({ type: 'UPDATE_PRESENCE', state: 'idle' });
      const identity = await peer.next('IDENTITY');
      return { peer, identity };
    }

    const alice1 = await connect('alice-id', 'token-alice-id');
    const alice2 = await connect('alice-id', 'token-alice-id');
    const bob1 = await connect('bob-id', 'token-bob-id');
    const bob2 = await connect('bob-id', 'token-bob-id');
    const cara = await connect('cara-id', 'token-cara-id');
    const legacy = await connect('legacy-id', 'token-legacy-id', [], true);
    expect(await legacy.peer.next('INVITATION_ERROR')).toMatchObject({ code: 'INVALID_REQUEST' });

    // No stored identity: UPDATE_PRESENCE arrives while HELLO is saving the new profile.
    const dave = await connect(undefined, undefined, [INVITATION_FEATURE], true);
    const daveId = dave.identity.playerId as string;
    expect(daveId).toBeTruthy();

    const aliceProfile = alice1.identity.profile as { playerId: string };
    expect(aliceProfile.playerId).toBe('alice-id');
    alice1.peer.send({ type: 'MATCHMAKE' });
    await until(async () => (await getJson<{ queued: number }>(`${httpUrl}/health`)).queued === 1 && true);
    const beforeHide = await until(async () => {
      const page = await getJson<LeaderboardPage>(`${httpUrl}/leaderboard?online=1`);
      return page.entries.some((entry) => entry.playerId === 'alice-id' && entry.presence === 'matching') ? page : undefined;
    });
    expect(beforeHide.totalEntries).toBe(8); // Four foreground players and four available fixed profiles.

    alice1.peer.send({ type: 'SET_ONLINE_VISIBILITY', showOnline: false });
    expect(await alice1.peer.next('ONLINE_VISIBILITY')).toMatchObject({ showOnline: false });
    alice2.peer.send({ type: 'UPDATE_PROFILE', name: 'Ally' });
    await alice2.peer.next('PROFILE');
    const persistedProfiles = JSON.parse(await readFile(profileFile, 'utf8')) as Array<{ playerId: string; showOnline?: boolean }>;
    expect(persistedProfiles.find((item) => item.playerId === 'alice-id')?.showOnline).toBe(false);

    cara.peer.send({ type: 'SEND_INVITATION', playerId: 'alice-id' });
    expect(await cara.peer.next('INVITATION_ERROR')).toMatchObject({ code: 'UNAVAILABLE' });

    alice1.peer.send({ type: 'SEND_INVITATION', playerId: 'bob-id' });
    const incoming = await bob2.peer.next('INVITATION', (message) => message.direction === 'incoming');
    const invitationId = (incoming.invitation as { id: string }).id;
    await alice1.peer.next('INVITATION', (message) => message.direction === 'outgoing');
    expect(bob1.peer.count('INVITATION')).toBe(0);
    expect((await getJson<{ queued: number }>(`${httpUrl}/health`)).queued).toBe(1);

    // A heartbeat from the older socket refreshes its lease without taking ownership from bob2.
    bob1.peer.send({ type: 'UPDATE_PRESENCE', state: 'idle' });
    await pause(60);
    expect(alice1.peer.count('INVITATION_CLOSED')).toBe(0);
    bob1.peer.send({ type: 'RESPOND_INVITATION', invitationId, accept: true });
    expect(await bob1.peer.next('INVITATION_ERROR')).toMatchObject({ code: 'INVALID_REQUEST' });
    bob2.peer.send({ type: 'RESPOND_INVITATION', invitationId, accept: true });
    const aliceMatch = await alice1.peer.next('MATCH_FOUND');
    const bobMatch = await bob2.peer.next('MATCH_FOUND');
    expect(aliceMatch).toMatchObject({ matchKind: 'friend' });
    expect(bobMatch).toMatchObject({ matchKind: 'friend' });
    expect(await alice1.peer.next('QUEUE_LEFT')).toMatchObject({ type: 'QUEUE_LEFT' });
    await until(async () => (await getJson<{ queued: number }>(`${httpUrl}/health`)).queued === 0 && true);

    const duringGame = await getJson<LeaderboardPage>(`${httpUrl}/leaderboard?online=1&limit=100`);
    expect(duringGame.entries.find((entry) => entry.playerId === 'bob-id')?.presence).toBe('playing');
    bob1.peer.send({ type: 'CREATE' });
    expect(await bob1.peer.next('ERROR')).toMatchObject({ message: '이미 대기 중이거나 대국에 참가 중입니다' });
    expect(bob1.peer.count('CREATED')).toBe(0);

    // Finish the server-owned friend game, as the mobile leaveGame() flow does, then
    // keep the same authenticated socket and start a new friend wait.
    let state: GameState = initialState(DEFAULT_CONFIG);
    for (const move of terminalMoveSequence()) {
      const actor = state.turn === aliceMatch.side ? alice1.peer : bob2.peer;
      actor.send({ type: 'MOVE', move });
      state = applyMove(state, move);
      await alice1.peer.next('STATE');
      await bob2.peer.next('STATE');
    }
    expect(getResult(state, DEFAULT_CONFIG)).not.toBeNull();
    alice1.peer.send({ type: 'UPDATE_PRESENCE', state: 'idle' });
    bob2.peer.send({ type: 'UPDATE_PRESENCE', state: 'idle' });
    await until(async () => (await getJson<{ rooms: number }>(`${httpUrl}/health`)).rooms === 0 && true);
    bob1.peer.send({ type: 'CREATE' });
    expect(await bob1.peer.next('CREATED')).toMatchObject({ type: 'CREATED' });

    // The new waiting room reserves the profile across its sibling sockets too.
    bob2.peer.send({ type: 'CREATE' });
    expect(await bob2.peer.next('ERROR')).toMatchObject({ message: '이미 대기 중이거나 대국에 참가 중입니다' });
    expect(bob2.peer.count('CREATED')).toBe(0);

    const full = await getJson<LeaderboardPage>(`${httpUrl}/leaderboard?limit=100`);
    const online = await getJson<LeaderboardPage>(`${httpUrl}/leaderboard?online=1&limit=100`);
    const byId = new Map(full.entries.map((entry) => [entry.playerId, entry]));
    const onlineById = new Map(online.entries.map((entry) => [entry.playerId, entry]));
    expect(online.totalPlayers).toBe(full.totalPlayers);
    expect(online.totalEntries).toBe(7);
    expect(onlineById.get('bob-id')?.presence).toBe('matching');
    expect(onlineById.get('cara-id')?.presence).toBe('idle');
    expect(onlineById.get(daveId)?.presence).toBe('idle');
    expect(byId.get('legacy-id')?.presence).toBe('offline');
    expect(byId.get('alice-id')).toMatchObject({ presence: 'offline', name: 'Ally' });
    expect(online.entries.some((entry) => entry.playerId === 'alice-id' || entry.playerId === 'legacy-id')).toBe(false);
    expect(online.entries.filter(entry => entry.playerId?.startsWith('ranked-bot-'))).toHaveLength(4);
    expect(online.entries.every((entry) => !Object.hasOwn(entry, 'showOnline'))).toBe(true);
    for (const entry of online.entries) expect(entry.rank).toBe(byId.get(entry.playerId)?.rank);

    const pages = await Promise.all(Array.from({ length: 8 }, (_, offset) =>
      getJson<LeaderboardPage>(`${httpUrl}/leaderboard?online=1&limit=1&offset=${offset}`)));
    expect(pages.map((page) => page.totalEntries)).toEqual(Array(8).fill(7));
    expect(pages.slice(0, 7).map((page) => page.entries[0]?.playerId)).toEqual(online.entries.map((entry) => entry.playerId));
    expect(pages[7]!.entries).toEqual([]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nserver output:\n${output}`);
  } finally {
    for (const peer of peers) peer.close();
    if (server.exitCode === null) {
      const stopped = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await Promise.race([stopped, pause(10_000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
