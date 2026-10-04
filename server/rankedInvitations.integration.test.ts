import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState } from '../src/core/types';
import { INVITATION_FEATURE, PRESENCE_REFRESH_MS } from '../src/net/invitationProtocol';
import { RANKED_BOTS } from './rankedBots';

type Message = Record<string, any>;
type LeaderboardEntry = {
  playerId: string;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  presence?: string;
};
type LeaderboardPage = { entries: LeaderboardEntry[]; totalEntries?: number };
type PresenceState = 'idle' | 'playing' | 'background';

const AUTO_ACCEPT_MAX_MS = 5_000;
const NO_AUTO_MATCH_WINDOW_MS = AUTO_ACCEPT_MAX_MS + 350;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value as NonNullable<T>;
    await pause(20);
  }
  throw new Error('랭킹 봇 초대 loopback 검증 시간 초과');
}

class Peer {
  readonly messages: Message[] = [];
  readonly received: Message[] = [];
  private readonly waiters: Array<{
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private presence: PresenceState = 'idle';
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Message;
      this.received.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
      } else this.messages.push(message);
    });
    socket.on('error', () => undefined);
    this.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) this.send({ type: 'UPDATE_PRESENCE', state: this.presence });
    }, Math.max(1_000, PRESENCE_REFRESH_MS - 1_000));
    this.heartbeat.unref();
  }

  send(message: Record<string, unknown>) { this.socket.send(JSON.stringify(message)); }

  setPresence(presence: PresenceState) {
    this.presence = presence;
    this.send({ type: 'UPDATE_PRESENCE', state: presence });
  }

  next(type: string, predicate: (message: Message) => boolean = () => true, timeoutMs = 10_000): Promise<Message> {
    return this.nextWhere((message) => message.type === type && predicate(message), timeoutMs);
  }

  nextWhere(predicate: (message: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        match: predicate,
        resolve,
        timer: setTimeout(() => {
          const pendingIndex = this.waiters.indexOf(waiter);
          if (pendingIndex >= 0) this.waiters.splice(pendingIndex, 1);
          reject(new Error('WebSocket 메시지 대기 시간 초과'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  take(predicate: (message: Message) => boolean): Message | undefined {
    const index = this.messages.findIndex(predicate);
    return index >= 0 ? this.messages.splice(index, 1)[0] : undefined;
  }

  count(type: string) { return this.received.filter((message) => message.type === type).length; }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

interface Sandbox {
  dir: string;
  wsUrl: string;
  httpUrl: string;
  server: ChildProcess;
  peers: Peer[];
  output: string;
}

function profile(playerId: string, name: string) {
  const now = '2026-10-01T00:00:00.000Z';
  return {
    playerId, token: `token-${playerId}`, name, rating: 1375, wins: 3, losses: 4,
    createdAt: now, updatedAt: now,
  };
}

const TEST_PROFILES = [
  ['ranked-invite-core', 'Core'], ['ranked-invite-watcher', 'Watcher'],
  ['ranked-invite-cancel', 'Cancel'], ['ranked-invite-background', 'Background'],
  ['ranked-invite-disconnect', 'Disconnect'], ['ranked-invite-race-a', 'Race A'],
  ['ranked-invite-race-b', 'Race B'], ['ranked-invite-pending', 'Pending'],
  ['ranked-invite-quick-a', 'Quick A'], ['ranked-invite-playing', 'Playing'],
  ['ranked-invite-quick-b', 'Quick B'],
] as const;

async function openPeer(url: string): Promise<Peer> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Peer(socket);
}

async function startSandbox(extraEnv: NodeJS.ProcessEnv = {}): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-ranked-invitations-'));
  const profileFile = join(dir, 'profiles.json');
  await writeFile(profileFile, JSON.stringify(TEST_PROFILES.map(([id, name]) => profile(id, name))));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: '',
    HOST: '127.0.0.1',
    PORT: '0',
    MONGJIN_PUSH_ENABLED: '0',
    MONGJIN_MATCH_PUSH_ENABLED: '0',
    MONGJIN_PROFILE_DATA_FILE: profileFile,
    MONGJIN_COMMUNITY_DATA_FILE: join(dir, 'community.json'),
    ...extraEnv,
  };
  for (const key of Object.keys(env)) if (key.startsWith('MONGJIN_TOURNAMENT_')) delete env[key];

  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  const server = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDirectory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sandbox: Sandbox = { dir, wsUrl: '', httpUrl: '', server, peers: [], output: '' };
  server.stdout!.on('data', (chunk) => { sandbox.output += chunk; });
  server.stderr!.on('data', (chunk) => { sandbox.output += chunk; });

  try {
    const match = await until(() => sandbox.output.match(/몽진 온라인 서버 — ws:\/\/127\.0\.0\.1:(\d+)/), 15_000);
    const port = match[1]!;
    sandbox.wsUrl = `ws://127.0.0.1:${port}`;
    sandbox.httpUrl = `http://127.0.0.1:${port}`;
    return sandbox;
  } catch (error) {
    await stopSandbox(sandbox);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nserver output:\n${sandbox.output}`);
  }
}

async function stopSandbox(sandbox: Sandbox) {
  for (const peer of sandbox.peers) peer.close();
  if (sandbox.server.exitCode === null && sandbox.server.signalCode === null) {
    const stopped = new Promise<void>((resolve) => sandbox.server.once('exit', () => resolve()));
    sandbox.server.kill('SIGTERM');
    await Promise.race([stopped, pause(10_000)]);
    if (sandbox.server.exitCode === null && sandbox.server.signalCode === null) sandbox.server.kill('SIGKILL');
  }
  await rm(sandbox.dir, { recursive: true, force: true });
}

async function connect(sandbox: Sandbox, playerId: string) {
  const peer = await openPeer(sandbox.wsUrl);
  sandbox.peers.push(peer);
  peer.send({ type: 'HELLO', playerId, token: `token-${playerId}`, features: [INVITATION_FEATURE] });
  peer.send({ type: 'UPDATE_PRESENCE', state: 'idle' });
  const identity = await peer.next('IDENTITY');
  expect(identity.profile).toMatchObject({ playerId });
  return { peer, identity };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json() as Promise<T>;
}

const leaderboard = (sandbox: Sandbox, onlineOnly = false) =>
  getJson<LeaderboardPage>(`${sandbox.httpUrl}/leaderboard?limit=100${onlineOnly ? '&online=1' : ''}`);

async function idleRankedBots(sandbox: Sandbox) {
  const page = await leaderboard(sandbox, true);
  return page.entries.filter((entry) => entry.playerId.startsWith('ranked-bot-') && entry.presence === 'idle');
}

async function waitForRoomCount(sandbox: Sandbox, rooms: number) {
  await until(async () => {
    const health = await getJson<{ rooms: number }>(`${sandbox.httpUrl}/health`);
    return health.rooms === rooms ? health : undefined;
  });
}

async function invite(peer: Peer, playerId: string) {
  const startedAt = Date.now();
  peer.send({ type: 'SEND_INVITATION', playerId });
  const outgoing = await peer.next('INVITATION', (message) => message.direction === 'outgoing');
  const invitationId = outgoing.invitation?.id as string | undefined;
  if (!invitationId) throw new Error('보낸 초대에 ID가 없습니다');
  return { startedAt, invitationId, outgoing };
}

function ratingRecord(profile: Partial<LeaderboardEntry> | undefined) {
  return { rating: profile?.rating, wins: profile?.wins, losses: profile?.losses };
}

function entryById(page: LeaderboardPage, playerId: string) {
  return page.entries.find((entry) => entry.playerId === playerId);
}

async function expectNoDelayedMatch(sandbox: Sandbox, startedAt: number) {
  await pause(Math.max(0, NO_AUTO_MATCH_WINDOW_MS - (Date.now() - startedAt)));
  for (const peer of sandbox.peers) expect(peer.count('MATCH_FOUND')).toBe(0);
  await waitForRoomCount(sandbox, 0);
}

async function resign(peer: Peer) {
  peer.send({ type: 'RESIGN' });
  return peer.next('MATCH_RESULT');
}

function botIdFromMatch(match: Message) {
  const name = match.opponent?.name;
  const bot = RANKED_BOTS.find((candidate) => candidate.name === name);
  if (!bot) throw new Error(`MATCH_FOUND opponent가 ranked bot 프로필과 일치하지 않습니다: ${String(name)}`);
  return bot.id;
}

describe('ranked profile invitation loopback integration', () => {
  it('starts with four idle ranked profiles and runs an unrated friend game through a legal move, bot response, and resign', { timeout: 25_000 }, async () => {
    const sandbox = await startSandbox();
    try {
      const initial = await leaderboard(sandbox);
      const ranked = initial.entries.filter((entry) => RANKED_BOTS.some((bot) => bot.id === entry.playerId));
      expect(ranked).toHaveLength(RANKED_BOTS.length);
      expect(ranked.filter((entry) => entry.presence === 'idle')).toHaveLength(4);
      expect(ranked.filter((entry) => entry.presence === 'offline')).toHaveLength(RANKED_BOTS.length - 4);
      expect(ranked.every((entry) => entry.presence === 'idle' || entry.presence === 'offline')).toBe(true);

      const caller = await connect(sandbox, 'ranked-invite-core');
      const watcher = await connect(sandbox, 'ranked-invite-watcher');
      const bot = (await idleRankedBots(sandbox))[0]!;
      const before = await leaderboard(sandbox);
      const callerBefore = entryById(before, 'ranked-invite-core')!;
      const botBefore = entryById(before, bot.playerId)!;
      const invitation = await invite(caller.peer, bot.playerId);
      const match = await caller.peer.next('MATCH_FOUND');
      const acceptDelay = Date.now() - invitation.startedAt;
      expect(acceptDelay).toBeGreaterThanOrEqual(1_900);
      expect(acceptDelay).toBeLessThanOrEqual(AUTO_ACCEPT_MAX_MS + 500);
      expect(match).toMatchObject({ matchKind: 'friend', opponent: { name: bot.name } });
      expect(Object.hasOwn(match, 'isBot')).toBe(false);
      expect(Object.hasOwn(match.opponent, 'isBot')).toBe(false);

      let state = match.state as GameState;
      const callerSide = match.side as GameState['turn'];
      if (state.turn !== callerSide) {
        state = (await caller.peer.next('STATE', (message) => message.state?.turn === callerSide, 15_000)).state as GameState;
      }
      const move = legalMoves(state, DEFAULT_CONFIG)[0];
      if (!move) throw new Error('초기 게임 상태에 합법 착수가 없습니다');
      const previousPly = state.history.length;
      caller.peer.send({ type: 'MOVE', move });
      const afterCallerMove = await caller.peer.next('STATE', (message) => message.state?.history?.length === previousPly + 1);
      expect(afterCallerMove.state.turn).not.toBe(callerSide);
      const afterBotMove = await caller.peer.next('STATE', (message) =>
        message.state?.history?.length === previousPly + 2 && message.state?.turn === callerSide, 15_000);
      expect(afterBotMove.state.history).toHaveLength(previousPly + 2);

      const active = await until(async () => {
        const page = await leaderboard(sandbox, true);
        return page.entries.find((entry) => entry.playerId === bot.playerId && entry.presence === 'playing') ? page : undefined;
      });
      expect(entryById(active, 'ranked-invite-core')?.presence).toBe('playing');
      const secondTarget = (await idleRankedBots(sandbox)).find((entry) => entry.playerId !== bot.playerId)!;
      caller.peer.send({ type: 'SEND_INVITATION', playerId: secondTarget.playerId });
      expect(await caller.peer.next('INVITATION_ERROR')).toMatchObject({ code: 'BUSY' });

      watcher.peer.send({ type: 'JOIN', roomId: match.roomId });
      expect(await watcher.peer.next('ERROR')).toMatchObject({ message: '참가할 수 없는 방입니다' });
      expect(watcher.peer.count('JOINED')).toBe(0);

      const result = await resign(caller.peer);
      expect(result).toMatchObject({ reason: 'forfeit', profile: ratingRecord(callerBefore) });
      await waitForRoomCount(sandbox, 0);
      const after = await leaderboard(sandbox);
      expect(ratingRecord(entryById(after, callerBefore.playerId))).toEqual(ratingRecord(callerBefore));
      expect(ratingRecord(entryById(after, botBefore.playerId))).toEqual(ratingRecord(botBefore));
      expect(entryById(await leaderboard(sandbox, true), bot.playerId)?.presence).toBe('idle');
    } finally {
      await stopSandbox(sandbox);
    }
  });

  it('cancels pending auto-accept on cancellation, backgrounding, and disconnect', { timeout: 30_000 }, async () => {
    const sandbox = await startSandbox();
    try {
      const bots = await idleRankedBots(sandbox);
      expect(bots).toHaveLength(4);

      const cancelClient = await connect(sandbox, 'ranked-invite-cancel');
      const cancelStartedAt = Date.now();
      const cancelled = await invite(cancelClient.peer, bots[0]!.playerId);
      cancelClient.peer.send({ type: 'CANCEL_INVITATION', invitationId: cancelled.invitationId });
      expect(await cancelClient.peer.next('INVITATION_CLOSED')).toMatchObject({ reason: 'cancelled' });
      await expectNoDelayedMatch(sandbox, cancelStartedAt);

      const backgroundClient = await connect(sandbox, 'ranked-invite-background');
      const backgroundStartedAt = Date.now();
      const backgroundInvite = await invite(backgroundClient.peer, bots[1]!.playerId);
      backgroundClient.peer.setPresence('background');
      expect(await backgroundClient.peer.next('INVITATION_CLOSED')).toMatchObject({
        invitationId: backgroundInvite.invitationId, reason: 'unavailable',
      });
      await expectNoDelayedMatch(sandbox, backgroundStartedAt);

      const disconnected = await connect(sandbox, 'ranked-invite-disconnect');
      const disconnectStartedAt = Date.now();
      await invite(disconnected.peer, bots[2]!.playerId);
      disconnected.peer.close();
      await expectNoDelayedMatch(sandbox, disconnectStartedAt);
      expect((await leaderboard(sandbox, true)).entries.filter((entry) =>
        entry.playerId.startsWith('ranked-bot-') && entry.presence === 'idle')).toHaveLength(4);
    } finally {
      await stopSandbox(sandbox);
    }
  });

  it('serializes concurrent invitations to one ranked profile and starts only one match', { timeout: 15_000 }, async () => {
    const sandbox = await startSandbox();
    try {
      const [first, second] = await Promise.all([
        connect(sandbox, 'ranked-invite-race-a'), connect(sandbox, 'ranked-invite-race-b'),
      ]);
      const target = (await idleRankedBots(sandbox))[0]!;
      const startedAt = Date.now();
      first.peer.send({ type: 'SEND_INVITATION', playerId: target.playerId });
      second.peer.send({ type: 'SEND_INVITATION', playerId: target.playerId });
      const outcomes: Array<{ peer: Peer; message: Message }> = [];
      await until(() => {
        for (const peer of [first.peer, second.peer]) {
          const outcome = peer.take((message) =>
            (message.type === 'INVITATION' && message.direction === 'outgoing') || message.type === 'INVITATION_ERROR');
          if (outcome) outcomes.push({ peer, message: outcome });
        }
        return outcomes.length === 2 ? outcomes : undefined;
      });
      expect(outcomes.filter(({ message }) => message.type === 'INVITATION')).toHaveLength(1);
      expect(outcomes.filter(({ message }) => message.type === 'INVITATION_ERROR' && message.code === 'PENDING')).toHaveLength(1);

      const winner = outcomes.find(({ message }) => message.type === 'INVITATION')!.peer;
      const match = await winner.next('MATCH_FOUND');
      expect(match).toMatchObject({ matchKind: 'friend', opponent: { name: target.name } });
      expect(Object.hasOwn(match, 'isBot')).toBe(false);
      await pause(Math.max(0, NO_AUTO_MATCH_WINDOW_MS - (Date.now() - startedAt)));
      expect(first.peer.count('MATCH_FOUND') + second.peer.count('MATCH_FOUND')).toBe(1);
      await waitForRoomCount(sandbox, 1);
      await resign(winner);
      await waitForRoomCount(sandbox, 0);
    } finally {
      await stopSandbox(sandbox);
    }
  });

  it('excludes pending and playing virtual profiles from MATCHMAKE_BOT selection', { timeout: 20_000 }, async () => {
    const sandbox = await startSandbox();
    try {
      const pendingOwner = await connect(sandbox, 'ranked-invite-pending');
      const pendingTarget = (await idleRankedBots(sandbox))[0]!;
      const pendingInvite = await invite(pendingOwner.peer, pendingTarget.playerId);

      const pendingFallback = await connect(sandbox, 'ranked-invite-quick-a');
      pendingFallback.peer.send({ type: 'MATCHMAKE_BOT' });
      const pendingFallbackMatch = await pendingFallback.peer.next('MATCH_FOUND');
      expect(botIdFromMatch(pendingFallbackMatch)).not.toBe(pendingTarget.playerId);
      await resign(pendingFallback.peer);
      pendingOwner.peer.send({ type: 'CANCEL_INVITATION', invitationId: pendingInvite.invitationId });
      expect(await pendingOwner.peer.next('INVITATION_CLOSED')).toMatchObject({ reason: 'cancelled' });

      const playingOwner = await connect(sandbox, 'ranked-invite-playing');
      const playingTarget = (await idleRankedBots(sandbox))[0]!;
      const playingInvite = await invite(playingOwner.peer, playingTarget.playerId);
      const playingMatch = await playingOwner.peer.next('MATCH_FOUND');
      expect(botIdFromMatch(playingMatch)).toBe(playingTarget.playerId);
      expect(Date.now() - playingInvite.startedAt).toBeGreaterThanOrEqual(1_900);
      await until(async () => {
        const page = await leaderboard(sandbox, true);
        return page.entries.find((entry) => entry.playerId === playingTarget.playerId && entry.presence === 'playing') ?? undefined;
      });

      const playingFallback = await connect(sandbox, 'ranked-invite-quick-b');
      playingFallback.peer.send({ type: 'MATCHMAKE_BOT' });
      const playingFallbackMatch = await playingFallback.peer.next('MATCH_FOUND');
      expect(botIdFromMatch(playingFallbackMatch)).not.toBe(playingTarget.playerId);
      await Promise.all([resign(playingOwner.peer), resign(playingFallback.peer)]);
      await waitForRoomCount(sandbox, 0);
    } finally {
      await stopSandbox(sandbox);
    }
  });
+  it('keeps latest reconnect handling for an automated friendly room: resume inside the grace window, abandon after it', { timeout: 30_000 }, async () => {
    const sandbox = await startSandbox({ MONGJIN_RECONNECT_GRACE_MS: '1500' });
    try {
      const before = await leaderboard(sandbox);
      const bot = (await idleRankedBots(sandbox))[0]!;
      const callerBefore = entryById(before, 'ranked-invite-core')!;
      const botBefore = entryById(before, bot.playerId)!;

      const first = await connect(sandbox, 'ranked-invite-core');
      await invite(first.peer, bot.playerId);
      const match = await first.peer.next('MATCH_FOUND');
      first.peer.close();
      await pause(300);
      // The seat is held, so the automated profile stays reserved during the grace window.
      await waitForRoomCount(sandbox, 1);
      expect(entryById(await leaderboard(sandbox, true), bot.playerId)?.presence).toBe('playing');

      const resumed = await connect(sandbox, 'ranked-invite-core');
      resumed.peer.send({ type: 'RESUME', roomId: match.roomId });
      expect(await resumed.peer.next('RESUMED')).toMatchObject({
        roomId: match.roomId, matchKind: 'friend', opponent: { name: bot.name },
      });
      await pause(2_000);
      await waitForRoomCount(sandbox, 1);

      resumed.peer.close();
      await waitForRoomCount(sandbox, 0);
      const after = await leaderboard(sandbox);
      expect(ratingRecord(entryById(after, callerBefore.playerId))).toEqual(ratingRecord(callerBefore));
      expect(ratingRecord(entryById(after, botBefore.playerId))).toEqual(ratingRecord(botBefore));
      expect(entryById(await leaderboard(sandbox, true), bot.playerId)?.presence).toBe('idle');

      const late = await connect(sandbox, 'ranked-invite-core');
      late.peer.send({ type: 'RESUME', roomId: match.roomId });
      expect(await late.peer.next('RESUME_FAILED')).toMatchObject({ roomId: match.roomId });
    } finally {
      await stopSandbox(sandbox);
    }
  });

  it('applies no server move clock to an automated friendly room while quick bot games keep it', { timeout: 30_000 }, async () => {
    const sandbox = await startSandbox({ MONGJIN_MOVE_TIME_MS: '700' });
    try {
      const friendly = await connect(sandbox, 'ranked-invite-core');
      const bot = (await idleRankedBots(sandbox))[0]!;
      await invite(friendly.peer, bot.playerId);
      const match = await friendly.peer.next('MATCH_FOUND');
      expect(match.matchKind).toBe('friend');

      const control = await connect(sandbox, 'ranked-invite-quick-a');
      control.peer.send({ type: 'MATCHMAKE_BOT' });
      await control.peer.next('MATCH_FOUND');
      // The control proves the clock is active in this sandbox; the friendly room must outlive it.
      expect(await control.peer.next('MATCH_RESULT', () => true, 12_000)).toMatchObject({ reason: expect.stringMatching(/timeout|forfeit/) });
      await pause(1_500);
      expect(friendly.peer.count('MATCH_RESULT')).toBe(0);
      await waitForRoomCount(sandbox, 1);
      expect(entryById(await leaderboard(sandbox, true), bot.playerId)?.presence).toBe('playing');

      await resign(friendly.peer);
      await waitForRoomCount(sandbox, 0);
    } finally {
      await stopSandbox(sandbox);
    }
  });

  it('never offers a rematch for an automated friendly room', { timeout: 25_000 }, async () => {
    const sandbox = await startSandbox();
    try {
      const caller = await connect(sandbox, 'ranked-invite-core');
      const bot = (await idleRankedBots(sandbox))[0]!;
      await invite(caller.peer, bot.playerId);
      const match = await caller.peer.next('MATCH_FOUND');
      await resign(caller.peer);
      await waitForRoomCount(sandbox, 0);

      caller.peer.send({ type: 'REMATCH', roomId: match.roomId });
      expect(await caller.peer.next('REMATCH_UNAVAILABLE')).toMatchObject({ roomId: match.roomId });
      await pause(500);
      expect(caller.peer.count('REMATCH_REQUESTED')).toBe(0);
      expect(caller.peer.count('MATCH_FOUND')).toBe(1);
      await waitForRoomCount(sandbox, 0);
      expect(entryById(await leaderboard(sandbox, true), bot.playerId)?.presence).toBe('idle');
    } finally {
      await stopSandbox(sandbox);
    }
  });
});
