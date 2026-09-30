import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityService } from './community';
import { FileCommunityStore } from './communityStore';
import { TournamentRegistry, validateTournamentSettings, type TournamentRegistryBackgroundOptions } from './tournamentRegistry';
import { FileTournamentStore } from './tournamentStore';
import type { TournamentBackgroundDestination, TournamentServerMessage, TournamentSnapshot } from '../src/net/tournamentProtocol';
import type { TournamentBackgroundChange } from './tournamentBackground';
import { WaitingNotifications } from './waitingNotifications';

let dir: string, community: CommunityService;
const registries: TournamentRegistry[] = [];
const input = (id = 'cup', offset = 10000) => ({ id, title: '천하제일몽진대회', registrationStartsAt: Date.now() - 1000, registrationEndsAt: Date.now() + offset - 2000, startsAt: Date.now() + offset, endsAt: Date.now() + offset + 60000, rewardDescription: '운영자 확인 보상' });
async function registry(env: Record<string, string> = {}, options: TournamentRegistryBackgroundOptions = {}) {
  const r = new TournamentRegistry(community, join(dir, 'tournaments'), () => false, { DATABASE_URL: '', ...env }, options);
  registries.push(r); await r.initialize(); return r;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
  dir = await mkdtemp(join(tmpdir(), 'mongjin-registry-'));
  community = new CommunityService(new FileCommunityStore(join(dir, 'community.json')));
});

describe('registry background integration contract', () => {
  const destination = { kind: 'expo' as const, token: 'ExpoPushToken[registry_owned]' };
  function peer(playerId: string, platform: 'mobile' | 'toss' = 'mobile') {
    const messages: TournamentServerMessage[] = [];
    return { identity: { playerId, name: playerId, platform }, client: { send: (m: TournamentServerMessage) => messages.push(structuredClone(m)) },
      get snapshot(): TournamentSnapshot {
        const message = [...messages].reverse().find(m => m.type === 'TOURNAMENT_SNAPSHOT');
        if (message?.type !== 'TOURNAMENT_SNAPSHOT') throw new Error('missing snapshot');
        return message.snapshot;
      }, messages };
  }
  type Peer = ReturnType<typeof peer>;
  const command = (r: TournamentRegistry, p: Peer, message: Record<string, unknown>) => r.handle(p.client, p.identity, { protocolVersion: 2, tournamentId: 'cup', ...message });
  async function active(options: TournamentRegistryBackgroundOptions = {}) {
    const r = await registry({}, options), event = { ...input(), endsAt: Date.now() + 3_600_000 };
    await r.publish(event); const a = peer('a'), b = peer('b', 'toss');
    for (const p of [a, b]) await command(r, p, { type: 'TOURNAMENT_REGISTER' });
    await vi.advanceTimersByTimeAsync(10_001);
    return { r, a, b };
  }

  it('defaults recovered schedules missing lease fields and rejects out-of-range operator values', async () => {
    const legacy = validateTournamentSettings(input()); delete legacy.backgroundLeaseMs; delete legacy.backgroundReadyTimeoutMs;
    await community.store.commit([{ namespace: 'schedules', key: legacy.id, value: legacy }]);
    const store = new FileTournamentStore(legacy.id, join(dir, 'tournaments', `${legacy.id}.json`)); await store.saveSettings({ ...legacy }); await store.close();
    const r = await registry();
    expect(r.publicStatus('cup').config).toMatchObject({ backgroundLeaseMs: 600_000, backgroundReadyTimeoutMs: 60_000 });
    expect((await r.publish(legacy as unknown as Record<string, unknown>)).config?.id).toBe('cup');
    for (const patch of [{ backgroundLeaseMs: 59_999 }, { backgroundLeaseMs: 3_600_001 }, { backgroundLeaseMs: '600000' }, { backgroundReadyTimeoutMs: 14_999 }, { backgroundReadyTimeoutMs: 120_001 }, { backgroundReadyTimeoutMs: 60_000.1 }]) {
      expect(() => validateTournamentSettings({ ...input(), ...patch })).toThrow('INVALID_SETTINGS');
    }
    expect(validateTournamentSettings({ ...input(), backgroundLeaseMs: 60_000, backgroundReadyTimeoutMs: 120_000 }))
      .toMatchObject({ backgroundLeaseMs: 60_000, backgroundReadyTimeoutMs: 120_000 });
  });

  it('returns detached readonly REST summaries without game state, identities or destination tokens', async () => {
    const h = await active({ canBackgroundWait: () => true }); await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' });
    await command(h.r, h.a, { type: 'TOURNAMENT_PRESENCE', state: 'background', destination });
    const summary = h.r.backgroundStatus('a', 'cup')!;
    expect(Object.keys(summary).sort()).toEqual(['tournamentId', 'status', 'presence', 'background', 'pausedReason'].sort());
    expect(summary).toMatchObject({ tournamentId: 'cup', status: 'queued', presence: 'background', background: { state: 'waiting', matchId: null } });
    const expiresAt = summary.background!.expiresAt; summary.background!.expiresAt = 0; summary.status = 'playing';
    expect(h.r.backgroundStatus('a', 'cup')).toMatchObject({ status: 'queued', background: { expiresAt } });
    expect(JSON.stringify(summary)).not.toContain(destination.token);
    expect(h.r.backgroundStatus('a', 'unknown')).toBeNull();
    expect(h.r.backgroundStatus('other-account', 'cup')).toMatchObject({ status: 'idle', background: null });
    expect(h.r.backgroundStatus('a', 'cup')?.background?.expiresAt).toBe(expiresAt);
  });

  it('keeps disconnected preparation independent of push capability and cancels without score', async () => {
    const changes: TournamentBackgroundChange[] = [], check = vi.fn((playerId: string, tournamentId: string, dest: TournamentBackgroundDestination) => playerId === 'a' && tournamentId === 'cup' && dest.token === destination.token);
    const h = await active({ canBackgroundWait: check, onBackgroundChange: change => { changes.push(change); } });
    await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' }); const originalQueuedAt = h.a.snapshot.queuedAt;
    await command(h.r, h.a, { type: 'TOURNAMENT_PRESENCE', state: 'background', destination }); h.r.detach(h.a.client);
    await command(h.r, h.b, { type: 'TOURNAMENT_JOIN' }); const matchId = h.b.snapshot.match!.id;
    expect(check).not.toHaveBeenCalled();
    expect(h.b.snapshot.match).toMatchObject({ status: 'preparing', opponentPresence: 'background', opponentConnected: false, readyDeadline: Date.now() + 60_000 });
    await command(h.r, h.b, { type: 'TOURNAMENT_READY', matchId });
    const resumed = peer('a'); await command(h.r, resumed, { type: 'TOURNAMENT_PRESENCE', state: 'foreground' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.r.backgroundStatus('a', 'cup')?.background).toBeNull();
    expect(changes.map(change => change.state)).toEqual(['waiting', 'matched', 'matched', 'ended']);
    expect(h.r.cancelWaiting('a', 'cup')).toBe(true); expect(h.r.cancelWaiting('a', 'cup')).toBe(false);
    expect(h.r.backgroundStatus('a', 'cup')).toMatchObject({ status: 'idle', pausedReason: 'cancelled' });
    expect(h.b.snapshot).toMatchObject({ status: 'queued', match: null, myStanding: { games: 0, points: 0 } });
    expect(resumed.snapshot.myStanding).toMatchObject({ games: 0, points: 0 });
    await command(h.r, resumed, { type: 'TOURNAMENT_READY', matchId });
    expect(resumed.messages.at(-2)).toMatchObject({ type: 'TOURNAMENT_ERROR', code: 'NO_MATCH' });
    const records = await h.r.completedRecords(); expect(records).toEqual([]); expect(originalQueuedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)?.state).toBe('waiting');
  });

  it('cancelWaiting never resigns or mutates a started human game and only the explicit event is affected', async () => {
    const h = await active(); await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' }); await command(h.r, h.b, { type: 'TOURNAMENT_JOIN' });
    const matchId = h.a.snapshot.match!.id;
    await command(h.r, h.a, { type: 'TOURNAMENT_READY', matchId }); await command(h.r, h.b, { type: 'TOURNAMENT_READY', matchId });
    await vi.advanceTimersByTimeAsync(5_000);
    const before = structuredClone(h.a.snapshot.match);
    expect(h.r.cancelWaiting('a', 'unknown')).toBe(false); expect(h.r.cancelWaiting('a', 'cup')).toBe(false); expect(h.r.cancelWaiting('a')).toBe(false);
    await command(h.r, h.a, { type: 'TOURNAMENT_STATUS' });
    expect(h.a.snapshot.match).toEqual(before); expect(h.a.snapshot.myStanding).toMatchObject({ points: 0, games: 0 });
    expect(h.r.backgroundStatus('a', 'cup')?.status).toBe('playing');
  });

  it('keeps server waiting with an owned device when match push is disabled', async () => {
    const notifications = new WaitingNotifications(community.store, { MONGJIN_MATCH_PUSH_ENABLED: '0' }, async () => { throw new Error('unexpected transport'); });
    const h = await active({ canBackgroundWait: (id, event, dest) => notifications.canBackgroundWait(id, event, dest as typeof destination),
      onBackgroundChange: change => notifications.update(change) });
    await notifications.register('a', 'cup', destination); await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' });
    await command(h.r, h.a, { type: 'TOURNAMENT_PRESENCE', state: 'background', destination });
    expect(h.r.backgroundStatus('a', 'cup')).toMatchObject({ status: 'queued', pausedReason: null, background: { state: 'waiting' } });
    await h.r.shutdown(); await notifications.close();
  });

  it('cancelWaiting without event is idempotent and account switching cannot inherit another account lease', async () => {
    const h = await active({ canBackgroundWait: () => true }); await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' });
    expect(h.r.cancelWaiting('a')).toBe(true); expect(h.r.cancelWaiting('a')).toBe(false);
    await command(h.r, h.a, { type: 'TOURNAMENT_JOIN' });
    await h.r.handle(h.a.client, { playerId: 'other', name: '다른 계정', platform: 'mobile' }, { type: 'TOURNAMENT_PRESENCE', protocolVersion: 2, tournamentId: 'cup', state: 'background', destination });
    expect(h.r.backgroundStatus('a', 'cup')).toMatchObject({ status: 'queued', background: { state: 'waiting' } });
    expect(h.r.backgroundStatus('other', 'cup')).toMatchObject({ status: 'idle', presence: 'background', background: null });
  });
});
afterEach(async () => {
  for (const r of registries.splice(0)) await r.shutdown();
  await community.store.close(); await rm(dir, { recursive: true, force: true }); vi.useRealTimers();
});
describe('operator tournament settings', () => {
  it('rejects coercion, silent clamping, invalid dates and unsupported scoring', () => {
    for (const patch of [{ eloK: 401 }, { eloScale: 49 }, { minimumRankedMatches: 1001 }, { startingScore: 100 }, { minimumParticipants: '50' }, { minimumParticipants: 1 }, { moveTimeMs: 1 }, { isInaugural: 'true' }, { id: '../cup' }, { startsAt: '2026-10-02T12:00:00' }, { startsAt: '2026-02-30T12:00:00Z' }, { startsAt: '2026-10-02T24:00:00Z' }, { id: ' cup ' }, { secret: 'hidden' }, { nextTournament: { id: 'cup' } }]) {
      expect(() => validateTournamentSettings({ ...input(), ...patch }), JSON.stringify(patch)).toThrow('INVALID_SETTINGS');
    }
    expect(validateTournamentSettings({ ...input(), eloK: 24, eloScale: 500, minimumRankedMatches: 4 })).toMatchObject({ eloK: 24, eloScale: 500, minimumRankedMatches: 4 });
    const s = validateTournamentSettings(input());
    expect(validateTournamentSettings(s as unknown as Record<string, unknown>)).toEqual(s);
    expect([s.startingScore, s.eloK, s.eloScale, s.minimumRankedMatches]).toEqual([0, 32, 400, 3]);
  });
});
describe('multi-event registry with real stores/services', () => {
  it('serializes overlap checks and preserves published IDs even on reordered retry', async () => {
    const r = await registry(), a = input('a'), b = input('b');
    const results = await Promise.allSettled([r.publish(a), r.publish(b)]);
    expect(results.map(x => x.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('OVERLAPPING_EVENTS');
    expect((await r.publish(Object.fromEntries(Object.entries(a).reverse()))).config?.id).toBe('a');
    await expect(r.publish({ ...a, endsAt: a.endsAt + 1 })).rejects.toThrow('EVENT_ALREADY_PUBLISHED');
    await expect(r.publish({ ...input('past'), startsAt: Date.now() - 1, registrationEndsAt: Date.now() - 2 })).rejects.toThrow('INVALID_SETTINGS');
    const copy = r.list(); copy[0].settings.title = 'mutated';
    expect(r.list()[0].settings.title).not.toBe('mutated');
  });
  it('recovers all schedules from disk and keeps HTTP/WS next-event snapshots identical', async () => {
    const r = await registry(), a = input('a'), b = input('b', 80000);
    await r.publish(a); await r.publish(b); await r.shutdown();
    community = new CommunityService(new FileCommunityStore(join(dir, 'community.json')));
    const recovered = await registry({ MONGJIN_TOURNAMENT_ID: 'a', MONGJIN_TOURNAMENT_STARTS_AT: String(Date.now() + 999999), MONGJIN_TOURNAMENT_ENDS_AT: String(Date.now() + 1999999) });
    expect(recovered.publicStatus('a').config?.startsAt).toBe(a.startsAt);
    const messages: TournamentServerMessage[] = [], client = { send: (m: TournamentServerMessage) => messages.push(m) };
    await recovered.handle(client, { playerId: 'human', name: '사람', platform: 'web' }, { type: 'TOURNAMENT_STATUS', protocolVersion: 2, tournamentId: 'a' });
    const snapshot = messages.at(-1)!;
    expect(snapshot.type).toBe('TOURNAMENT_SNAPSHOT');
    if (snapshot.type !== 'TOURNAMENT_SNAPSHOT') throw new Error('snapshot missing');
    expect(snapshot.snapshot.nextTournament).toEqual(recovered.publicStatus('a').nextTournament);
    expect(snapshot.snapshot.nextTournament?.id).toBe('b');
    await recovered.handle(client, { playerId: 'human', name: '사람', platform: 'web' }, { type: 'TOURNAMENT_STATUS', protocolVersion: 2, tournamentId: 'unknown' });
    expect(messages.at(-1)).toMatchObject({ type: 'TOURNAMENT_ERROR', code: 'INVALID_MESSAGE' });
    await recovered.handle(client, { playerId: 'human', name: '사람', platform: 'web' }, { type: 'TOURNAMENT_STATUS', protocolVersion: 2 });
    expect(messages.at(-1)).toMatchObject({ type: 'TOURNAMENT_SNAPSHOT', snapshot: { config: { id: 'a' } } });
  });
  it('emits cancellation with the real next schedule and reward metadata without inventing dates', async () => {
    const r = await registry(); await r.publish(input('a')); await r.publish(input('b', 80000));
    const identity = { playerId: 'human', name: '사람', platform: 'web' as const }, client = { send: () => undefined };
    await r.handle(client, identity, { type: 'TOURNAMENT_REGISTER', protocolVersion: 2, tournamentId: 'a' });
    await vi.advanceTimersByTimeAsync(9000); await r.shutdown();
    const events = await community.store.list<{ kind: string; tournamentId: string; data: Record<string, unknown> }>('events');
    const cancelled = events.find(e => e.kind === 'cancelled' && e.tournamentId === 'a');
    expect(cancelled?.data.nextTournament).toMatchObject({ id: 'b' });
    expect(cancelled?.data.rewardDescription).toBe('운영자 확인 보상');
    expect(r.publicStatus('b').nextTournament).toBeNull();
  });
  it('fails safely on corrupt/overlapping recovery before starting event services', async () => {
    await community.store.commit([{ namespace: 'schedules', key: 'a', value: validateTournamentSettings(input('a')) }, { namespace: 'schedules', key: 'b', value: validateTournamentSettings(input('b')) }]);
    await expect(registry()).rejects.toThrow('OVERLAPPING_EVENTS');
  });
  it('refuses to overwrite a recovered event whose immutable schedule differs', async () => {
    const a = validateTournamentSettings(input());
    await community.store.commit([{ namespace: 'schedules', key: a.id, value: a }]);
    const store = new FileTournamentStore(a.id, join(dir, 'tournaments', `${a.id}.json`));
    await store.saveSettings({ ...a, endsAt: a.endsAt + 1 }); await store.close();
    await expect(registry()).rejects.toThrow('RECOVERY_SETTINGS_MISMATCH');
  });
  it('broadcasts a newly published next schedule to already connected clients', async () => {
    const r = await registry(); await r.publish(input('a'));
    const messages: TournamentServerMessage[] = [], client = { send: (m: TournamentServerMessage) => messages.push(m) };
    await r.handle(client, { playerId: 'human', name: '사람', platform: 'web' }, { type: 'TOURNAMENT_STATUS', protocolVersion: 2, tournamentId: 'a' });
    await r.publish(input('b', 80000));
    expect(messages.at(-1)).toMatchObject({ type: 'TOURNAMENT_SNAPSHOT', snapshot: { nextTournament: { id: 'b' } } });
  });
  it('updates an idle client that subscribed before any schedule existed', async () => {
    const r = await registry();
    const messages: TournamentServerMessage[] = [], client = { send: (m: TournamentServerMessage) => messages.push(m) };
    await r.handle(client, { playerId: 'idle', name: 'Idle', platform: 'web' }, { type: 'TOURNAMENT_STATUS', protocolVersion: 2 });
    expect(messages.at(-1)).toMatchObject({ type: 'TOURNAMENT_SNAPSHOT', snapshot: { phase: 'disabled' } });
    await r.publish(input('first'));
    expect(messages.at(-1)).toMatchObject({ type: 'TOURNAMENT_SNAPSHOT', snapshot: { config: { id: 'first' }, phase: 'recruiting' } });
  });
  it('preserves legacy v1 human/bot records without reinterpreting them as new Elo games', async () => {
    const legacy = { matchId: 'legacy', blackId: 'p1', whiteId: 'bot', blackKind: 'human', whiteKind: 'bot', blackName: '사람', whiteName: '봇', status: 'completed', winner: 'BLACK', startedAt: new Date().toISOString() };
    const file = join(dir, 'legacy.json');
    await writeFile(file, JSON.stringify({ version: 1, tournamentId: 'cup', settings: { startingScore: 1000 }, entrants: { p1: { points: 999 } }, matches: { legacy } }));
    const r = await registry({ MONGJIN_TOURNAMENT_ID: 'cup', MONGJIN_TOURNAMENT_STARTS_AT: String(Date.now() + 60000), MONGJIN_TOURNAMENT_ENDS_AT: String(Date.now() + 120000), MONGJIN_TOURNAMENT_DATA_FILE: file });
    expect(r.publicStatus().entrantCount).toBe(0); expect(await r.completedRecords()).toEqual([]);
    const reopened = new FileTournamentStore('cup', file); expect((await reopened.load()).matches).toEqual([legacy]); await reopened.close();
  });
  it('retains a schedule after failed activation and retries without changing its ID', async () => {
    const r = await registry();
    await writeFile(join(dir, 'tournaments'), 'blocking file');
    const a = input(); await expect(r.publish(a)).rejects.toThrow();
    expect(await community.store.get('schedules', a.id)).toMatchObject({ id: a.id });
    await rm(join(dir, 'tournaments'));
    expect((await r.publish(a)).config?.id).toBe(a.id);
  });
});
