import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentServerMessage, TournamentSnapshot } from '../src/net/tournamentProtocol';
import {
  DEFAULT_INAUGURAL_CHAMPION_TITLE,
  TournamentService,
  tournamentSettingsFromEnv,
  type TournamentClient,
  type TournamentIdentity,
  type TournamentServiceEvent,
  type TournamentSettings,
} from './tournament';
import { FileTournamentStore, type TournamentStore } from './tournamentStore';
import { RANKED_BOTS } from './rankedBots';

const START = Date.parse('2026-10-10T12:00:00Z');
const REG_END = START + 60_000;
const GAME_START = START + 120_000;
const GAME_END = GAME_START + 3_600_000;

function settings(overrides: Partial<TournamentSettings> = {}): TournamentSettings {
  return {
    id: 'cup-2', title: '제1회 천하제일몽진대회',
    registrationStartsAt: START, registrationEndsAt: REG_END, startsAt: GAME_START, endsAt: GAME_END,
    minimumParticipants: 2, minimumRankedMatches: 3, startingScore: 0, eloK: 32, eloScale: 400,
    readyTimeoutMs: 15_000, matchCountdownMs: 5_000, moveTimeMs: 30_000, reconnectGraceMs: 20_000,
    reminderLeadMs: 3_600_000, isInaugural: true, championTitle: DEFAULT_INAUGURAL_CHAMPION_TITLE,
    rewardDescription: '', nextTournament: null, resultCountdownMs: 5_000, waitMs: 15_000,
    standingsLimit: 100, eventRetryMs: 1_000, ...overrides,
  };
}

class FakeClient implements TournamentClient {
  messages: TournamentServerMessage[] = [];
  send(message: TournamentServerMessage) { this.messages.push(structuredClone(message)); }
  get snapshot(): TournamentSnapshot {
    const found = [...this.messages].reverse().find((message) => message.type === 'TOURNAMENT_SNAPSHOT');
    if (!found || found.type !== 'TOURNAMENT_SNAPSHOT') throw new Error('no snapshot');
    return found.snapshot;
  }
  errors() { return this.messages.flatMap((message) => message.type === 'TOURNAMENT_ERROR' ? [message.code] : []); }
}

interface Player { id: TournamentIdentity; client: FakeClient }
const PLATFORMS: TournamentIdentity['platform'][] = ['toss', 'mobile', 'web', 'steam'];
function human(n: number, platform = PLATFORMS[n % PLATFORMS.length]!): Player {
  return { id: { playerId: 'human-' + n, name: '참가자' + n, platform }, client: new FakeClient() };
}

interface MakeOptions {
  store?: TournamentStore;
  settings?: TournamentSettings;
  busy?: (id: string) => boolean;
  onEvent?: (event: TournamentServiceEvent) => Promise<void> | void;
}
const quiet = { error: () => undefined, warn: () => undefined, log: () => undefined };
async function makeService(opts: MakeOptions = {}) {
  const store = opts.store ?? new FileTournamentStore('cup-2', null);
  const service = new TournamentService({
    settings: opts.settings ?? settings(),
    store,
    isPlayerBusyElsewhere: opts.busy,
    onEvent: opts.onEvent,
    random: () => 0.1, // 먼저 대기한 사람이 흑
    logger: quiet,
  });
  await service.init();
  return { service, store };
}

const send = (service: TournamentService, player: Player, message: Record<string, unknown>) =>
  service.handle(player.client, player.id, { protocolVersion: 2, ...message }).then(() => service.settle());

async function flush() {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}
async function advanceTo(at: number) {
  await vi.advanceTimersByTimeAsync(Math.max(0, at - Date.now()));
  await flush();
}
async function registerAll(service: TournamentService, players: Player[]) {
  for (const player of players) await send(service, player, { type: 'TOURNAMENT_REGISTER' });
}
/** 모집 중 신청 → 대회 시작 시각 이후로 이동 */
async function openWith(players: Player[], opts: MakeOptions = {}) {
  const made = await makeService(opts);
  await registerAll(made.service, players);
  await advanceTo(GAME_START + 1);
  return made;
}
/** 둘 다 입장 → 준비 → 서버 카운트다운 후 경기 시작. a가 먼저 대기했으므로 흑 */
async function startGame(service: TournamentService, a: Player, b: Player): Promise<string> {
  await send(service, a, { type: 'TOURNAMENT_JOIN' });
  await send(service, b, { type: 'TOURNAMENT_JOIN' });
  const matchId = a.client.snapshot.match!.id;
  await send(service, a, { type: 'TOURNAMENT_READY', matchId });
  await send(service, b, { type: 'TOURNAMENT_READY', matchId });
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  await service.settle();
  expect(a.client.snapshot.match?.status).toBe('playing');
  return matchId;
}
async function playAndLose(service: TournamentService, winner: Player, loser: Player) {
  const matchId = await startGame(service, winner, loser);
  await send(service, loser, { type: 'TOURNAMENT_RESIGN', matchId });
  await flush();
  await send(service, winner, { type: 'TOURNAMENT_NEXT' });
  await send(service, loser, { type: 'TOURNAMENT_PAUSE' });
  await send(service, winner, { type: 'TOURNAMENT_PAUSE' });
}
const standing = (player: Player) => player.client.snapshot.myStanding!;

describe('tournament lifecycle and registration', () => {
  beforeEach(() => { vi.useFakeTimers({ now: START }); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps registration idempotent, allows withdrawal only before the cutoff, and never queues registrants', async () => {
    const events: TournamentServiceEvent[] = [];
    const [a, b] = [human(1), human(2)];
    const { service } = await makeService({ onEvent: (event) => { events.push(event); } });
    await send(service, a, { type: 'TOURNAMENT_REGISTER' });
    await send(service, a, { type: 'TOURNAMENT_REGISTER' });
    await send(service, b, { type: 'TOURNAMENT_REGISTER' });
    await send(service, b, { type: 'TOURNAMENT_UNREGISTER' });
    await service.settle();
    expect(a.client.snapshot).toMatchObject({ phase: 'recruiting', registered: true, status: 'idle', registrationCount: 1 });
    expect(events.filter((event) => event.kind === 'register')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'unregister')).toHaveLength(1);
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    expect(a.client.errors()).toContain('NOT_STARTED');
    await send(service, b, { type: 'TOURNAMENT_REGISTER' });
    await advanceTo(REG_END);
    await send(service, a, { type: 'TOURNAMENT_UNREGISTER' });
    expect(a.client.errors()).toContain('REGISTRATION_CLOSED');
    await advanceTo(GAME_START + 1);
    expect(service.snapshotFor(a.id.playerId)).toMatchObject({ phase: 'active', registered: true, status: 'idle' });
    expect(service.activeHumans()).toBe(0);
  });

  it('confirms at exactly the minimum counted at the deadline and ignores late sign-ups for the decision', async () => {
    const events: TournamentServiceEvent[] = [];
    const players = [human(1), human(2), human(3)];
    const { service } = await makeService({ settings: settings({ minimumParticipants: 3 }), onEvent: (event) => { events.push(event); } });
    await registerAll(service, players.slice(0, 3));
    await advanceTo(REG_END);
    await service.settle();
    expect(service.phase()).toBe('confirmed');
    expect(events.filter((event) => event.kind === 'confirmed')).toEqual([
      expect.objectContaining({ id: 'cup-2:confirmed:decision', playerIds: players.map((p) => p.id.playerId).sort(), data: expect.objectContaining({ registrationCount: 3 }) }),
    ]);
  });

  it('cancels below the minimum, includes only a configured next event, and refuses entry', async () => {
    const events: TournamentServiceEvent[] = [];
    const next = { id: 'cup-3', title: '천하제일몽진대회', startsAt: GAME_END + 86_400_000, endsAt: GAME_END + 90_000_000 };
    const [a, b, late] = [human(1), human(2), human(3)];
    const { service } = await makeService({
      settings: settings({ minimumParticipants: 3, nextTournament: next }),
      onEvent: (event) => { events.push(event); },
    });
    await registerAll(service, [a, b]);
    await vi.advanceTimersByTimeAsync(REG_END - Date.now() - 1);
    await advanceTo(REG_END);
    await send(service, late, { type: 'TOURNAMENT_REGISTER' });
    await service.settle();
    expect(service.phase()).toBe('cancelled');
    expect(late.client.errors()).toContain('CANCELLED');
    const cancelled = events.filter((event) => event.kind === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data).toMatchObject({ registrationCount: 2, nextTournament: next });
    await advanceTo(GAME_START + 1);
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    expect(a.client.errors()).toContain('CANCELLED');
    expect(service.publicStatus()).toMatchObject({ phase: 'cancelled', nextTournament: next });

    const noNext: TournamentServiceEvent[] = [];
    vi.setSystemTime(START);
    const other = await makeService({ settings: settings({ id: 'cup-x', minimumParticipants: 3 }), onEvent: (event) => { noNext.push(event); } });
    await advanceTo(REG_END);
    await other.service.settle();
    expect(noNext.find((event) => event.kind === 'cancelled')!.data).not.toHaveProperty('nextTournament');
  });

  it('sends a reminder only when the decision precedes the lead window, then a start event', async () => {
    const events: TournamentServiceEvent[] = [];
    const s = settings({ registrationEndsAt: START + 60_000, startsAt: START + 7_200_000, endsAt: START + 10_800_000 });
    const players = [human(1), human(2)];
    const { service } = await makeService({ settings: s, onEvent: (event) => { events.push(event); } });
    await registerAll(service, players);
    await advanceTo(s.startsAt - s.reminderLeadMs + 1);
    await advanceTo(s.startsAt + 1);
    await service.settle();
    expect(events.map((event) => event.kind).filter((kind) => ['confirmed', 'reminder', 'started'].includes(kind)))
      .toEqual(['confirmed', 'reminder', 'started']);

    const short: TournamentServiceEvent[] = [];
    vi.setSystemTime(START);
    const late = await makeService({ settings: settings({ id: 'cup-short' }), onEvent: (event) => { short.push(event); } });
    await registerAll(late.service, players);
    await advanceTo(GAME_START + 1);
    await late.service.settle();
    expect(short.some((event) => event.kind === 'reminder')).toBe(false);
  });

  it('lets a first-time player join during the event as a late registration and records enter/reenter', async () => {
    const events: TournamentServiceEvent[] = [];
    const [a, b, walkIn] = [human(1), human(2), human(3)];
    const { service } = await openWith([a, b], { onEvent: (event) => { events.push(event); } });
    await send(service, walkIn, { type: 'TOURNAMENT_JOIN' });
    expect(walkIn.client.snapshot).toMatchObject({ registered: true, status: 'queued' });
    await send(service, walkIn, { type: 'TOURNAMENT_PAUSE' });
    await send(service, walkIn, { type: 'TOURNAMENT_JOIN' });
    await service.settle();
    const mine = events.filter((event) => event.playerIds.includes(walkIn.id.playerId)).map((event) => [event.kind, event.data.late ?? null]);
    expect(mine).toEqual([['register', true], ['enter', null], ['leave', null], ['reenter', null]]);
  });

  it('rejects missing protocol versions and ranked bot identities', async () => {
    const a = human(1);
    const { service } = await makeService();
    await service.handle(a.client, a.id, { type: 'TOURNAMENT_REGISTER' });
    await service.handle(a.client, a.id, { type: 'TOURNAMENT_REGISTER', protocolVersion: 1 });
    expect(a.client.errors()).toEqual(['UPDATE_REQUIRED', 'UPDATE_REQUIRED']);
    const bot: Player = { id: { playerId: RANKED_BOTS[0]!.id, name: '봇', platform: 'unknown' }, client: new FakeClient() };
    await send(service, bot, { type: 'TOURNAMENT_REGISTER' });
    expect(bot.client.errors()).toContain('NOT_ELIGIBLE');
  });
});

describe('tournament matching and start countdown', () => {
  beforeEach(() => { vi.useFakeTimers({ now: START }); });
  afterEach(() => { vi.useRealTimers(); });

  it('pairs players from different platforms, waits for both ready, then starts the clock only after the countdown', async () => {
    const events: TournamentServiceEvent[] = [];
    const [toss, mobile] = [human(1, 'toss'), human(2, 'mobile')];
    const { service, store } = await openWith([toss, mobile], { onEvent: (event) => { events.push(event); } });
    await send(service, toss, { type: 'TOURNAMENT_JOIN' });
    await send(service, mobile, { type: 'TOURNAMENT_JOIN' });
    const match = toss.client.snapshot.match!;
    expect(toss.client.snapshot.status).toBe('preparing');
    expect(match).toMatchObject({ status: 'preparing', startsAt: null, turnDeadline: null, countsForScore: true, scoredMatchNumber: 1 });
    await send(service, toss, { type: 'TOURNAMENT_MOVE', matchId: match.id, move: { kind: 'PLACE', to: { r: 0, c: 0 } }, ply: 0 });
    expect(toss.client.errors()).toContain('NOT_READY');
    await send(service, toss, { type: 'TOURNAMENT_READY', matchId: match.id });
    expect(mobile.client.snapshot.match).toMatchObject({ status: 'preparing', ready: false, opponentReady: true });
    await send(service, mobile, { type: 'TOURNAMENT_READY', matchId: match.id });
    const countdown = toss.client.snapshot.match!;
    expect(countdown).toMatchObject({ status: 'countdown', startsAt: Date.now() + 5_000, turnDeadline: null });
    expect(service.canPractice(toss.id.playerId)).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(toss.client.snapshot.match!.status).toBe('countdown');
    expect((await store.load()).matches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    const playing = toss.client.snapshot.match!;
    expect(playing).toMatchObject({ status: 'playing', turnDeadline: Date.now() + 30_000 });
    await service.settle();
    const found = events.find((event) => event.kind === 'match_found')!;
    expect(found.data).toMatchObject({
      blackId: toss.id.playerId, whiteId: mobile.id.playerId, blackPlatform: 'toss', whitePlatform: 'mobile',
      waitedMs: { [toss.id.playerId]: expect.any(Number), [mobile.id.playerId]: 0 },
    });
    expect(events.find((event) => event.kind === 'match_started')!.data).toMatchObject({ blackId: toss.id.playerId, whiteId: mobile.id.playerId });
    expect(service.publicStatus().config).toMatchObject({ matchCountdownMs: 5_000 });
    const matchId = playing.id;
    await send(service, mobile, { type: 'TOURNAMENT_RESIGN', matchId });
    await service.settle();
    expect(events.find((event) => event.kind === 'match_complete')!.data).toMatchObject({
      blackId: toss.id.playerId, whiteId: mobile.id.playerId, winnerId: toss.id.playerId, blackDelta: 16, whiteDelta: -16,
    });
  });

  it('cancels before start without score when readiness times out or someone leaves, requeueing the other in order', async () => {
    const [a, b, c] = [human(1), human(2), human(3)];
    const { service, store } = await openWith([a, b, c]);
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    const aQueuedAt = a.client.snapshot.queuedAt;
    await send(service, b, { type: 'TOURNAMENT_JOIN' });
    const first = a.client.snapshot.match!.id;
    await send(service, a, { type: 'TOURNAMENT_READY', matchId: first });
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(a.client.snapshot).toMatchObject({ status: 'queued', queuedAt: aQueuedAt, match: null });
    expect(b.client.snapshot).toMatchObject({ status: 'idle', match: null });

    await send(service, c, { type: 'TOURNAMENT_JOIN' });
    const second = a.client.snapshot.match!.id;
    await send(service, a, { type: 'TOURNAMENT_READY', matchId: second });
    await send(service, c, { type: 'TOURNAMENT_READY', matchId: second });
    service.detach(c.client);
    expect(a.client.snapshot).toMatchObject({ status: 'queued', queuedAt: aQueuedAt });

    await send(service, b, { type: 'TOURNAMENT_JOIN' });
    await send(service, b, { type: 'TOURNAMENT_PAUSE' });
    expect(a.client.snapshot.status).toBe('queued');
    expect(b.client.snapshot.status).toBe('idle');
    await flush();
    expect((await store.load()).matches).toHaveLength(0);
    expect(a.client.snapshot.myStanding).toMatchObject({ games: 0, points: 0 });
  });

  it('does not start a game whose countdown reaches the end time and stops matching afterwards', async () => {
    const [a, b] = [human(1), human(2)];
    const { service, store } = await openWith([a, b], { settings: settings({ endsAt: GAME_START + 10_000 }) });
    await vi.advanceTimersByTimeAsync(6_000);
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    await send(service, b, { type: 'TOURNAMENT_JOIN' });
    const matchId = a.client.snapshot.match!.id;
    await send(service, a, { type: 'TOURNAMENT_READY', matchId });
    await send(service, b, { type: 'TOURNAMENT_READY', matchId });
    await advanceTo(GAME_START + 12_000);
    await service.settle();
    expect(a.client.snapshot).toMatchObject({ phase: 'finished', status: 'idle', match: null });
    expect((await store.load()).matches).toHaveLength(0);
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    expect(a.client.errors()).toContain('ENDED');
  });

  it('keeps a finished result until an explicit NEXT and never auto-queues', async () => {
    const [a, b] = [human(1), human(2)];
    const { service } = await openWith([a, b]);
    const matchId = await startGame(service, a, b);
    await send(service, b, { type: 'TOURNAMENT_RESIGN', matchId });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.client.snapshot.status).toBe('result');
    expect(a.client.snapshot.match!.result).toMatchObject({ outcome: 'win', pointsAwarded: 16 });
    await send(service, a, { type: 'TOURNAMENT_NEXT' });
    expect(a.client.snapshot.status).toBe('queued');
  });
});

describe('tournament Elo scoring and ranking', () => {
  beforeEach(() => { vi.useFakeTimers({ now: START }); });
  afterEach(() => { vi.useRealTimers(); });

  it('scores every completed game from zero with symmetric Elo, allows negatives, and counts a sixth game', async () => {
    const [a, b] = [human(1), human(2)];
    const { service, store } = await openWith([a, b]);
    await playAndLose(service, a, b);
    expect(standing(a)).toMatchObject({ points: 16, games: 1, rank: null, qualified: false });
    expect(standing(b)).toMatchObject({ points: -16 });
    for (let i = 0; i < 4; i += 1) await playAndLose(service, a, b);
    const before = standing(b).points;
    await playAndLose(service, b, a); // 여섯 번째 경기: 낮은 점수에게 진 쪽이 더 많이 잃는다
    const gained = standing(b).points - before;
    expect(gained).toBeGreaterThan(16);
    expect(standing(a).points + standing(b).points).toBe(0);
    expect(standing(a)).toMatchObject({ games: 6, wins: 5, losses: 1, scoredGames: 6, qualified: true, rank: 1 });
    const completed = (await store.load()).matches.filter((match) => match.status === 'completed');
    expect(completed).toHaveLength(6);
    for (const match of completed) {
      expect(match.blackDelta! + match.whiteDelta!).toBe(0);
      expect(match.blackRatingAfter).toBe(match.blackRatingBefore! + match.blackDelta!);
    }
  });

  it('counts a move timeout as a scored loss and applies a duplicate finish only once', async () => {
    const [a, b] = [human(1), human(2)];
    const { service, store } = await openWith([a, b]);
    const matchId = await startGame(service, a, b);
    await vi.advanceTimersByTimeAsync(30_000);
    await send(service, b, { type: 'TOURNAMENT_RESIGN', matchId });
    await flush();
    expect(standing(a)).toMatchObject({ points: -16, losses: 1, games: 1 });
    expect(standing(b)).toMatchObject({ points: 16, wins: 1 });
    expect((await store.load()).matches.filter((match) => match.status === 'completed')).toHaveLength(1);
  });

  it('shares the title between equal qualified leaders and emits a champion event per winner once', async () => {
    const events: TournamentServiceEvent[] = [];
    const [a, b, c, d] = [human(1), human(2), human(3), human(4)];
    const dir = await mkdtemp(join(tmpdir(), 'mongjin-tournament-'));
    try {
      const file = join(dir, 'cup.json');
      const s = settings({ minimumRankedMatches: 2 });
      const { service } = await openWith([a, b, c, d], { store: new FileTournamentStore('cup-2', file), settings: s, onEvent: (event) => { events.push(event); } });
      // a와 c가 각각 b, d를 두 번씩 이긴다: 같은 점수·승률, 서로 대결 없음 → 공동 1위
      await playAndLose(service, a, b);
      await playAndLose(service, c, d);
      await playAndLose(service, a, b);
      await playAndLose(service, c, d);
      expect(standing(a)).toMatchObject({ rank: 1 });
      expect(standing(c)).toMatchObject({ rank: 1 });
      expect(standing(b)).toMatchObject({ rank: 3 });
      await advanceTo(GAME_END + 1);
      await service.settle();
      expect(service.phase()).toBe('finished');
      const champions = events.filter((event) => event.kind === 'champion');
      expect(champions.map((event) => event.playerIds[0]).sort()).toEqual([a.id.playerId, c.id.playerId]);
      expect(champions[0]!.data).toMatchObject({ championTitle: DEFAULT_INAUGURAL_CHAMPION_TITLE, shared: true });
      expect(service.snapshotFor(a.id.playerId).myStanding!.championTitle).toBe(DEFAULT_INAUGURAL_CHAMPION_TITLE);
      await service.shutdown();

      const restarted = await makeService({ store: new FileTournamentStore('cup-2', file), settings: s, onEvent: (event) => { events.push(event); } });
      await vi.advanceTimersByTimeAsync(5_000);
      await restarted.service.settle();
      expect(events.filter((event) => event.kind === 'champion')).toHaveLength(2);
      expect(restarted.service.snapshotFor(c.id.playerId).myStanding).toMatchObject({ rank: 1, championTitle: DEFAULT_INAUGURAL_CHAMPION_TITLE });
      await restarted.service.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tournament persistence and event journal', () => {
  beforeEach(() => { vi.useFakeTimers({ now: START }); });
  afterEach(() => { vi.useRealTimers(); });

  it('restores points from stored deltas, closes unfinished games without score and ignores legacy records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mongjin-tournament-'));
    try {
      const file = join(dir, 'cup.json');
      const [a, b] = [human(1), human(2)];
      const first = await openWith([a, b], { store: new FileTournamentStore('cup-2', file) });
      await playAndLose(first.service, a, b);
      await startGame(first.service, a, b);
      await first.service.shutdown();

      // 이전 버전(봇 포함) 완료 기록을 섞어 둔다: 새 Elo에 재해석되면 안 된다
      const raw = JSON.parse(await readFile(file, 'utf8'));
      raw.matches.legacy = {
        matchId: 'legacy', blackId: a.id.playerId, whiteId: 'bot-x', blackKind: 'human', whiteKind: 'bot',
        blackName: '참가자1', whiteName: '봇', status: 'completed', winner: 'BLACK', startedAt: new Date(START).toISOString(),
      };
      await writeFile(file, JSON.stringify(raw));

      const second = await makeService({ store: new FileTournamentStore('cup-2', file) });
      expect(second.service.snapshotFor(a.id.playerId).myStanding).toMatchObject({ points: 16, games: 1, wins: 1 });
      expect(second.service.snapshotFor(b.id.playerId).myStanding).toMatchObject({ points: -16, games: 1 });
      const stored = await second.store.load();
      expect(stored.matches.filter((match) => match.status === 'abandoned')).toHaveLength(1);
      expect(stored.registrations.map((registration) => registration.playerId).sort()).toEqual([a.id.playerId, b.id.playerId]);
      await second.service.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries a failing event sink and redelivers only undelivered events after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mongjin-tournament-'));
    try {
      const file = join(dir, 'cup.json');
      const [a, b] = [human(1), human(2)];
      // 첫 프로세스: 수신자 없음 → 모두 미전달로 남는다
      const first = await makeService({ store: new FileTournamentStore('cup-2', file) });
      await registerAll(first.service, [a, b]);
      await first.service.shutdown();

      const received: string[] = [];
      let failures = 2;
      const second = await makeService({
        store: new FileTournamentStore('cup-2', file),
        onEvent: (event) => {
          if (failures-- > 0) throw new Error('inbox down');
          received.push(event.id);
        },
      });
      await flush();
      expect(received).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await second.service.settle();
      await flush();
      expect(received).toHaveLength(2);
      expect(new Set(received).size).toBe(2);
      await second.service.shutdown();

      const again: string[] = [];
      const third = await makeService({ store: new FileTournamentStore('cup-2', file), onEvent: (event) => { again.push(event.id); } });
      await third.service.settle();
      expect(again).toEqual([]);
      await third.service.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the first stored scoring rules when the environment changes between restarts', async () => {
    const store = new FileTournamentStore('cup-2', null);
    await makeService({ store, settings: settings({ startingScore: 0 }) });
    const restarted = await makeService({ store, settings: settings({ startingScore: 1_000, eloK: 64 }) });
    expect(restarted.service.publicStatus().config).toMatchObject({ startingScore: 0, eloK: 32 });
  });
});

describe('tournament settings from env', () => {
  it('is disabled without configuration and defaults to zero-start K32/400 Elo with min 3 ranked games', () => {
    expect(tournamentSettingsFromEnv({})).toBeNull();
    expect(tournamentSettingsFromEnv({ MONGJIN_TOURNAMENT_ID: 'x' }, { warn: () => undefined })).toBeNull();
    const env = {
      MONGJIN_TOURNAMENT_ID: 'cup-2',
      MONGJIN_TOURNAMENT_STARTS_AT: '2026-10-10T21:00:00+09:00',
      MONGJIN_TOURNAMENT_ENDS_AT: '2026-10-10T22:00:00+09:00',
    };
    const parsed = tournamentSettingsFromEnv(env)!;
    expect(parsed).toMatchObject({
      startingScore: 0, eloK: 32, eloScale: 400, minimumRankedMatches: 3, matchCountdownMs: 5_000,
      registrationStartsAt: 0, registrationEndsAt: parsed.startsAt, nextTournament: null, isInaugural: false,
    });
    expect(tournamentSettingsFromEnv({ ...env, MONGJIN_TOURNAMENT_STARTING_SCORE: '-50', MONGJIN_TOURNAMENT_MIN_RANKED_MATCHES: '5', MONGJIN_TOURNAMENT_INAUGURAL: '1' }))
      .toMatchObject({ startingScore: -50, minimumRankedMatches: 5, championTitle: DEFAULT_INAUGURAL_CHAMPION_TITLE });
    expect(tournamentSettingsFromEnv({ ...env, MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT: '2026-10-10T21:30:00+09:00' }, { warn: () => undefined })).toBeNull();
    expect(tournamentSettingsFromEnv({ ...env, MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT: 'nope' }, { warn: () => undefined })).toBeNull();
  });

  it('reports disabled status when not configured', async () => {
    const service = new TournamentService({ settings: null, store: null });
    await service.init();
    expect(service.publicStatus()).toMatchObject({ phase: 'disabled', config: null, entrantCount: 0, registrationCount: 0 });
  });
});
