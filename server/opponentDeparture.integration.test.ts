import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Player } from '../src/core/types';
import type { GameRecord } from './gameRecords';
import type { RecordedMatchEvent, StoredProfile } from './profileRepository';

const serverDir = dirname(fileURLToPath(import.meta.url));
const GRACE_MS = 1_500;
const MOVE_MS = 3_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface WireMessage {
  type: string;
  playerId?: string;
  token?: string;
  roomId?: string;
  side?: Player;
  state?: GameState;
  winner?: Player;
  reason?: string;
  profile?: StoredProfile;
  turnTimeLeftMs?: number | null;
  graceMs?: number;
  matchKind?: string;
  opponent?: { name: string; rating: number; isBot?: boolean } | null;
  result?: { roomId: string; winner: Player; reason: string } | null;
}

interface TestClient {
  id: string;
  readonly ws: WebSocket;
  readonly received: WireMessage[];
  send(message: object): Promise<void>;
  next(type: string, timeoutMs?: number): Promise<WireMessage>;
  terminate(): Promise<void>;
  sendThenClose(message: object): Promise<void>;
}

let child: ChildProcess | undefined;
let tempDir = '';
let profilePath = '';
let serverUrl = '';
let logs = '';
let sequence = 0;
const activeClients = new Set<TestClient>();

async function until<T>(
  read: () => T | Promise<T>,
  timeoutMs = 8_000,
  failure: () => string = () => '조건 대기 시간 초과',
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(10);
  }
  throw new Error(`${failure()}\n${logs}`);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function profiles(): Promise<StoredProfile[]> {
  return readJson(profilePath, []);
}

async function matchIds(): Promise<string[]> {
  return readJson(`${profilePath}.matches.json`, []);
}

async function matchEvents(): Promise<RecordedMatchEvent[]> {
  return readJson(`${profilePath}.match-events.json`, []);
}

async function gameRecords(): Promise<GameRecord[]> {
  const directory = join(tempDir, 'game-records');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    names.filter((name) => name.endsWith('.json')).map(async (name) =>
      JSON.parse(await readFile(join(directory, name), 'utf8')) as GameRecord),
  );
}

function createClient(label: string): TestClient {
  const id = `departure-${label}-${++sequence}`;
  const ws = new WebSocket(serverUrl);
  const pending: WireMessage[] = [];
  const received: WireMessage[] = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as WireMessage;
    pending.push(message);
    received.push(message);
  });

  let client!: TestClient;
  const closed = () => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve();
    else ws.once('close', () => resolve());
  });
  client = {
    id,
    ws,
    received,
    async send(message) {
      await until(
        () => ws.readyState === WebSocket.OPEN,
        5_000,
        () => `${id} WebSocket 연결 시간 초과`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
      });
    },
    async next(type, timeoutMs = 6_000) {
      return until(
        () => {
          const index = pending.findIndex((message) => message.type === type);
          return index >= 0 ? pending.splice(index, 1)[0] : undefined;
        },
        timeoutMs,
        () => `${id}: ${type} 메시지 시간 초과. 수신=${JSON.stringify(received)}`,
      );
    },
    async terminate() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const didClose = closed();
      ws.terminate();
      await didClose;
    },
    async sendThenClose(message) {
      await this.send(message);
      const didClose = closed();
      ws.close();
      await didClose;
    },
  };
  ws.once('close', () => activeClients.delete(client));
  activeClients.add(client);
  return client;
}

const tokens = new Map<string, string>();

async function authenticate(client: TestClient, hello: object = {}): Promise<void> {
  await client.send({ type: 'HELLO', ...hello });
  const identity = await client.next('IDENTITY');
  expect(identity.playerId).toMatch(/^[a-f0-9]{24}$/);
  client.id = identity.playerId!;
  tokens.set(identity.playerId!, identity.token!);
}

/** 같은 프로필로 새 소켓을 열어 재접속하는 앱을 흉내 낸다. */
async function reconnectAs(previous: TestClient, label: string): Promise<TestClient> {
  const client = createClient(label);
  await authenticate(client, { playerId: previous.id, token: tokens.get(previous.id), features: ['resume', 'server-clock'] });
  expect(client.id).toBe(previous.id);
  return client;
}

async function startRandom(label: string) {
  const first = createClient(`${label}-first`);
  const second = createClient(`${label}-second`);
  await Promise.all([authenticate(first), authenticate(second)]);
  await first.send({ type: 'MATCHMAKE' });
  await second.send({ type: 'MATCHMAKE' });
  const [firstFound, secondFound] = await Promise.all([
    first.next('MATCH_FOUND'),
    second.next('MATCH_FOUND'),
  ]);
  expect(firstFound.roomId).toBe(secondFound.roomId);
  expect(firstFound.side).not.toBe(secondFound.side);
  return { first, second, firstFound, secondFound };
}

async function startFriend(label: string) {
  const host = createClient(`${label}-host`);
  const guest = createClient(`${label}-guest`);
  await Promise.all([authenticate(host), authenticate(guest)]);
  await host.send({ type: 'CREATE' });
  const created = await host.next('CREATED');
  await guest.send({ type: 'JOIN', roomId: created.roomId });
  const [joined, hostFound, guestFound] = await Promise.all([
    guest.next('JOINED'),
    host.next('MATCH_FOUND'),
    guest.next('MATCH_FOUND'),
  ]);
  expect(joined.roomId).toBe(created.roomId);
  expect(hostFound.side).toBe('BLACK');
  expect(guestFound.side).toBe('WHITE');
  return { host, guest, created, hostFound, guestFound };
}

function resultMessages(client: TestClient): WireMessage[] {
  return client.received.filter((message) => message.type === 'MATCH_RESULT');
}

async function expectOneResultWithoutOpponentLeft(
  client: TestClient,
  expected: { winner: Player; reason: 'forfeit' },
): Promise<WireMessage> {
  const result = await client.next('MATCH_RESULT');
  expect(result).toMatchObject(expected);
  await pause(100);
  expect(resultMessages(client)).toHaveLength(1);
  expect(client.received.some((message) => message.type === 'OPPONENT_LEFT')).toBe(false);
  return result;
}

async function expectRankedResultOnce(options: {
  winnerId: string;
  loserId: string;
  beforeMatchIds: string[];
  beforeRecords: GameRecord[];
  recordReason: 'disconnect' | 'resign';
  abandonedEvents: 0 | 1;
}): Promise<void> {
  const persisted = await until(async () => {
    const current = await profiles();
    const winner = current.find((profile) => profile.playerId === options.winnerId);
    const loser = current.find((profile) => profile.playerId === options.loserId);
    return winner?.wins === 1 && loser?.losses === 1 ? { winner, loser } : undefined;
  });
  expect(persisted.winner).toMatchObject({ wins: 1, losses: 0, rating: 1212 });
  expect(persisted.loser).toMatchObject({ wins: 0, losses: 1, rating: 1188 });

  const ids = await matchIds();
  expect(ids.filter((id) => !options.beforeMatchIds.includes(id))).toHaveLength(1);

  const records = await until(async () => {
    const current = await gameRecords();
    const added = current.filter((record) =>
      !options.beforeRecords.some((before) => before.matchId === record.matchId));
    return added.length === 1 && added[0]?.status === 'completed' ? added : undefined;
  });
  expect(records[0]).toMatchObject({
    kind: 'random',
    status: 'completed',
    reason: options.recordReason,
  });

  const events = await matchEvents();
  const playerEvents = events.filter((event) =>
    event.playerId === options.winnerId || event.playerId === options.loserId);
  expect(playerEvents.filter((event) => event.event === 'completed')).toHaveLength(2);
  expect(playerEvents.filter((event) => event.event === 'abandoned')).toHaveLength(options.abandonedEvents);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mongjin-opponent-departure-'));
  profilePath = join(tempDir, 'profiles.json');
  child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: '',
      DATABASE_URL: '',
      HOST: '127.0.0.1',
      MONGJIN_JEV_ENABLED: '0',
      MONGJIN_PROFILE_DATA_FILE: profilePath,
      // 실제 기본값은 재접속 60초·한 수 60초다. 테스트는 같은 순서(유예 < 시계)로 줄여 돌린다.
      MONGJIN_RECONNECT_GRACE_MS: String(GRACE_MS),
      MONGJIN_MOVE_TIME_MS: String(MOVE_MS),
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (chunk) => { logs += String(chunk); });
  child.stderr!.on('data', (chunk) => { logs += String(chunk); });
  serverUrl = await until(
    () => logs.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0],
    12_000,
    () => '테스트 서버 시작 시간 초과',
  );
}, 15_000);

afterEach(async () => {
  await Promise.all([...activeClients].map((client) => client.terminate()));
});

afterAll(async () => {
  await Promise.all([...activeClients].map((client) => client.terminate()));
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), pause(2_000).then(() => false)]);
    if (!stopped && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

it('빠른 대전은 첫 수 전에 상대가 끊겨도 남은 이용자에게 승리 결과를 보내고 Elo를 한 번 기록한다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const { first: departing, second: remaining, firstFound, secondFound } = await startRandom('before-move');

  await departing.terminate();
  const result = await expectOneResultWithoutOpponentLeft(remaining, {
    winner: secondFound.side!,
    reason: 'forfeit',
  });
  expect(result.profile).toMatchObject({ playerId: remaining.id, wins: 1, losses: 0, rating: 1212 });
  await expectRankedResultOnce({
    winnerId: remaining.id,
    loserId: departing.id,
    beforeMatchIds,
    beforeRecords,
    recordReason: 'disconnect',
    abandonedEvents: 1,
  });
  expect(firstFound.state?.history).toHaveLength(0);
}, 15_000);

it('빠른 대전은 착수 뒤 상대가 끊기면 남은 이용자의 승리와 Elo를 한 번만 기록한다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const match = await startRandom('after-move');
  const black = match.firstFound.side === 'BLACK' ? match.first : match.second;
  const white = black === match.first ? match.second : match.first;
  const blackFound = black === match.first ? match.firstFound : match.secondFound;
  const move = legalMoves(blackFound.state ?? initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;

  await black.send({ type: 'MOVE', move });
  await Promise.all([black.next('STATE'), white.next('STATE')]);
  await white.terminate();
  await expectOneResultWithoutOpponentLeft(black, { winner: 'BLACK', reason: 'forfeit' });
  await expectRankedResultOnce({
    winnerId: black.id,
    loserId: white.id,
    beforeMatchIds,
    beforeRecords,
    recordReason: 'disconnect',
    abandonedEvents: 1,
  });
}, 15_000);

it.each([0, 1])(
  '친구 대전은 %i수 뒤 상대 이탈을 승리로 끝내되 랭크 Elo를 바꾸지 않는다',
  async (plies) => {
    const beforeMatchIds = await matchIds();
    const beforeRecords = await gameRecords();
    const match = await startFriend(`disconnect-${plies}`);
    const beforeProfiles = await profiles();
    if (plies === 1) {
      const move = legalMoves(match.hostFound.state ?? initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
      await match.host.send({ type: 'MOVE', move });
      await Promise.all([match.host.next('STATE'), match.guest.next('STATE')]);
    }

    await match.guest.terminate();
    const result = await expectOneResultWithoutOpponentLeft(match.host, {
      winner: 'BLACK',
      reason: 'forfeit',
    });
    expect(result.profile).toMatchObject({ playerId: match.host.id, wins: 0, losses: 0, rating: 1200 });

    const afterProfiles = await profiles();
    for (const id of [match.host.id, match.guest.id]) {
      const before = beforeProfiles.find((profile) => profile.playerId === id)!;
      const after = afterProfiles.find((profile) => profile.playerId === id)!;
      expect(after).toMatchObject({ wins: before.wins, losses: before.losses, rating: before.rating });
    }
    expect(await matchIds()).toEqual(beforeMatchIds);
    const records = await until(async () => {
      const current = await gameRecords();
      const added = current.filter((record) =>
        !beforeRecords.some((before) => before.matchId === record.matchId));
      return added.length === 1 && added[0]?.status === 'completed' ? added : undefined;
    });
    expect(records[0]).toMatchObject({
      kind: 'friend',
      status: 'completed',
      winner: 'BLACK',
      reason: 'disconnect',
      moves: plies === 0 ? [] : [expect.any(Object)],
    });
  },
  15_000,
);

it('친구 대전 RESIGN은 양쪽에 같은 결과를 보내고 Elo를 기록하지 않는다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const match = await startFriend('resign');
  const beforeProfiles = await profiles();

  await match.guest.send({ type: 'RESIGN' });
  const [hostResult, guestResult] = await Promise.all([
    expectOneResultWithoutOpponentLeft(match.host, { winner: 'BLACK', reason: 'forfeit' }),
    expectOneResultWithoutOpponentLeft(match.guest, { winner: 'BLACK', reason: 'forfeit' }),
  ]);
  expect(hostResult.profile).toMatchObject({ playerId: match.host.id, rating: 1200, wins: 0, losses: 0 });
  expect(guestResult.profile).toMatchObject({ playerId: match.guest.id, rating: 1200, wins: 0, losses: 0 });
  expect(await matchIds()).toEqual(beforeMatchIds);

  const afterProfiles = await profiles();
  for (const id of [match.host.id, match.guest.id]) {
    expect(afterProfiles.find((profile) => profile.playerId === id)).toMatchObject(
      beforeProfiles.find((profile) => profile.playerId === id)!,
    );
  }
  const records = await until(async () => {
    const current = await gameRecords();
    const added = current.filter((record) =>
      !beforeRecords.some((before) => before.matchId === record.matchId));
    return added.length === 1 && added[0]?.status === 'completed' ? added : undefined;
  });
  expect(records[0]).toMatchObject({ kind: 'friend', winner: 'BLACK', reason: 'resign' });
}, 15_000);

it('상대가 들어오지 않은 친구 방의 호스트 이탈은 경기 결과를 만들지 않는다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const host = createClient('unmatched-host');
  await authenticate(host);
  await host.send({ type: 'CREATE' });
  const created = await host.next('CREATED');
  await host.terminate();
  await pause(150);

  expect(resultMessages(host)).toHaveLength(0);
  expect(await matchIds()).toEqual(beforeMatchIds);
  expect((await gameRecords()).map((record) => record.matchId)).toEqual(
    beforeRecords.map((record) => record.matchId),
  );

  const observer = createClient('unmatched-observer');
  await authenticate(observer);
  await observer.send({ type: 'JOIN', roomId: created.roomId });
  expect(await observer.next('ERROR')).toMatchObject({ type: 'ERROR' });
  expect(resultMessages(observer)).toHaveLength(0);
}, 15_000);

it('상대가 들어오기 전 친구방 항복은 방을 취소하고 같은 소켓의 빠른 대전 재진입을 허용한다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const host = createClient('unmatched-resign-host');
  await authenticate(host);
  const beforeProfile = (await profiles()).find((profile) => profile.playerId === host.id)!;

  await host.send({ type: 'CREATE' });
  const created = await host.next('CREATED');
  await host.send({ type: 'RESIGN' });
  expect(await host.next('QUEUE_LEFT')).toMatchObject({ type: 'QUEUE_LEFT' });
  await pause(100);
  expect(resultMessages(host)).toHaveLength(0);

  await host.send({ type: 'MATCHMAKE' });
  expect(await host.next('PROFILE')).toMatchObject({
    profile: { playerId: host.id, wins: 0, losses: 0, rating: 1200 },
  });
  await host.send({ type: 'CANCEL_MATCHMAKING' });
  expect(await host.next('QUEUE_LEFT')).toMatchObject({ type: 'QUEUE_LEFT' });

  const observer = createClient('unmatched-resign-observer');
  await authenticate(observer);
  await observer.send({ type: 'JOIN', roomId: created.roomId });
  expect(await observer.next('ERROR')).toMatchObject({ type: 'ERROR' });
  expect(resultMessages(observer)).toHaveLength(0);

  const afterProfile = (await profiles()).find((profile) => profile.playerId === host.id)!;
  expect(afterProfile).toMatchObject({
    wins: beforeProfile.wins,
    losses: beforeProfile.losses,
    rating: beforeProfile.rating,
  });
  expect(await matchIds()).toEqual(beforeMatchIds);
  expect((await gameRecords()).map((record) => record.matchId)).toEqual(
    beforeRecords.map((record) => record.matchId),
  );
}, 15_000);

it('RESIGN 직후 연결이 닫혀도 빠른 대전 결과와 Elo를 중복 기록하지 않는다', async () => {
  const beforeMatchIds = await matchIds();
  const beforeRecords = await gameRecords();
  const match = await startRandom('duplicate-resign-close');
  const departing = match.first;
  const remaining = match.second;

  await departing.sendThenClose({ type: 'RESIGN' });
  await expectOneResultWithoutOpponentLeft(remaining, {
    winner: match.secondFound.side!,
    reason: 'forfeit',
  });
  await expectRankedResultOnce({
    winnerId: remaining.id,
    loserId: departing.id,
    beforeMatchIds,
    beforeRecords,
    recordReason: 'resign',
    abandonedEvents: 0,
  });
  await pause(150);
  const persisted = await profiles();
  expect(persisted.find((profile) => profile.playerId === remaining.id)).toMatchObject({ wins: 1, losses: 0 });
  expect(persisted.find((profile) => profile.playerId === departing.id)).toMatchObject({ wins: 0, losses: 1 });
  expect((await matchIds()).filter((id) => !beforeMatchIds.includes(id))).toHaveLength(1);
  expect(resultMessages(remaining)).toHaveLength(1);
}, 15_000);

it('빠른 대전은 유예 시간 안에 같은 프로필로 돌아오면 같은 판을 이어 두고 결과를 만들지 않는다', async () => {
  const match = await startRandom('resume');
  const black = match.firstFound.side === 'BLACK' ? match.first : match.second;
  const white = black === match.first ? match.second : match.first;
  const blackFound = black === match.first ? match.firstFound : match.secondFound;
  expect(blackFound.turnTimeLeftMs).toBeGreaterThan(MOVE_MS - 1_000);

  const move = legalMoves(blackFound.state ?? initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!;
  await black.send({ type: 'MOVE', move });
  await Promise.all([black.next('STATE'), white.next('STATE')]);

  await white.terminate();
  expect(await black.next('OPPONENT_DISCONNECTED')).toMatchObject({ graceMs: GRACE_MS });

  const returned = await reconnectAs(white, 'resume-returned');
  // The new tournament message router may bind this socket, but must not
  // consume or replace its normal quick-match seat.
  await returned.send({ type: 'TOURNAMENT_STATUS', protocolVersion: 2 });
  expect(await returned.next('TOURNAMENT_SNAPSHOT')).toMatchObject({ type: 'TOURNAMENT_SNAPSHOT' });
  await returned.send({ type: 'RESUME', roomId: blackFound.roomId });
  const resumed = await returned.next('RESUMED');
  expect(resumed).toMatchObject({ roomId: blackFound.roomId, side: 'WHITE', matchKind: 'random' });
  expect(resumed.state?.history).toHaveLength(1);
  expect(resumed.turnTimeLeftMs).toBeGreaterThan(0);
  await black.next('OPPONENT_RECONNECTED');

  const reply = legalMoves(resumed.state!, DEFAULT_CONFIG)[0]!;
  await returned.send({ type: 'MOVE', move: reply });
  const [blackState, whiteState] = await Promise.all([black.next('STATE'), returned.next('STATE')]);
  expect(blackState.state?.history).toHaveLength(2);
  expect(whiteState.turnTimeLeftMs).toBeGreaterThan(MOVE_MS - 1_000);

  // 유예 시간이 지나도 이미 돌아왔으므로 기권 결과가 오지 않는다.
  await pause(GRACE_MS + 200);
  expect(resultMessages(black)).toHaveLength(0);
  expect(resultMessages(returned)).toHaveLength(0);
}, 15_000);

it('앱이 잠든 사이 남은 예전 소켓이 있어도 새 연결이 자리를 넘겨받는다', async () => {
  const match = await startRandom('takeover');
  const stale = match.first;
  const fresh = await reconnectAs(stale, 'takeover-fresh');
  await fresh.send({ type: 'RESUME' });
  expect(await fresh.next('RESUMED')).toMatchObject({ roomId: match.firstFound.roomId, side: match.firstFound.side });
  await until(() => stale.ws.readyState === WebSocket.CLOSED, 3_000, () => '예전 소켓이 닫히지 않음');
  await pause(GRACE_MS + 200);
  expect(resultMessages(match.second)).toHaveLength(0);
  expect(resultMessages(fresh)).toHaveLength(0);
}, 15_000);

it('서버 시계가 끝나면 양쪽에 시간패를 보내고, 구버전 앱에는 기권으로 보여 준다', async () => {
  const beforeRecords = await gameRecords();
  const modern = createClient('clock-modern');
  const legacy = createClient('clock-legacy');
  await Promise.all([authenticate(modern, { features: ['resume', 'server-clock'] }), authenticate(legacy)]);
  await modern.send({ type: 'MATCHMAKE' });
  await legacy.send({ type: 'MATCHMAKE' });
  const [modernFound] = await Promise.all([modern.next('MATCH_FOUND'), legacy.next('MATCH_FOUND')]);

  // 흑이 한 수도 두지 않으면 흑의 시간패다.
  const [modernResult, legacyResult] = await Promise.all([
    modern.next('MATCH_RESULT', MOVE_MS + 3_000),
    legacy.next('MATCH_RESULT', MOVE_MS + 3_000),
  ]);
  expect(modernResult).toMatchObject({ winner: 'WHITE', reason: 'timeout' });
  expect(legacyResult).toMatchObject({ winner: 'WHITE', reason: 'forfeit' });

  const whiteId = modernFound.side === 'WHITE' ? modern.id : legacy.id;
  const blackId = whiteId === modern.id ? legacy.id : modern.id;
  const persisted = await until(async () => {
    const current = await profiles();
    const winner = current.find((profile) => profile.playerId === whiteId);
    const loser = current.find((profile) => profile.playerId === blackId);
    return winner?.wins === 1 && loser?.losses === 1 ? { winner, loser } : undefined;
  });
  expect(persisted.winner.rating).toBe(1212);
  const records = await until(async () => {
    const added = (await gameRecords()).filter((record) =>
      !beforeRecords.some((before) => before.matchId === record.matchId));
    return added.length === 1 && added[0]?.status === 'completed' ? added : undefined;
  });
  expect(records[0]).toMatchObject({ kind: 'random', winner: 'WHITE', reason: 'timeout' });
}, 15_000);

it('대국이 끝난 뒤 돌아오면 이어 둘 판 대신 그 판의 결과를 알려 준다', async () => {
  const match = await startRandom('resume-late');
  const departing = match.first;
  await departing.terminate();
  await match.second.next('MATCH_RESULT', GRACE_MS + 3_000);

  const returned = await reconnectAs(departing, 'resume-late-returned');
  await returned.send({ type: 'RESUME', roomId: match.firstFound.roomId });
  const failed = await returned.next('RESUME_FAILED');
  expect(failed.result).toMatchObject({
    roomId: match.firstFound.roomId,
    winner: match.secondFound.side,
    reason: 'forfeit',
  });
}, 15_000);

it('재접속을 기다리는 중 새 빠른 대전을 시작하면 이전 판은 바로 이탈패로 끝난다', async () => {
  const match = await startRandom('supersede');
  const departing = match.first;
  await departing.terminate();
  await match.second.next('OPPONENT_DISCONNECTED');

  const returned = await reconnectAs(departing, 'supersede-returned');
  const startedAt = Date.now();
  await returned.send({ type: 'MATCHMAKE' });
  expect(await match.second.next('MATCH_RESULT')).toMatchObject({ winner: match.secondFound.side, reason: 'forfeit' });
  expect(Date.now() - startedAt).toBeLessThan(GRACE_MS);
  await returned.send({ type: 'CANCEL_MATCHMAKING' });
}, 15_000);

it('봇 대국도 유예 시간 안에 돌아오면 이어서 두고, 봇 상대 정보를 다시 받는다', async () => {
  const player = createClient('bot-resume');
  await authenticate(player, { features: ['resume', 'server-clock'] });
  await player.send({ type: 'MATCHMAKE_BOT' });
  const found = await player.next('MATCH_FOUND');
  await player.terminate();

  const returned = await reconnectAs(player, 'bot-resume-returned');
  await returned.send({ type: 'RESUME', roomId: found.roomId });
  const resumed = await returned.next('RESUMED');
  expect(resumed).toMatchObject({ roomId: found.roomId, side: found.side, matchKind: 'random' });
  expect(resumed.opponent).toMatchObject({ isBot: true });
}, 15_000);

it('친구 대전이 끝난 뒤 두 사람이 모두 재대결을 누르면 흑백을 바꿔 새 판을 연다', async () => {
  const match = await startFriend('rematch');
  expect(match.hostFound.matchKind).toBe('friend');
  await match.guest.send({ type: 'RESIGN' });
  await Promise.all([match.host.next('MATCH_RESULT'), match.guest.next('MATCH_RESULT')]);

  await match.host.send({ type: 'REMATCH', roomId: match.created.roomId });
  expect(await match.guest.next('REMATCH_REQUESTED')).toMatchObject({ roomId: match.created.roomId });
  await match.guest.send({ type: 'REMATCH', roomId: match.created.roomId });
  const [hostFound, guestFound] = await Promise.all([match.host.next('MATCH_FOUND'), match.guest.next('MATCH_FOUND')]);
  expect(hostFound).toMatchObject({ side: 'WHITE', matchKind: 'friend' });
  expect(guestFound).toMatchObject({ side: 'BLACK', matchKind: 'friend', roomId: hostFound.roomId });
  expect(hostFound.roomId).not.toBe(match.created.roomId);
  expect(hostFound.state?.history).toHaveLength(0);

  // 새 판도 평소처럼 둘 수 있다.
  const move = legalMoves(guestFound.state!, DEFAULT_CONFIG)[0]!;
  await match.guest.send({ type: 'MOVE', move });
  await Promise.all([match.host.next('STATE'), match.guest.next('STATE')]);
}, 15_000);

it('재대결을 기다리는 중 상대가 나가면 재대결할 수 없다고 알린다', async () => {
  const match = await startFriend('rematch-left');
  await match.guest.send({ type: 'RESIGN' });
  await Promise.all([match.host.next('MATCH_RESULT'), match.guest.next('MATCH_RESULT')]);
  await match.host.send({ type: 'REMATCH', roomId: match.created.roomId });
  await match.guest.next('REMATCH_REQUESTED');
  await match.guest.terminate();
  expect(await match.host.next('REMATCH_UNAVAILABLE')).toMatchObject({ roomId: match.created.roomId });
}, 15_000);

it('빠른 대전 결과에는 재대결을 열지 않는다', async () => {
  const match = await startRandom('no-rematch');
  await match.first.send({ type: 'RESIGN' });
  await Promise.all([match.first.next('MATCH_RESULT'), match.second.next('MATCH_RESULT')]);
  await match.second.send({ type: 'REMATCH', roomId: match.firstFound.roomId });
  expect(await match.second.next('REMATCH_UNAVAILABLE')).toMatchObject({ roomId: match.firstFound.roomId });
}, 15_000);

it('새 프로필의 기본 닉네임은 HELLO가 알린 언어를 따르고, 알리지 않으면 한국어다', async () => {
  const english = createClient('lang-en');
  await english.send({ type: 'HELLO', lang: 'en' });
  expect((await english.next('IDENTITY')).profile?.name).toMatch(/^Wanderer\d{4}$/);
  const legacy = createClient('lang-none');
  await legacy.send({ type: 'HELLO' });
  expect((await legacy.next('IDENTITY')).profile?.name).toMatch(/^나그네\d{4}$/);
}, 15_000);
