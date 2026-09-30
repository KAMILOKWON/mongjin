import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentBackgroundDestination, TournamentServerMessage } from '../src/net/tournamentProtocol';
import { TournamentService, tournamentSettingsFromEnv, type TournamentClient, type TournamentIdentity, type TournamentServiceOptions, type TournamentSettings } from './tournament';
import { FileTournamentStore } from './tournamentStore';
import { isPresence, parseBackgroundDestination, type TournamentBackgroundChange } from './tournamentBackground';
import { RANKED_BOTS } from './rankedBots';

const BASE = Date.parse('2026-09-30T00:00:00Z');
const destination: TournamentBackgroundDestination = { kind: 'expo', token: 'ExpoPushToken[owned_test_token]' };
const env = {
  MONGJIN_TOURNAMENT_ID: 'background', MONGJIN_TOURNAMENT_STARTS_AT: String(BASE + 2_000),
  MONGJIN_TOURNAMENT_ENDS_AT: String(BASE + 3_600_000), MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT: String(BASE + 1_000),
};
class Client implements TournamentClient {
  messages: TournamentServerMessage[] = [];
  send(message: TournamentServerMessage) { this.messages.push(structuredClone(message)); }
  get snapshot() {
    const message = [...this.messages].reverse().find(m => m.type === 'TOURNAMENT_SNAPSHOT');
    if (message?.type !== 'TOURNAMENT_SNAPSHOT') throw new Error('missing snapshot');
    return message.snapshot;
  }
  get errors() { return this.messages.flatMap(m => m.type === 'TOURNAMENT_ERROR' ? [m.code] : []); }
}
const person = (playerId: string, platform: TournamentIdentity['platform'] = 'mobile') => ({
  identity: { playerId, name: playerId, platform }, client: new Client(),
});
type Person = ReturnType<typeof person>;
const services: TournamentService[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); });
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); vi.useRealTimers(); });

async function setup(overrides: Partial<TournamentServiceOptions> = {}, config: Partial<TournamentSettings> = {}) {
  const changes: TournamentBackgroundChange[] = [];
  const store = new FileTournamentStore('background', null);
  const settings = { ...tournamentSettingsFromEnv(env)!, ...config };
  const service = new TournamentService({ settings, store, random: () => 0,
    canBackgroundWait: () => true, onBackgroundChange: change => { changes.push(change); }, ...overrides });
  services.push(service); await service.init();
  const a = person('a', 'mobile'), b = person('b', 'toss'), c = person('c', 'steam');
  for (const p of [a, b, c]) await send(service, p, { type: 'TOURNAMENT_REGISTER' });
  await vi.advanceTimersByTimeAsync(2_001); await service.settle();
  return { service, store, changes, a, b, c };
}
async function send(service: TournamentService, p: Person, message: Record<string, unknown>) {
  await service.handle(p.client, p.identity, { protocolVersion: 2, ...message }); await service.settle();
}
const join = (s: TournamentService, p: Person) => send(s, p, { type: 'TOURNAMENT_JOIN' });
const background = (s: TournamentService, p: Person, dest: TournamentBackgroundDestination | undefined = destination) =>
  send(s, p, { type: 'TOURNAMENT_PRESENCE', state: 'background', destination: dest });
const foreground = (s: TournamentService, p: Person) => send(s, p, { type: 'TOURNAMENT_PRESENCE', state: 'foreground' });
const ready = (s: TournamentService, p: Person, matchId: string) => send(s, p, { type: 'TOURNAMENT_READY', matchId });
async function offlineMatch(config: Partial<TournamentSettings> = {}) {
  const h = await setup({}, config); await join(h.service, h.a); await background(h.service, h.a);
  h.service.detach(h.a.client); await join(h.service, h.b);
  return { ...h, matchId: h.b.client.snapshot.match!.id };
}
async function noScore(service: TournamentService, store: FileTournamentStore) {
  await service.settle(); expect((await store.load()).matches).toEqual([]);
  for (const id of ['a', 'b']) expect(service.snapshotFor(id).myStanding).toMatchObject({ games: 0, points: 0 });
}

describe('background protocol and settings', () => {
  it('defaults old settings, clamps environment lease/ready bounds, and exposes the canonical config names', async () => {
    expect(tournamentSettingsFromEnv(env)).toMatchObject({ backgroundLeaseMs: 600_000, backgroundReadyTimeoutMs: 60_000 });
    for (const [lease, readyMs, expectedLease, expectedReady] of [[0, 0, 60_000, 15_000], [9e9, 9e9, 3_600_000, 120_000]]) {
      expect(tournamentSettingsFromEnv({ ...env, MONGJIN_TOURNAMENT_BACKGROUND_LEASE_MS: String(lease), MONGJIN_TOURNAMENT_BACKGROUND_READY_TIMEOUT_MS: String(readyMs) }))
        .toMatchObject({ backgroundLeaseMs: expectedLease, backgroundReadyTimeoutMs: expectedReady });
    }
    const h = await setup({}, { backgroundLeaseMs: undefined, backgroundReadyTimeoutMs: undefined });
    expect(h.service.publicStatus().config).toMatchObject({ backgroundLeaseMs: 600_000, backgroundReadyTimeoutMs: 60_000 });
  });
  it('normalizes destinations without retaining extra fields and rejects malformed messages', async () => {
    expect(parseBackgroundDestination({ ...destination, playerId: 'victim', extra: true })).toEqual(destination);
    for (const value of [null, [], { kind: 'fake', token: 'x' }, { kind: 'expo', token: '' }, { kind: 'expo', token: 'x\n' }, { kind: 'expo', token: 'x'.repeat(513) }, { kind: 'live_activity', token: 'x', activityId: '' }]) expect(parseBackgroundDestination(value)).toBeNull();
    expect(isPresence('inactive')).toBe(false);
    const h = await setup(); await join(h.service, h.a);
    for (const msg of [{ state: 'inactive' }, { state: 'background', destination: { kind: 'fake', token: 'x' } }]) await send(h.service, h.a, { type: 'TOURNAMENT_PRESENCE', ...msg });
    expect(h.a.client.errors).toEqual(['INVALID_MESSAGE', 'INVALID_MESSAGE']);
    expect(h.service.backgroundStatus('a')).toMatchObject({ status: 'queued', presence: 'foreground', background: null });
  });
});

describe('server-owned human waiting', () => {
  it('keeps an offscreen connected player queued until an actual match', async () => {
    const h = await setup(); await join(h.service, h.a); const queuedAt = h.a.client.snapshot.queuedAt;
    await vi.advanceTimersByTimeAsync(601_000);
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'queued', queuedAt, presence: 'foreground' });
    await join(h.service, h.b);
    expect(h.b.client.snapshot.match).toMatchObject({ status: 'preparing', opponentReady: false });
  });
  it('keeps a disconnected queue even without a notification route and pairs only humans', async () => {
    const h = await setup({ canBackgroundWait: () => false }); await join(h.service, h.a);
    const queuedAt = h.a.client.snapshot.queuedAt;
    h.service.detach(h.a.client); await h.service.settle();
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'queued', queuedAt, presence: 'background',
      background: { state: 'waiting', expiresAt: h.service.publicStatus().config!.endsAt } });
    const bot = person(RANKED_BOTS[0]!.id); await join(h.service, bot);
    expect(bot.client.errors.at(-1)).toBe('NOT_ELIGIBLE');
    await join(h.service, h.b);
    const matchId = h.b.client.snapshot.match!.id;
    expect(h.b.client.snapshot.match).toMatchObject({ status: 'preparing', opponentConnected: false,
      opponentPresence: 'background', opponentReady: false, readyDeadline: Date.now() + 60_000 });
    expect(h.changes).toContainEqual(expect.objectContaining({ playerId: 'a', state: 'matched', matchId }));
    expect(h.service.snapshotFor('a').match).toMatchObject({ id: matchId, ready: false });
    await noScore(h.service, h.store);
  });
  it.each(['missing', 'unavailable', 'throws'] as const)('retains waiting with %s push capability', async mode => {
    const h = await setup({ canBackgroundWait: mode === 'throws' ? () => { throw new Error('unavailable'); } : () => false });
    await join(h.service, h.a);
    await send(h.service, h.a, { type: 'TOURNAMENT_PRESENCE', state: 'background',
      ...(mode === 'missing' ? {} : { destination }) });
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'queued', presence: 'background', pausedReason: null });
    h.service.detach(h.a.client);
    expect(h.service.snapshotFor('a').status).toBe('queued');
  });
  it('never accepts hidden READY, but resumes from a fresh foreground snapshot', async () => {
    const h = await offlineMatch();
    await ready(h.service, h.a, h.matchId);
    expect(h.a.client.errors.at(-1)).toBe('SUPERSEDED');
    const resumed = { ...h.a, client: new Client() };
    await send(h.service, resumed, { type: 'TOURNAMENT_STATUS' });
    expect(resumed.client.snapshot.match).toMatchObject({ status: 'preparing', ready: false });
    await ready(h.service, resumed, h.matchId);
    expect(resumed.client.errors.at(-1)).toBe('FOREGROUND_REQUIRED');
    await foreground(h.service, resumed);
    await ready(h.service, resumed, h.matchId);
    expect(resumed.client.snapshot.match?.ready).toBe(true);
  });
  it('expires an unready hidden match without score and returns the ready opponent to queue', async () => {
    const h = await offlineMatch(); await ready(h.service, h.b, h.matchId);
    await vi.advanceTimersByTimeAsync(60_000); await h.service.settle();
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'idle', pausedReason: 'not_ready', match: null });
    expect(h.service.snapshotFor('b').status).toBe('queued');
    await noScore(h.service, h.store);
  });
  it('cancels waiting explicitly and idempotently, without scoring', async () => {
    const h = await setup(); await join(h.service, h.a); h.service.detach(h.a.client);
    expect(h.service.cancelWaiting('a')).toBe(true);
    expect(h.service.cancelWaiting('a')).toBe(false);
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'idle', pausedReason: 'cancelled', background: null });
    await noScore(h.service, h.store);
  });
  it('ends server waiting at the tournament end and does not restore it after restart', async () => {
    const h = await setup({}, { endsAt: BASE + 3_000 }); await join(h.service, h.a); h.service.detach(h.a.client);
    await vi.advanceTimersByTimeAsync(1_000); await h.service.settle();
    expect(h.service.snapshotFor('a')).toMatchObject({ status: 'idle', pausedReason: 'ended', background: null });
    await h.service.shutdown();
    const restarted = new TournamentService({ settings: tournamentSettingsFromEnv(env), store: h.store }); services.push(restarted);
    await restarted.init();
    expect(restarted.snapshotFor('a')).toMatchObject({ registered: true, status: 'idle', match: null });
  });
});
