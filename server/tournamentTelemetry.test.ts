import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityService, type CommunityEvent } from './community';
import { FileCommunityStore } from './communityStore';
import { TournamentTelemetry } from './tournamentTelemetry';
import type { RecordedMatchEvent } from './profileRepository';
let community: CommunityService, telemetry: TournamentTelemetry;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T14:59:00Z')); community = new CommunityService(new FileCommunityStore(null)); telemetry = new TournamentTelemetry(community); });
afterEach(async () => { await telemetry.close(); await community.store.close(); vi.useRealTimers(); });
async function event(id: string, kind: string, playerIds: string[], data: Record<string, unknown> = {}, occurredAt = Date.now()) {
  await community.consumeEvent({ id, kind, playerIds, data, occurredAt, tournamentId: 'cup', title: '대회' });
}
describe('authenticated session telemetry', () => {
  it('deduplicates users across sockets, groups continuous sessions across KST midnight and preserves peak', async () => {
    const a = {}, b = {}, c = {};
    telemetry.connect(a, 'private-p1', 'web'); telemetry.connect(b, 'private-p1', 'mobile'); telemetry.connect(c, 'private-p2', 'steam');
    telemetry.connect(a, 'private-p1', 'web'); // Same binding is not a visit.
    vi.setSystemTime(new Date('2026-09-30T15:01:00Z')); telemetry.sample(); telemetry.disconnect(b); telemetry.disconnect(c);
    const stats = await telemetry.stats(14) as any;
    expect(stats.sessions).toBe(3); expect(stats.uniqueActiveUsers).toBe(2); expect(stats.revisitUsers).toBe(2);
    expect(stats.concurrentPeakUsers).toBe(2); expect(stats.concurrentPeakConnections).toBe(3);
    expect(stats.daily).toEqual([{ date: '2026-09-30', uniqueActiveUsers: 2 }, { date: '2026-10-01', uniqueActiveUsers: 2 }]);
    expect(stats.hourly.map((x: any) => x.dateHour)).toEqual(['2026-09-30T23:00', '2026-10-01T00:00']);
    expect(stats.appViews).toBeNull(); expect(JSON.stringify(stats)).not.toContain('private-p');
    expect(stats.normalMatches).toBeNull();
  });
  it('uses last heartbeat after restart rather than pretending stale sessions remain connected', async () => {
    telemetry.connect({}, 'p1', 'web'); await telemetry.stats(14);
    const restarted = new TournamentTelemetry(community);
    vi.setSystemTime(new Date('2026-10-01T16:00:00Z'));
    const stats = await restarted.stats(14) as any;
    expect(stats.daily).toEqual([{ date: '2026-09-30', uniqueActiveUsers: 1 }]); await restarted.close();
  });
  it('retries failed persistence and surfaces missing evidence rather than silently losing it', async () => {
    const commit = vi.spyOn(community.store, 'commit').mockRejectedValue(new Error('private database error'));
    telemetry.connect({}, 'p1', 'web'); await expect(telemetry.stats(14)).rejects.toThrow('TELEMETRY_WRITE_FAILED');
    commit.mockRestore(); telemetry.sample();
    expect((await telemetry.stats(14) as any).uniqueActiveUsers).toBe(1);
  });
  it('reports missing sessions and normal match input explicitly', async () => {
    const stats = await telemetry.stats(28) as any;
    expect(stats).toMatchObject({ sessions: null, uniqueActiveUsers: null, concurrentPeakUsers: null, normalMatches: null, sampleStatus: 'insufficient' });
    await expect(telemetry.stats(7 as 14)).rejects.toThrow('INVALID_DAYS');
  });
  it('does not turn empty heartbeat samples into evidence of user activity', async () => {
    await community.store.commit([{ namespace: 'telemetryConcurrency', key: 'empty', value: { id: 'empty', occurredAt: Date.now(), users: 0, connections: 0 } }]);
    expect(await telemetry.activityWindow(14, [])).toEqual({ days: 14, observedDates: 0, slots: [] });
  });
});
describe('canonical tournament and normal match history', () => {
  it('counts matches once, joins successful waits to started matches and separates abandoned games', async () => {
    await event('found-good', 'match_found', ['p1', 'p2'], { matchId: 'game', waitedMs: { p1: 1000, p2: 3000, injected: 999999 } });
    await event('found-unready', 'match_found', ['p3', 'p4'], { matchId: 'cancelled', waitedMs: { p3: 999999, p4: 999999 } });
    await event('start', 'match_started', ['p1', 'p2'], { matchId: 'game' });
    await event('complete', 'match_complete', ['p1', 'p2'], { matchId: 'game', status: 'completed' });
    await event('abandoned', 'match_complete', ['p3', 'p4'], { matchId: 'other', status: 'abandoned' });
    await event('leave', 'leave', ['p3'], { reason: 'not_ready' });
    const normal: RecordedMatchEvent[] = ['p1', 'p2'].flatMap(playerId => ['started', 'completed'].map(kind => ({ matchId: 'normal-game', roomId: 'room', playerId, opponentKind: 'human' as const, matchKind: 'random' as const, event: kind as 'started' | 'completed', platform: 'web' as const, plyCount: 2, occurredAt: new Date().toISOString() })));
    const stats = await telemetry.stats(14, [...normal, ...normal]) as any;
    expect(stats.tournaments[0]).toMatchObject({ matchCount: 1, completedMatchCount: 1, abandonedMatchCount: 1, matchUsers: 2, queueCancellations: null, successfulWait: { sampleCount: 2, meanMs: 2000, p95Ms: 3000 } });
    expect(stats.normalMatches[0]).toMatchObject({ opponentKind: 'human', matchCount: 1, matchUsers: 2, completedMatchCount: 1 });
  });
  it('does not invent registration ordering when opposite actions share a millisecond', async () => {
    await community.store.commit([{ namespace: 'schedules', key: 'cup', value: { id: 'cup', minimumParticipants: 2, registrationStartsAt: Date.now() - 1000 } }]);
    await event('register', 'register', ['p1']); await event('unregister', 'unregister', ['p1']);
    const stats = await telemetry.stats(14) as any;
    expect(stats.tournaments[0].registrationTimeline).toMatchObject({ sampleStatus: 'ambiguous_order', timeToMinimumMs: null, timeTo50Ms: null, observedCurrentRegistrations: null });
  });
  it('reconstructs registration/unregistration and time to configured minimum and 50 from actual history', async () => {
    const origin = Date.now() - 20 * 86400000;
    await community.store.commit([{ namespace: 'schedules', key: 'cup', value: { id: 'cup', minimumParticipants: 3, registrationStartsAt: origin } }]);
    await event('r1', 'register', ['p1'], {}, origin + 10);
    await event('r2', 'register', ['p2'], {}, origin + 20);
    await event('u1', 'unregister', ['p1'], {}, origin + 30);
    await event('r3', 'register', ['p3'], {}, origin + 40);
    await event('r4', 'register', ['p4'], {}, origin + 50);
    for (let i = 5; i <= 51; i++) await event(`r${i}`, 'register', [`p${i}`], {}, origin + i * 20);
    await event('dup', 'register', ['p51'], {}, origin + 5000);
    const stats = await telemetry.stats(14) as any;
    expect(stats.tournaments[0].registrationTimeline).toMatchObject({ minimumParticipants: 3, halfMinimumParticipants: 2, timeToHalfMinimumMs: 20, timeToMinimumMs: 50, timeTo50Ms: 1020, observedCurrentRegistrations: 50 });
    expect(stats.tournaments[0].serverEvents.register).toBe(0); // Outside reporting window, still needed for lifetime milestone.
    const history = await community.store.list<CommunityEvent>('events'); expect(history).toHaveLength(53);
  });
  it('aggregates observed weekday/hour activity from sessions, normal starts and concurrency', async () => {
    const now = Date.now(), when = now - 2 * 86400000;
    await community.store.commit([
      { namespace: 'telemetrySessions', key: 'one', value: { id: 'one', playerId: 'p1', platform: 'web', connectedAt: when, lastSeenAt: when + 1000, disconnectedAt: when + 1000 } },
      { namespace: 'telemetrySessions', key: 'two', value: { id: 'two', playerId: 'p1', platform: 'mobile', connectedAt: when, lastSeenAt: when + 1000, disconnectedAt: when + 1000 } },
      { namespace: 'telemetryConcurrency', key: 'sample', value: { id: 'sample', occurredAt: when, users: 1, connections: 2 } },
    ]);
    const match: RecordedMatchEvent = { matchId: 'm1', roomId: 'r', playerId: 'p1', matchKind: 'random', opponentKind: 'human', event: 'started', platform: 'web', plyCount: 0, occurredAt: new Date(when).toISOString() };
    const window = await telemetry.activityWindow(14, [match, match]);
    expect(window.slots).toContainEqual(expect.objectContaining({ activeUsers: 1, playingUsers: 1, gamesStarted: 1, peakConcurrentUsers: 1 }));
    expect(window.observedDates).toBe(1);
  });
  it('reports ten registrations as half of a twenty-person minimum while preserving literal fifty metrics', async () => {
    const origin = Date.now() - 10000;
    await community.store.commit([{ namespace: 'schedules', key: 'cup', value: { id: 'cup', minimumParticipants: 20, registrationStartsAt: origin } }]);
    for (let i = 1; i <= 10; i++) await event(`half-${i}`, 'register', [`p${i}`], {}, origin + i * 100);
    const timeline = (await telemetry.stats(14) as any).tournaments[0].registrationTimeline;
    expect(timeline).toMatchObject({ halfMinimumParticipants: 10, timeToHalfMinimumMs: 1000, timeToMinimumMs: null, timeTo50Ms: null });
  });
});
describe('bounded self-reported client metrics', () => {
  it('persists dedup/rate limit across instances and rejects changed event IDs and invalid payloads', async () => {
    const first = { eventId: 'e1', tournamentId: 'cup', kind: 'view' };
    expect(await telemetry.recordClientEvent('p1', first)).toEqual({ saved: true, duplicate: false });
    const restarted = new TournamentTelemetry(community);
    expect(await restarted.recordClientEvent('p1', first)).toEqual({ saved: true, duplicate: true });
    await expect(restarted.recordClientEvent('p1', { ...first, kind: 'invite' })).rejects.toThrow('EVENT_ID_CONFLICT');
    for (let i = 2; i <= 30; i++) await restarted.recordClientEvent('p1', { ...first, eventId: `e${i}` });
    await expect(restarted.recordClientEvent('p1', { ...first, eventId: 'e31' })).rejects.toThrow('RATE_LIMITED');
    expect(await restarted.recordClientEvent('p1', first)).toMatchObject({ duplicate: true });
    await expect(restarted.recordClientEvent('p2', { ...first, metadata: { token: 'secret' } })).rejects.toThrow('INVALID_REQUEST');
    vi.setSystemTime(Date.now() + 60001); expect(await restarted.recordClientEvent('p1', { ...first, eventId: 'e31' })).toMatchObject({ saved: true });
    await restarted.close();
  });
});
