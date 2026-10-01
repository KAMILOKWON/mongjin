import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentServerMessage, TournamentSnapshot } from '../src/net/tournamentProtocol';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { chooseOfficialBotMove, createRankedBot } from './officialBot';
import {
  DEFAULT_INAUGURAL_CHAMPION_TITLE,
  parseTournamentRankedBotIds,
  TournamentService,
  tournamentSettingsFromEnv,
  type TournamentClient,
  type TournamentIdentity,
  type TournamentServiceEvent,
  type TournamentSettings,
} from './tournament';
import { FileTournamentStore, type TournamentStore } from './tournamentStore';
import { RANKED_BOTS } from './rankedBots';
import type { StoredProfile } from './profileRepository';

const START = Date.parse('2026-10-10T12:00:00Z');
const REG_END = START + 60_000;
const GAME_START = START + 120_000;
const GAME_END = GAME_START + 3_600_000;
const TOP_TOURNAMENT_BOT_IDS = [
  'ranked-bot-first-place', 'ranked-bot-uzumaki', 'ranked-bot-dawnstar', 'ranked-bot-guide',
];

function botProfiles(ids: readonly string[] = TOP_TOURNAMENT_BOT_IDS): StoredProfile[] {
  return ids.map((id) => {
    const definition = RANKED_BOTS.find((bot) => bot.id === id);
    if (!definition) throw new Error(`unknown fixture bot ${id}`);
    return {
      playerId: definition.id, token: `test-token-${id}`, name: definition.name,
      rating: definition.rating, wins: 0, losses: 0,
      createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    };
  });
}

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
  getBotProfiles?: () => Iterable<StoredProfile>;
  busy?: (id: string) => boolean;
  onEvent?: (event: TournamentServiceEvent) => Promise<void> | void;
}
const quiet = { error: () => undefined, warn: () => undefined, log: () => undefined };
async function makeService(opts: MakeOptions = {}) {
  const store = opts.store ?? new FileTournamentStore('cup-2', null);
  const service = new TournamentService({
    settings: opts.settings ?? settings(),
    store,
    getBotProfiles: opts.getBotProfiles,
    isPlayerBusyElsewhere: opts.busy,
    onEvent: opts.onEvent,
    random: () => 0.1, // 먼저 대기한 사람이 흑
    logger: quiet,
  });
  await service.init();
  return { service, store };
}

function botSettings(overrides: Partial<TournamentSettings> = {}, ids: readonly string[] = TOP_TOURNAMENT_BOT_IDS): TournamentSettings {
  return settings({ rankedBotIds: ids.join(','), ...overrides });
}

async function startBotGame(service: TournamentService, player: Player, waitMs: number): Promise<string> {
  await send(service, player, { type: 'TOURNAMENT_JOIN' });
  if (waitMs) {
    await vi.advanceTimersByTimeAsync(waitMs);
    await flush();
    service.tick();
  }
  const matchId = player.client.snapshot.match?.id;
  if (!matchId) throw new Error('human did not receive an idle tournament bot');
  await send(service, player, { type: 'TOURNAMENT_READY', matchId });
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  await service.settle();
  expect(player.client.snapshot.match).toMatchObject({ id: matchId, status: 'playing', opponentIsBot: true });
  return matchId;
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

  it('counts only validated configured bots at the cutoff and excludes late humans from the decision', async () => {
    const events: TournamentServiceEvent[] = [];
    const players = Array.from({ length: 6 }, (_, index) => human(20 + index));
    const profiles = botProfiles();
    const { service, store } = await makeService({
      settings: botSettings({ minimumParticipants: 10 }),
      getBotProfiles: () => profiles,
      onEvent: (event) => { events.push(event); },
    });
    await registerAll(service, players);
    expect(service.registrationCount()).toBe(10);
    expect(service.publicStatus().config).toMatchObject({ botCount: 4 });
    await advanceTo(REG_END);
    await service.settle();
    expect(service.phase()).toBe('confirmed');
    expect(events.find((event) => event.kind === 'confirmed')).toMatchObject({
      playerIds: players.map((player) => player.id.playerId).sort(),
      data: { registrationCount: 10, humanRegistrationCount: 6, botCount: 4 },
    });
    expect((await store.load()).registrations.map((registration) => registration.playerId).sort())
      .toEqual(players.map((player) => player.id.playerId).sort());

    const late = human(29);
    await send(service, late, { type: 'TOURNAMENT_REGISTER' });
    await service.settle();
    expect(late.client.snapshot.registered).toBe(true);
    expect(late.client.snapshot.registrationCount).toBe(11);
    expect(events.filter((event) => event.kind === 'confirmed')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'confirmed')!.data.registrationCount).toBe(10);
    await service.shutdown();
  });

  it('cancels below the minimum when five humans and four configured bots total only nine entrants', async () => {
    const events: TournamentServiceEvent[] = [];
    const players = Array.from({ length: 5 }, (_, index) => human(40 + index));
    const { service, store } = await makeService({
      settings: botSettings({ minimumParticipants: 10 }),
      getBotProfiles: () => botProfiles(),
      onEvent: (event) => { events.push(event); },
    });
    await registerAll(service, players);
    expect(service.registrationCount()).toBe(9);
    await advanceTo(REG_END);
    await service.settle();
    expect(service.phase()).toBe('cancelled');
    expect(events.find((event) => event.kind === 'cancelled')).toMatchObject({
      playerIds: players.map((player) => player.id.playerId).sort(),
      data: { registrationCount: 9, humanRegistrationCount: 5, botCount: 4, minimumParticipants: 10 },
    });
    expect((await store.load()).registrations.every((registration) => !TOP_TOURNAMENT_BOT_IDS.includes(registration.playerId))).toBe(true);
    await service.shutdown();
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

  it('keeps human-human matches ahead of bots, then pairs a lone human after waitMs with a ready connected idle bot', async () => {
    const botId = TOP_TOURNAMENT_BOT_IDS[0]!;
    const profiles = botProfiles([botId]);
    const events: TournamentServiceEvent[] = [];
    const [a, b] = [human(61), human(62)];
    const humanPair = await openWith([a, b], {
      settings: botSettings({}, [botId]), getBotProfiles: () => profiles,
      onEvent: (event) => { events.push(event); },
    });
    await send(humanPair.service, a, { type: 'TOURNAMENT_JOIN' });
    await send(humanPair.service, b, { type: 'TOURNAMENT_JOIN' });
    expect(a.client.snapshot.match?.id).toBe(b.client.snapshot.match?.id);
    expect(a.client.snapshot.match?.opponentIsBot).toBeUndefined();
    expect(humanPair.service.snapshotFor(botId).status).toBe('idle');
    await humanPair.service.shutdown();

    vi.setSystemTime(START);
    const lone = human(63);
    const botEventService = await openWith([lone], {
      settings: botSettings({}, [botId]), getBotProfiles: () => profiles,
      onEvent: (event) => { events.push(event); },
    });
    await send(botEventService.service, lone, { type: 'TOURNAMENT_JOIN' });
    await vi.advanceTimersByTimeAsync(14_999);
    await flush();
    expect(lone.client.snapshot).toMatchObject({ status: 'queued', match: null });
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    botEventService.service.tick();
    await botEventService.service.settle();
    const match = lone.client.snapshot.match!;
    expect(match).toMatchObject({ status: 'preparing', opponentIsBot: true, opponentReady: true, opponentConnected: true });
    expect(match.opponentName).toBe(profiles[0]!.name);
    expect(botEventService.service.snapshotFor(botId)).toMatchObject({ status: 'preparing', activeHumans: 1 });
    expect(events.find((event) => event.kind === 'match_found' && event.data.matchId === match.id)).toMatchObject({
      playerIds: [lone.id.playerId], data: { blackKind: 'human', whiteKind: 'bot' },
    });
    expect(events.some((event) => event.playerIds.includes(botId))).toBe(false);
    await botEventService.service.shutdown();
  });

  it('releases an idle bot when a human cancels a prepared bot match without creating a game record', async () => {
    const botId = TOP_TOURNAMENT_BOT_IDS[0]!;
    const a = human(64);
    const { service, store } = await openWith([a], {
      settings: botSettings({ waitMs: 0 }, [botId]), getBotProfiles: () => botProfiles([botId]),
    });
    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    const firstId = a.client.snapshot.match!.id;
    expect(service.snapshotFor(botId).status).toBe('preparing');
    expect(service.cancelWaiting(a.id.playerId)).toBe(true);
    await service.settle();
    expect(a.client.snapshot).toMatchObject({ status: 'idle', match: null, myStanding: { games: 0, points: 0 } });
    expect(service.snapshotFor(botId)).toMatchObject({ status: 'idle', match: null });
    expect((await store.load()).matches).toHaveLength(0);

    await send(service, a, { type: 'TOURNAMENT_JOIN' });
    expect(a.client.snapshot.match?.id).not.toBe(firstId);
    expect(a.client.snapshot.match).toMatchObject({ opponentIsBot: true, opponentName: botProfiles([botId])[0]!.name });
    await service.cancelWaiting(a.id.playerId);
    expect(service.snapshotFor(botId).status).toBe('idle');
    await service.shutdown();
  });

  it('applies a real official bot move legally after the automatic ready and countdown flow', async () => {
    const botId = TOP_TOURNAMENT_BOT_IDS[0]!;
    const profiles = botProfiles([botId]);
    const profilesBefore = structuredClone(profiles);
    const events: TournamentServiceEvent[] = [];
    const a = human(65);
    const { service, store } = await openWith([a], {
      settings: botSettings({ minimumRankedMatches: 1 }, [botId]), getBotProfiles: () => profiles,
      onEvent: (event) => { events.push(event); },
    });
    const matchId = await startBotGame(service, a, 15_000);
    const match = a.client.snapshot.match!;
    expect(match.side).toBe(match.state.turn);
    const humanMove = legalMoves(match.state, DEFAULT_CONFIG)[0]!;
    await send(service, a, { type: 'TOURNAMENT_MOVE', matchId, move: humanMove, ply: 0 });
    const beforeBotMove = a.client.snapshot.match!.state;
    expect(beforeBotMove.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(649);
    expect(a.client.snapshot.match!.state.history).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    const afterBotMove = a.client.snapshot.match!.state;
    expect(afterBotMove.history).toHaveLength(2);
    expect(legalMoves(beforeBotMove, DEFAULT_CONFIG)).toContainEqual(afterBotMove.history.at(-1));
    expect(afterBotMove.turn).toBe(a.client.snapshot.match!.side);

    await send(service, a, { type: 'TOURNAMENT_RESIGN', matchId });
    await flush();
    const completed = (await store.load()).matches.find((record) => record.matchId === matchId)!;
    expect(completed).toMatchObject({ status: 'completed', blackKind: 'human', whiteKind: 'bot', whiteName: profiles[0]!.name });
    expect(a.client.snapshot.myStanding).toMatchObject({ games: 1, losses: 1 });
    expect(service.snapshotFor(botId).myStanding).toBeNull();
    expect(service.publicStatus()).toMatchObject({ entrantCount: 1, registrationCount: 2 });
    expect(service.publicStatus().config).toMatchObject({ botCount: 1 });
    expect(events.filter((event) => ['match_found', 'match_started', 'match_complete'].includes(event.kind))
      .every((event) => event.playerIds.includes(a.id.playerId) && !event.playerIds.includes(botId))).toBe(true);
    expect(profiles).toEqual(profilesBefore);
    expect(service.snapshotFor(botId).status).toBe('idle');
    vi.setSystemTime(GAME_END + 1);
    service.tick();
    await service.settle();
    expect(service.phase()).toBe('finished');
    expect(events.find((event) => event.kind === 'finished')?.playerIds).toEqual([a.id.playerId]);
    expect(events.filter((event) => event.kind === 'champion').map((event) => event.playerIds[0])).toEqual([a.id.playerId]);
    expect(service.snapshotFor(botId).standings).toHaveLength(1);
    expect(service.snapshotFor(botId).myStanding).toBeNull();
    await service.shutdown();
  });
});

describe('tournament bot recovery and reuse', () => {
  beforeEach(() => { vi.useFakeTimers({ now: START }); });
  afterEach(() => { vi.useRealTimers(); });

  it('reuses the same bot after a completed match and restart, and abandons/reuses an interrupted match after another restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mongjin-tournament-bot-reuse-'));
    const botId = TOP_TOURNAMENT_BOT_IDS[0]!;
    const profiles = botProfiles([botId]);
    const profilesBefore = structuredClone(profiles);
    const eventRecipients: TournamentServiceEvent[] = [];
    const a = human(71);
    const s = botSettings({ waitMs: 0, minimumRankedMatches: 1 }, [botId]);
    const options: Pick<MakeOptions, 'settings' | 'getBotProfiles' | 'onEvent'> = {
      settings: s, getBotProfiles: () => profiles, onEvent: (event) => { eventRecipients.push(event); },
    };
    const file = join(dir, 'cup.json');
    try {
      const first = await openWith([a], { ...options, store: new FileTournamentStore('cup-2', file) });
      const firstId = await startBotGame(first.service, a, 0);
      await send(first.service, a, { type: 'TOURNAMENT_RESIGN', matchId: firstId });
      await flush();
      expect((await first.store.load()).matches).toMatchObject([expect.objectContaining({ matchId: firstId, status: 'completed', whiteId: botId })]);
      expect(first.service.snapshotFor(botId).status).toBe('idle');
      await first.service.shutdown();

      vi.setSystemTime(GAME_START + 2_000);
      const second = await makeService({ ...options, store: new FileTournamentStore('cup-2', file) });
      expect(second.service.snapshotFor(a.id.playerId).myStanding).toMatchObject({ games: 1, losses: 1 });
      expect(second.service.snapshotFor(botId).status).toBe('idle');
      await send(second.service, a, { type: 'TOURNAMENT_NEXT' });
      const secondId = a.client.snapshot.match!.id;
      expect(secondId).not.toBe(firstId);
      expect(a.client.snapshot.match).toMatchObject({ opponentIsBot: true, opponentName: profiles[0]!.name });
      await send(second.service, a, { type: 'TOURNAMENT_READY', matchId: secondId });
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      await send(second.service, a, { type: 'TOURNAMENT_RESIGN', matchId: secondId });
      await flush();
      const completedRecords = (await second.store.load()).matches.filter((record) => record.status === 'completed');
      expect(completedRecords).toHaveLength(2);
      expect(completedRecords.map((record) => record.whiteId)).toEqual([botId, botId]);
      expect(completedRecords.reduce((sum, record) => sum + (record.whiteDelta ?? 0), 0)).toBeGreaterThan(0);
      expect(second.service.snapshotFor(a.id.playerId).myStanding).toMatchObject({ games: 2, losses: 2 });
      await second.service.shutdown();

      vi.setSystemTime(GAME_START + 10_000);
      const third = await makeService({ ...options, store: new FileTournamentStore('cup-2', file) });
      await send(third.service, a, { type: 'TOURNAMENT_NEXT' });
      const interruptedId = a.client.snapshot.match!.id;
      await send(third.service, a, { type: 'TOURNAMENT_READY', matchId: interruptedId });
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      await third.service.shutdown();

      vi.setSystemTime(GAME_START + 20_000);
      const recovered = await makeService({ ...options, store: new FileTournamentStore('cup-2', file) });
      const interrupted = (await recovered.store.load()).matches.find((record) => record.matchId === interruptedId)!;
      expect(interrupted).toMatchObject({ status: 'abandoned', reason: 'abandoned', blackKind: 'human', whiteKind: 'bot', whiteId: botId });
      expect(recovered.service.snapshotFor(a.id.playerId).myStanding).toMatchObject({ games: 2, losses: 2 });
      expect(recovered.service.snapshotFor(botId).status).toBe('idle');
      await send(recovered.service, a, { type: 'TOURNAMENT_NEXT' });
      const afterRecoveryId = a.client.snapshot.match!.id;
      expect(afterRecoveryId).not.toBe(interruptedId);
      expect(a.client.snapshot.match).toMatchObject({ opponentIsBot: true, opponentName: profiles[0]!.name });
      expect(recovered.service.cancelWaiting(a.id.playerId)).toBe(true);
      expect(recovered.service.snapshotFor(botId).status).toBe('idle');
      vi.setSystemTime(GAME_END + 1);
      recovered.service.tick();
      await recovered.service.settle();
      const finalData = await recovered.store.load();
      const finalRecord = finalData.lifecycle.finalized!;
      expect(finalRecord.standings).toEqual([expect.objectContaining({ playerId: a.id.playerId, rank: 1 })]);
      expect(finalRecord.standings[0]!.points).toBeLessThan(0);
      expect(finalRecord.champions).toEqual([expect.objectContaining({
        playerId: a.id.playerId, points: finalRecord.standings[0]!.points, title: s.championTitle,
      })]);
      expect(recovered.service.snapshotFor(a.id.playerId).myStanding).toMatchObject({ championTitle: s.championTitle });
      expect(recovered.service.snapshotFor(botId).standings).toHaveLength(1);
      expect(recovered.service.snapshotFor(botId).myStanding).toBeNull();
      const finalEvents = eventRecipients.filter((event) => event.kind === 'finished' || event.kind === 'champion');
      expect(finalEvents).toHaveLength(2);
      expect(finalEvents.every((event) => !event.playerIds.includes(botId))).toBe(true);
      expect(finalEvents.find((event) => event.kind === 'finished')).toMatchObject({
        playerIds: [a.id.playerId], data: { championPlayerIds: [a.id.playerId], standingsTotal: 1 },
      });
      expect(finalEvents.find((event) => event.kind === 'champion')).toMatchObject({
        playerIds: [a.id.playerId], data: { championTitle: s.championTitle },
      });
      expect(finalData.registrations.map((registration) => registration.playerId)).toEqual([a.id.playerId]);
      expect(eventRecipients.some((event) => event.playerIds.includes(botId))).toBe(false);
      expect(profiles).toEqual(profilesBefore);
      await recovered.service.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
  it('is disabled without configuration and defaults to zero-start K32/400 Elo with min 3 ranked games', async () => {
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
    expect(parsed.rankedBotIds).toBeUndefined();
    expect(parseTournamentRankedBotIds(undefined)).toEqual([]);
    expect(parseTournamentRankedBotIds(` ${TOP_TOURNAMENT_BOT_IDS.join(' , ')} `)).toEqual(TOP_TOURNAMENT_BOT_IDS);
    for (const ids of [
      `${TOP_TOURNAMENT_BOT_IDS[0]},${TOP_TOURNAMENT_BOT_IDS[0]}`,
      'ranked-bot-unknown',
      ',ranked-bot-guide',
      [...TOP_TOURNAMENT_BOT_IDS, 'ranked-bot-may'].join(','),
    ]) {
      expect(parseTournamentRankedBotIds(ids)).toBeNull();
      expect(tournamentSettingsFromEnv({ ...env, MONGJIN_TOURNAMENT_RANKED_BOT_IDS: ids }, { warn: () => undefined })).toBeNull();
    }
    await expect(makeService({ settings: botSettings({}, [TOP_TOURNAMENT_BOT_IDS[0]!]), getBotProfiles: () => [] }))
      .rejects.toThrow('RANKED_BOT_PROFILE_UNAVAILABLE');
  });

  it('reports disabled status when not configured', async () => {
    const service = new TournamentService({ settings: null, store: null });
    await service.init();
    expect(service.publicStatus()).toMatchObject({ phase: 'disabled', config: null, entrantCount: 0, registrationCount: 0 });
  });
});

describe('real official tournament bot search samples', () => {
  it('measures one bounded legal opening search for each configured top-four profile', { timeout: 20_000 }, () => {
    const state = initialState(DEFAULT_CONFIG);
    const legal = legalMoves(state, DEFAULT_CONFIG);
    const samples = botProfiles().map((profile) => {
      const bot = createRankedBot(profile, () => 0.2);
      const started = performance.now();
      const move = chooseOfficialBotMove(bot, state, DEFAULT_CONFIG);
      const elapsedMs = Number((performance.now() - started).toFixed(1));
      expect(move).not.toBeNull();
      expect(legal).toContainEqual(move);
      expect(elapsedMs).toBeLessThan(bot.search.maxMs + 2_000);
      return { playerId: profile.playerId, elapsedMs, maxMs: bot.search.maxMs, move };
    });
    expect(samples.map((sample) => sample.playerId)).toEqual(TOP_TOURNAMENT_BOT_IDS);
    console.info(`[tournament-bot-search-sample] ${JSON.stringify(samples)}`);
  });
});
