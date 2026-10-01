import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { INVITATION_FEATURE } from '../src/net/invitationProtocol';
import type { TournamentSnapshot } from '../src/net/tournamentProtocol';

type Message = Record<string, unknown> & { type: string };
type TournamentFixture = { id: string; cutoff: number; start: number; end: number };
type LocalServer = { child: ChildProcess; wsUrl: string; httpUrl: string };

const serverDir = dirname(fileURLToPath(import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, timeoutMs = 8_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value as NonNullable<T>;
    await pause(20);
  }
  throw new Error('Invitation/tournament loopback timed out');
}

class Peer {
  readonly messages: Message[] = [];
  private readonly waiters: Array<{
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private invitationPresence: 'idle' | 'playing' | 'background' = 'idle';
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(readonly socket: WebSocket, private readonly tournamentId: string) {
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

  send(message: Record<string, unknown>) {
    this.socket.send(JSON.stringify(message));
  }

  command(message: Record<string, unknown>) {
    this.send({ ...message, protocolVersion: 2, tournamentId: this.tournamentId });
  }

  setInvitationPresence(state: 'idle' | 'playing' | 'background') {
    this.invitationPresence = state;
    this.send({ type: 'UPDATE_PRESENCE', state });
  }

  startPresenceHeartbeat() {
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'UPDATE_PRESENCE', state: this.invitationPresence });
      }
    }, 1_000);
  }

  next(type: string, predicate: (message: Message) => boolean = () => true, timeoutMs = 8_000): Promise<Message> {
    const match = (message: Message) => message.type === type && predicate(message);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const pendingIndex = this.waiters.indexOf(waiter);
          if (pendingIndex >= 0) this.waiters.splice(pendingIndex, 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  nextSnapshot(predicate: (snapshot: TournamentSnapshot) => boolean, timeoutMs = 8_000) {
    return this.next('TOURNAMENT_SNAPSHOT', (message) => predicate(message.snapshot as TournamentSnapshot), timeoutMs)
      .then((message) => message.snapshot as TournamentSnapshot);
  }

  count(type: string) {
    return this.messages.filter((message) => message.type === type).length;
  }

  discard(type: string) {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.type === type) this.messages.splice(index, 1);
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket.terminate();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Peer closed'));
    }
  }
}

async function openPeer(url: string, tournamentId: string): Promise<Peer> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Peer(socket, tournamentId);
}

function profile(playerId: string, name: string, rating: number) {
  const now = '2026-10-01T00:00:00.000Z';
  return { playerId, token: `token-${playerId}`, name, rating, wins: 0, losses: 0, createdAt: now, updatedAt: now };
}

async function startServer(dir: string, fixture: TournamentFixture, minimumParticipants: number): Promise<LocalServer> {
  const profileFile = join(dir, 'profiles.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: '',
    HOST: '127.0.0.1',
    PORT: '0',
    MONGJIN_PUSH_ENABLED: '0',
    MONGJIN_MATCH_PUSH_ENABLED: '0',
    MONGJIN_PROFILE_DATA_FILE: profileFile,
    MONGJIN_COMMUNITY_DATA_FILE: join(dir, 'community.json'),
  };
  for (const key of Object.keys(env)) if (key.startsWith('MONGJIN_TOURNAMENT_')) delete env[key];
  Object.assign(env, {
    MONGJIN_TOURNAMENT_ID: fixture.id,
    MONGJIN_TOURNAMENT_STARTS_AT: String(fixture.start),
    MONGJIN_TOURNAMENT_REGISTRATION_STARTS_AT: '0',
    MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT: String(fixture.cutoff),
    MONGJIN_TOURNAMENT_ENDS_AT: String(fixture.end),
    MONGJIN_TOURNAMENT_MIN_PARTICIPANTS: String(minimumParticipants),
    MONGJIN_TOURNAMENT_MIN_RANKED_MATCHES: '3',
    MONGJIN_TOURNAMENT_ELO_K: '32',
    MONGJIN_TOURNAMENT_ELO_SCALE: '400',
    MONGJIN_TOURNAMENT_STARTING_SCORE: '0',
    MONGJIN_TOURNAMENT_MATCH_COUNTDOWN_MS: '5000',
    MONGJIN_TOURNAMENT_DATA_FILE: '',
    MONGJIN_TOURNAMENT_NEXT_ID: '',
    MONGJIN_TOURNAMENT_NEXT_STARTS_AT: '',
    MONGJIN_TOURNAMENT_NEXT_ENDS_AT: '',
  });

  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; });
  try {
    const address = await until(() => {
      if (child.exitCode !== null) throw new Error(`Local server exited: ${output}`);
      return output.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
    }, 12_000);
    return { child, wsUrl: `ws://127.0.0.1:${address}`, httpUrl: `http://127.0.0.1:${address}` };
  } catch (error) {
    await stopServer(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nserver output:\n${output}`);
  }
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, pause(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, pause(1_000)]);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json() as Promise<T>;
}

async function connect(server: LocalServer, tournamentId: string, playerId: string, peers: Peer[]) {
  const peer = await openPeer(server.wsUrl, tournamentId);
  peers.push(peer);
  peer.send({ type: 'HELLO', playerId, token: `token-${playerId}`, features: [INVITATION_FEATURE] });
  peer.setInvitationPresence('idle');
  const identity = await peer.next('IDENTITY');
  expect(identity.playerId).toBe(playerId);
  peer.startPresenceHeartbeat();
  return peer;
}

async function register(peer: Peer, tournamentId: string) {
  peer.command({ type: 'TOURNAMENT_REGISTER' });
  const snapshot = await peer.nextSnapshot((value) => value.registered && value.protocolVersion === 2);
  expect(snapshot.config?.id).toBe(tournamentId);
  return snapshot;
}

async function waitForActive(peer: Peer) {
  peer.command({ type: 'TOURNAMENT_STATUS' });
  return peer.nextSnapshot((snapshot) => snapshot.phase === 'active', 8_000);
}

async function requestSnapshot(peer: Peer, minimumServerNow = 0) {
  peer.discard('TOURNAMENT_SNAPSHOT');
  peer.command({ type: 'TOURNAMENT_STATUS' });
  return peer.nextSnapshot((snapshot) => snapshot.serverNow >= minimumServerNow);
}

async function invite(from: Peer, to: Peer, toPlayerId: string) {
  from.send({ type: 'SEND_INVITATION', playerId: toPlayerId });
  const incoming = await to.next('INVITATION', (message) => message.direction === 'incoming');
  const outgoing = await from.next('INVITATION', (message) => message.direction === 'outgoing');
  const incomingInvitation = incoming.invitation as { id: string };
  const outgoingInvitation = outgoing.invitation as { id: string };
  expect(outgoingInvitation.id).toBe(incomingInvitation.id);
  return incomingInvitation.id;
}

async function expectInvitationError(peer: Peer, message: Record<string, unknown>, code: string) {
  peer.send(message);
  const error = await peer.next('INVITATION_ERROR');
  expect(error.code).toBe(code);
}

async function expectNoNormalRoom(server: LocalServer, peers: Peer[]) {
  const health = await getJson<{ rooms: number }>(`${server.httpUrl}/health`);
  expect(health.rooms).toBe(0);
  for (const peer of peers) expect(peer.count('MATCH_FOUND')).toBe(0);
}

async function assertTournamentMatchContinues(
  server: LocalServer,
  a: Peer,
  b: Peer,
  inviter: Peer,
  peers: Peer[],
  matchId: string,
  status: 'preparing' | 'countdown' | 'playing',
  staleInvitationId: string,
) {
  await expectInvitationError(a, { type: 'SEND_INVITATION', playerId: 'free-player' }, 'BUSY');
  await expectInvitationError(inviter, { type: 'SEND_INVITATION', playerId: 'target-player' }, 'BUSY');
  await expectInvitationError(a, { type: 'RESPOND_INVITATION', invitationId: staleInvitationId, accept: true }, 'NOT_FOUND');
  const afterRejectedInvitations = Date.now();
  const [aSnapshot, bSnapshot] = await Promise.all([
    requestSnapshot(a, afterRejectedInvitations),
    requestSnapshot(b, afterRejectedInvitations),
  ]);
  expect(aSnapshot.match).toMatchObject({ id: matchId, status });
  expect(bSnapshot.match).toMatchObject({ id: matchId, status });
  await expectNoNormalRoom(server, peers);
}

function futureFixture(id: string): TournamentFixture {
  const start = Date.now() + 5_000;
  return { id, cutoff: start - 1_000, start, end: start + 10 * 60_000 };
}

it('accepts an invitation from a registered tournament waiter without withdrawing other entrants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-invitation-tournament-'));
  const tournamentId = 'invite-accept-210';
  const fixture = futureFixture(tournamentId);
  const peers: Peer[] = [];
  let server: LocalServer | undefined;
  try {
    await writeFile(join(dir, 'profiles.json'), JSON.stringify([
      profile('target-player', 'Target', 1300),
      profile('standing-player', 'Standing', 1250),
      profile('free-player', 'Friend', 1400),
    ]));
    server = await startServer(dir, fixture, 2);
    const target = await connect(server, tournamentId, 'target-player', peers);
    const unrelated = await connect(server, tournamentId, 'standing-player', peers);
    const inviter = await connect(server, tournamentId, 'free-player', peers);
    await register(target, tournamentId);
    await register(unrelated, tournamentId);
    await waitForActive(target);

    target.command({ type: 'TOURNAMENT_JOIN' });
    const waiting = await target.nextSnapshot((snapshot) => snapshot.registered && snapshot.status === 'queued');
    expect(waiting.protocolVersion).toBe(2);
    expect(waiting.config?.id).toBe(tournamentId);
    const standingBefore = await requestSnapshot(unrelated);
    expect(standingBefore).toMatchObject({ registered: true, registrationCount: 2, status: 'idle' });

    const invitationId = await invite(inviter, target, 'target-player');
    const acceptAt = Date.now();
    target.send({ type: 'RESPOND_INVITATION', invitationId, accept: true });
    const [targetMatch, inviterMatch] = await Promise.all([
      target.next('MATCH_FOUND'),
      inviter.next('MATCH_FOUND'),
    ]);
    expect(targetMatch).toMatchObject({ matchKind: 'friend' });
    expect(inviterMatch).toMatchObject({ matchKind: 'friend', roomId: targetMatch.roomId });
    expect(await inviter.next('INVITATION_CLOSED')).toMatchObject({ invitationId, reason: 'accepted' });

    const [targetAfter, unrelatedAfter, health] = await Promise.all([
      requestSnapshot(target, acceptAt),
      requestSnapshot(unrelated, acceptAt),
      getJson<{ rooms: number }>(`${server.httpUrl}/health`),
    ]);
    expect(targetAfter).toMatchObject({ registered: true, registrationCount: 2, status: 'idle' });
    expect(unrelatedAfter.registered).toBe(true);
    expect(unrelatedAfter.registrationCount).toBe(2);
    expect(unrelatedAfter.status).toBe('idle');
    expect(unrelatedAfter.myStanding).toEqual(standingBefore.myStanding);
    expect(unrelatedAfter.standings).toEqual(standingBefore.standings);
    expect(health.rooms).toBe(1);
    expect(unrelated.count('MATCH_FOUND')).toBe(0);
    expect(target.count('MATCH_FOUND')).toBe(0);
    expect(inviter.count('MATCH_FOUND')).toBe(0);
  } finally {
    for (const peer of peers) peer.close();
    if (server) await stopServer(server.child);
    await rm(dir, { recursive: true, force: true });
  }
}, 35_000);

it('rejects invitations and stale accepts through tournament match phases and a background lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mongjin-invitation-tournament-blocked-'));
  const tournamentId = 'invite-blocked-210';
  const fixture = futureFixture(tournamentId);
  const peers: Peer[] = [];
  let server: LocalServer | undefined;
  try {
    await writeFile(join(dir, 'profiles.json'), JSON.stringify([
      profile('target-player', 'Target', 1300),
      profile('opponent-player', 'Opponent', 1250),
      profile('background-player', 'Background', 1280),
      profile('free-player', 'Friend', 1400),
    ]));
    server = await startServer(dir, fixture, 3);
    const target = await connect(server, tournamentId, 'target-player', peers);
    const opponent = await connect(server, tournamentId, 'opponent-player', peers);
    const background = await connect(server, tournamentId, 'background-player', peers);
    const inviter = await connect(server, tournamentId, 'free-player', peers);
    await register(target, tournamentId);
    await register(opponent, tournamentId);
    await register(background, tournamentId);
    await waitForActive(target);

    target.command({ type: 'TOURNAMENT_JOIN' });
    await target.nextSnapshot((snapshot) => snapshot.status === 'queued');
    const staleInvitationId = await invite(inviter, target, 'target-player');
    opponent.command({ type: 'TOURNAMENT_JOIN' });
    const [targetPreparing, opponentPreparing] = await Promise.all([
      target.nextSnapshot((snapshot) => snapshot.match?.status === 'preparing'),
      opponent.nextSnapshot((snapshot) => snapshot.match?.status === 'preparing'),
    ]);
    const matchId = targetPreparing.match!.id;
    expect(opponentPreparing.match?.id).toBe(matchId);
    expect(await target.next('INVITATION_CLOSED')).toMatchObject({ invitationId: staleInvitationId, reason: 'unavailable' });
    await assertTournamentMatchContinues(server, target, opponent, inviter, peers, matchId, 'preparing', staleInvitationId);

    target.command({ type: 'TOURNAMENT_READY', matchId });
    opponent.command({ type: 'TOURNAMENT_READY', matchId });
    const [targetCountdown, opponentCountdown] = await Promise.all([
      target.nextSnapshot((snapshot) => snapshot.match?.status === 'countdown'),
      opponent.nextSnapshot((snapshot) => snapshot.match?.status === 'countdown'),
    ]);
    expect(targetCountdown.match?.id).toBe(matchId);
    expect(opponentCountdown.match?.id).toBe(matchId);
    await assertTournamentMatchContinues(server, target, opponent, inviter, peers, matchId, 'countdown', staleInvitationId);

    const [targetPlaying, opponentPlaying] = await Promise.all([
      target.nextSnapshot((snapshot) => snapshot.match?.status === 'playing'),
      opponent.nextSnapshot((snapshot) => snapshot.match?.status === 'playing'),
    ]);
    expect(targetPlaying.match?.id).toBe(matchId);
    expect(opponentPlaying.match?.id).toBe(matchId);
    await assertTournamentMatchContinues(server, target, opponent, inviter, peers, matchId, 'playing', staleInvitationId);

    background.command({ type: 'TOURNAMENT_JOIN' });
    await background.nextSnapshot((snapshot) => snapshot.registered && snapshot.status === 'queued');
    const backgroundInvitationId = await invite(inviter, background, 'background-player');
    background.command({ type: 'TOURNAMENT_PRESENCE', state: 'background' });
    const waitingLease = await background.nextSnapshot((snapshot) =>
      snapshot.status === 'queued' && snapshot.presence === 'background' && snapshot.background?.state === 'waiting');
    expect(waitingLease.registered).toBe(true);
    expect(await background.next('INVITATION_CLOSED')).toMatchObject({ invitationId: backgroundInvitationId, reason: 'unavailable' });
    await expectInvitationError(background, {
      type: 'RESPOND_INVITATION', invitationId: backgroundInvitationId, accept: true,
    }, 'NOT_FOUND');
    await expectInvitationError(background, { type: 'SEND_INVITATION', playerId: 'free-player' }, 'BUSY');
    await expectInvitationError(inviter, { type: 'SEND_INVITATION', playerId: 'background-player' }, 'BUSY');

    const [targetStillPlaying, opponentStillPlaying, health] = await Promise.all([
      requestSnapshot(target),
      requestSnapshot(opponent),
      getJson<{ rooms: number }>(`${server.httpUrl}/health`),
    ]);
    expect(targetStillPlaying.match).toMatchObject({ id: matchId, status: 'playing' });
    expect(opponentStillPlaying.match).toMatchObject({ id: matchId, status: 'playing' });
    expect(health.rooms).toBe(0);
    for (const peer of peers) expect(peer.count('MATCH_FOUND')).toBe(0);
  } finally {
    for (const peer of peers) peer.close();
    if (server) await stopServer(server.child);
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);
