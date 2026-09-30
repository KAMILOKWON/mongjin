import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityService } from './community';
import { FileCommunityStore } from './communityStore';
import type { RecordedMatchEvent } from './profileRepository';
import { TournamentRegistry } from './tournamentRegistry';
import { TournamentTelemetry } from './tournamentTelemetry';
import { TournamentScheduler } from './tournamentScheduler';

let dir: string, community: CommunityService, registry: TournamentRegistry, telemetry: TournamentTelemetry, scheduler: TournamentScheduler;
const normal: RecordedMatchEvent[] = [];
const makeScheduler = async () => { const value = new TournamentScheduler(community, registry, telemetry, async () => normal); await value.initialize(); return value; };
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')); normal.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'mongjin-scheduler-'));
  community = new CommunityService(new FileCommunityStore(join(dir, 'community.json')));
  registry = new TournamentRegistry(community, join(dir, 'tournaments'), () => false, { DATABASE_URL: '' }); await registry.initialize();
  telemetry = new TournamentTelemetry(community); scheduler = await makeScheduler();
});
afterEach(async () => {
  await scheduler.close(); await registry.shutdown(); await telemetry.close(); await community.store.close();
  await rm(dir, { recursive: true, force: true }); vi.useRealTimers();
});
async function addActivity() {
  const changes = [];
  for (let offset = 1; offset <= 14; offset++) {
    const at = Math.floor(Date.now() / 86400000) * 86400000 - offset * 86400000 + 14 * 3600000; // 23:00 KST
    const id = `player-${offset}`;
    changes.push({ namespace: 'telemetrySessions', key: `s-${offset}`, value: { id: `s-${offset}`, playerId: id, platform: 'web', connectedAt: at, lastSeenAt: at + 1000, disconnectedAt: at + 1000 } });
    changes.push({ namespace: 'telemetryConcurrency', key: `c-${offset}`, value: { id: `c-${offset}`, occurredAt: at, users: 2, connections: 2 } });
    normal.push({ matchId: `m-${offset}`, roomId: `r-${offset}`, playerId: id, matchKind: 'random', opponentKind: 'human', event: 'started', platform: 'web', plyCount: 0, occurredAt: new Date(at).toISOString() });
  }
  await community.store.commit(changes);
}
describe('persisted automatic tournament scheduler', () => {
  it('starts disabled, previews a single Saturday 21–22 KST bootstrap and rejects invalid policy', async () => {
    expect(scheduler.status().state).toBe('disabled');
    expect(await scheduler.tick()).toMatchObject({ reason: 'disabled', published: false });
    const preview = await scheduler.dryRun() as any;
    expect(preview).toMatchObject({ reason: 'bootstrap', published: false, planned: { settings: { minimumParticipants: 20 } } });
    expect(new Date(preview.planned.settings.startsAt).toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(preview.planned.settings.endsAt - preview.planned.settings.startsAt).toBe(3600000);
    expect(registry.list()).toHaveLength(0);
    await expect(scheduler.configure({ enabled: 'yes' })).rejects.toThrow('INVALID_SCHEDULER_POLICY');
    await expect(scheduler.configure({ allowedHours: [24] })).rejects.toThrow('INVALID_SCHEDULER_POLICY');
  });
  it('waits safely when a long lead leaves no Saturday inside the configured horizon', async () => {
    await scheduler.configure({ enabled: true, minimumLeadMs: 28 * 86400000, horizonDays: 28 });
    expect(await scheduler.dryRun()).toMatchObject({ reason: 'bootstrap_out_of_horizon', planned: null, published: false });
    expect(await scheduler.tick()).toMatchObject({ reason: 'bootstrap_out_of_horizon', published: false });
    expect(scheduler.status()).toMatchObject({ state: 'waiting_for_window', bootstrapUsed: false, pendingId: null });
    expect(await community.store.get('tournamentScheduler', 'state')).toMatchObject({ bootstrapUsed: false, pending: null });
    expect(registry.list()).toHaveLength(0);
  });
  it('does not consume bootstrap or retain a pending choice when reservation persistence fails', async () => {
    await scheduler.configure({ enabled: true });
    const original = community.store.commit.bind(community.store);
    const failed = vi.spyOn(community.store, 'commit').mockImplementation(async changes => {
      if (changes.some(change => change.namespace === 'tournamentScheduler' && change.key === 'state')) throw new Error('state write failed');
      return original(changes);
    });
    await expect(scheduler.tick()).rejects.toThrow('state write failed');
    failed.mockRestore();
    expect(scheduler.status()).toMatchObject({ bootstrapUsed: false, pendingId: null });
    expect(await community.store.get('tournamentScheduler', 'state')).toBeNull();
    expect(registry.list()).toHaveLength(0);
    const published = await scheduler.tick() as any;
    expect(published).toMatchObject({ reason: 'bootstrap', published: true });
    expect(registry.list()).toHaveLength(1);
  });
  it('reloads a durable pending choice when its commit succeeded but acknowledgement failed', async () => {
    await scheduler.configure({ enabled: true });
    const original = community.store.commit.bind(community.store);
    const failed = vi.spyOn(community.store, 'commit').mockImplementationOnce(async changes => {
      await original(changes);
      throw new Error('acknowledgement lost');
    });
    await expect(scheduler.tick()).rejects.toThrow('acknowledgement lost');
    failed.mockRestore();
    expect(scheduler.status()).toMatchObject({ bootstrapUsed: false, pendingId: null });
    const saved = await community.store.get<{ bootstrapUsed: boolean; pending: { settings: { id: string } } }>('tournamentScheduler', 'state');
    expect(saved).toMatchObject({ bootstrapUsed: true, pending: { settings: { id: expect.any(String) } } });
    expect(await scheduler.tick()).toMatchObject({ id: saved!.pending.settings.id, reason: 'bootstrap', published: true });
    expect(registry.list()).toHaveLength(1);
  });
  it('publishes on a timer without any user request and persists one in-app announcement', async () => {
    scheduler.start();
    await scheduler.configure({ enabled: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.close();
    const event = registry.list()[0].settings;
    expect(event.minimumParticipants).toBe(20);
    expect((await community.store.list<{ id: string; tournamentId: string }>('notices'))
      .filter(n => n.tournamentId === event.id)).toHaveLength(1);
    expect(await community.store.list('pushJobs')).toHaveLength(0);
    await scheduler.tick();
    expect((await community.store.list<{ tournamentId: string }>('notices'))
      .filter(n => n.tournamentId === event.id)).toHaveLength(1);
    expect(registry.publicStatus().config?.id).toBe(event.id);
  });
  it('publishes once, recovers without duplicate and never repeats bootstrap after cancellation', async () => {
    await scheduler.configure({ enabled: true });
    const first = await scheduler.tick() as any;
    expect(first).toMatchObject({ reason: 'bootstrap', published: true });
    expect(registry.list()).toHaveLength(1);
    expect(await scheduler.tick()).toMatchObject({ published: false, reason: 'future_event_exists' });
    await scheduler.close(); await registry.shutdown();
    registry = new TournamentRegistry(community, join(dir, 'tournaments'), () => false, { DATABASE_URL: '' }); await registry.initialize();
    scheduler = await makeScheduler();
    expect(scheduler.status()).toMatchObject({ bootstrapUsed: true, state: 'event_available' });
    expect((await community.store.list<{ tournamentId: string }>('notices')).filter(n => n.tournamentId === first.id)).toHaveLength(1);
    vi.setSystemTime(registry.list()[0].settings.registrationEndsAt + 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.publicStatus(first.id).phase).toBe('cancelled');
    expect(await scheduler.tick()).toMatchObject({ reason: 'insufficient_activity', published: false });
    expect(scheduler.status().state).toBe('waiting_for_data');
    expect(registry.list()).toHaveLength(1);
  });
  it('recovers the same persisted selection if announcement storage fails after schedule publication', async () => {
    await scheduler.configure({ enabled: true });
    const failure = vi.spyOn(community, 'publishNotice').mockRejectedValueOnce(new Error('temporary store failure'));
    await expect(scheduler.tick()).rejects.toThrow('temporary store failure');
    failure.mockRestore();
    const id = registry.list()[0].settings.id;
    expect(scheduler.status()).toMatchObject({ pendingId: id, bootstrapUsed: true });
    expect(await community.store.list('notices')).toHaveLength(0);
    await scheduler.close(); scheduler = await makeScheduler();
    expect(await scheduler.tick()).toMatchObject({ id, published: true });
    expect(registry.list()).toHaveLength(1);
    expect((await community.store.list<{ tournamentId: string }>('notices')).filter(n => n.tournamentId === id)).toHaveLength(1);
  });
  it('keeps durable pending recovery if the final state write fails after publication', async () => {
    await scheduler.configure({ enabled: true });
    const original = community.store.commit.bind(community.store);
    let writes = 0;
    const failed = vi.spyOn(community.store, 'commit').mockImplementation(async changes => {
      if (changes.some(change => change.namespace === 'tournamentScheduler' && change.key === 'state') && ++writes === 2) throw new Error('final state write failed');
      return original(changes);
    });
    await expect(scheduler.tick()).rejects.toThrow('final state write failed');
    failed.mockRestore();
    const id = registry.list()[0].settings.id;
    expect(scheduler.status()).toMatchObject({ pendingId: id, bootstrapUsed: true });
    expect(await community.store.get('tournamentScheduler', 'state')).toMatchObject({ pending: { settings: { id } }, bootstrapUsed: true });
    await scheduler.close(); scheduler = await makeScheduler();
    expect(await scheduler.tick()).toMatchObject({ id, published: true });
    expect(registry.list()).toHaveLength(1);
    expect((await community.store.list<{ tournamentId: string }>('notices')).filter(n => n.tournamentId === id)).toHaveLength(1);
  });
  it('retains an expired pending reservation when clearing it fails, then replans the first unpublished event', async () => {
    await scheduler.configure({ enabled: true });
    const failedPublish = vi.spyOn(registry, 'publish').mockRejectedValueOnce(new Error('activation failed'));
    await expect(scheduler.tick()).rejects.toThrow('activation failed');
    failedPublish.mockRestore();
    const pendingId = scheduler.status().pendingId;
    const stored = await community.store.get<{ pending: { settings: { registrationEndsAt: number } } }>('tournamentScheduler', 'state');
    vi.setSystemTime(stored!.pending.settings.registrationEndsAt + 1000);
    const original = community.store.commit.bind(community.store);
    const failedClear = vi.spyOn(community.store, 'commit').mockImplementation(async changes => {
      if (changes.some(change => change.namespace === 'tournamentScheduler' && change.key === 'state')) throw new Error('clear failed');
      return original(changes);
    });
    await expect(scheduler.tick()).rejects.toThrow('clear failed');
    failedClear.mockRestore();
    expect(scheduler.status()).toMatchObject({ pendingId, bootstrapUsed: true });
    expect(await community.store.get('tournamentScheduler', 'state')).toMatchObject({ pending: { settings: { id: pendingId } }, bootstrapUsed: true });
    const retried = await scheduler.tick() as any;
    expect(retried).toMatchObject({ reason: 'bootstrap', published: true });
    expect(retried.id).not.toBe(pendingId);
    expect(registry.list()).toHaveLength(1);
  });
  it('selects a deterministic evidenced slot after bootstrap cancellation and lets manual future events win', async () => {
    await scheduler.configure({ enabled: true, allowedHours: [23], minimumLeadMs: 24 * 3600000 });
    const first = await scheduler.tick() as any;
    vi.setSystemTime(registry.list()[0].settings.registrationEndsAt + 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.publicStatus(first.id).phase).toBe('cancelled');
    await addActivity();
    const preview = await scheduler.dryRun() as any;
    expect(preview).toMatchObject({ reason: 'activity', planned: { basis: { kind: 'activity', sampleDates: 2 } } });
    const published = await scheduler.tick() as any;
    expect(published.id).toBe(preview.planned.settings.id);
    expect(registry.publicStatus(published.id).config?.startsAt).toBe(preview.planned.settings.startsAt);
    expect(await scheduler.tick()).toMatchObject({ reason: 'future_event_exists' });
    expect(registry.list()).toHaveLength(2);
  });
  it('preserves a manually published future event and does not bootstrap after any prior event', async () => {
    const startsAt = Date.now() + 3 * 86400000;
    await registry.publish({ id: 'manual', title: '운영자 대회', registrationStartsAt: Date.now(),
      registrationEndsAt: startsAt - 3600000, startsAt, endsAt: startsAt + 3600000, minimumParticipants: 20 });
    await scheduler.configure({ enabled: true });
    expect(await scheduler.tick()).toMatchObject({ reason: 'future_event_exists', published: false });
    expect(registry.list()).toHaveLength(1);
    vi.setSystemTime(startsAt - 3599000); await vi.advanceTimersByTimeAsync(2000);
    expect(registry.publicStatus('manual').phase).toBe('cancelled');
    expect(await scheduler.tick()).toMatchObject({ reason: 'insufficient_activity', published: false });
    expect(scheduler.status().bootstrapUsed).toBe(false);
  });
  it('runs registration, confirmation, reminder, start, finish and then creates the next evidenced event', async () => {
    await addActivity();
    await scheduler.configure({ enabled: true, allowedHours: [23], registrationClosesBeforeStartMs: 3 * 3600000 });
    const first = await scheduler.tick() as any;
    expect(first.reason).toBe('activity');
    const event = registry.list()[0].settings;
    for (let i = 0; i < 20; i++) {
      await registry.handle({ send: () => undefined }, { playerId: `human${i}`, name: `Human ${i}`, platform: i % 2 ? 'mobile' : 'toss' },
        { type: 'TOURNAMENT_REGISTER', protocolVersion: 2, tournamentId: first.id });
    }
    expect(registry.publicStatus(first.id).registrationCount).toBe(20);
    vi.setSystemTime(event.registrationEndsAt + 1000); await vi.advanceTimersByTimeAsync(1000);
    await (registry as any).services.get(first.id).settle();
    expect(registry.publicStatus(first.id).phase).toBe('confirmed');
    vi.setSystemTime(event.startsAt - 3600000 + 1000); await vi.advanceTimersByTimeAsync(1000);
    await (registry as any).services.get(first.id).settle();
    vi.setSystemTime(event.startsAt + 1000); await vi.advanceTimersByTimeAsync(1000);
    await (registry as any).services.get(first.id).settle();
    expect(registry.publicStatus(first.id).phase).toBe('active');
    vi.setSystemTime(event.endsAt + 1000);
    await vi.advanceTimersByTimeAsync(2000);
    await (registry as any).services.get(first.id).settle();
    expect(registry.publicStatus(first.id).phase).toBe('finished');
    const lifecycle = (await community.store.list<{ tournamentId: string; kind: string }>('events'))
      .filter(e => e.tournamentId === first.id).map(e => e.kind);
    expect(lifecycle).toEqual(expect.arrayContaining(['confirmed', 'reminder', 'started', 'finished']));
    const notices = await community.store.list<{ tournamentId: string }>('notices');
    expect(notices.filter(n => n.tournamentId === first.id).length).toBeGreaterThanOrEqual(5);
    const second = await scheduler.tick() as any;
    expect(second).toMatchObject({ reason: 'activity', published: true });
    expect(second.id).not.toBe(first.id);
    expect(registry.list()).toHaveLength(2);
  });
});
