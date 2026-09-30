import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { Move } from '../src/core/types';
import { CommunityService, type TournamentReward } from './community';
import { FileCommunityStore } from './communityStore';
import { TournamentRegistry } from './tournamentRegistry';
import { TournamentTelemetry } from './tournamentTelemetry';
import { TournamentScheduler } from './tournamentScheduler';
import { createTournamentAdminHandler, trainingExport } from './tournamentAdminHttp';
import { FileTournamentStore, type TournamentMatchRecord } from './tournamentStore';

const ADMIN = 'test-admin-token-'.repeat(3), PLAYER_TOKEN = 'test-player-token';
let dir: string, community: CommunityService, registry: TournamentRegistry, telemetry: TournamentTelemetry, scheduler: TournamentScheduler, server: Server, base: string;
let previous: string | undefined;
const normalEvents = vi.fn(async () => []);
const settings = (id = 'cup') => ({ id, title: '대회', startsAt: Date.now() + 60000, endsAt: Date.now() + 120000 });
const request = async (path: string, method = 'GET', body?: unknown, admin = true) => {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${ADMIN}` } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
beforeEach(async () => {
  previous = process.env.MONGJIN_ADMIN_TOKEN; process.env.MONGJIN_ADMIN_TOKEN = ADMIN; normalEvents.mockClear();
  dir = await mkdtemp(join(tmpdir(), 'mongjin-admin-'));
  community = new CommunityService(new FileCommunityStore(null));
  registry = new TournamentRegistry(community, dir, () => false, { DATABASE_URL: '' }); await registry.initialize();
  telemetry = new TournamentTelemetry(community);
  scheduler = new TournamentScheduler(community, registry, telemetry, normalEvents); await scheduler.initialize();
  const handler = createTournamentAdminHandler(registry, community, telemetry, (id, token) => id === 'p1' && token === PLAYER_TOKEN, normalEvents, scheduler);
  server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); await scheduler.close(); await telemetry.close(); await registry.shutdown(); await community.store.close();
  await rm(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.MONGJIN_ADMIN_TOKEN; else process.env.MONGJIN_ADMIN_TOKEN = previous;
});
describe('admin routes over local HTTP', () => {
  it('requires admin auth on every admin route and does not capture unrelated routes', async () => {
    for (const path of ['/admin/tournaments', '/admin/analytics', '/admin/notifications', '/admin/rewards', '/admin/training-export', '/admin/tournament-scheduler', '/admin/tournament-scheduler/dry-run']) expect((await request(path, 'GET', undefined, false)).status).toBe(401);
    expect((await request('/other')).status).toBe(404);
    process.env.MONGJIN_ADMIN_TOKEN = 'short'; expect((await request('/admin/tournaments')).status).toBe(401);
    delete process.env.MONGJIN_ADMIN_TOKEN; expect((await request('/admin/tournaments')).status).toBe(401);
  });
  it('exposes persisted scheduler policy and a read-only dry-run behind admin auth', async () => {
    expect((await request('/admin/tournament-scheduler')).body.policy.enabled).toBe(false);
    const preview = await request('/admin/tournament-scheduler/dry-run');
    expect(preview.body).toMatchObject({ reason: 'bootstrap', published: false });
    expect(registry.list()).toHaveLength(0);
    expect((await request('/admin/tournament-scheduler', 'POST', { enabled: '1' })).status).toBe(400);
    expect((await request('/admin/tournament-scheduler', 'POST', { enabled: true, minimumParticipants: 30 })).body.policy).toMatchObject({ enabled: true, minimumParticipants: 30 });
    expect(registry.list()).toHaveLength(0);
    const reloaded = new TournamentScheduler(community, registry, telemetry, normalEvents); await reloaded.initialize();
    expect(reloaded.status().policy.minimumParticipants).toBe(30);
  });
  it('creates only validated future events, lists them, rejects overlap and prohibits mutable schedules', async () => {
    expect((await request('/admin/tournaments', 'POST', '{bad')).status).toBe(400);
    expect((await request('/admin/tournaments', 'POST', { ...settings(), title: 'x'.repeat(70000) })).status).toBe(413);
    expect((await request('/admin/tournaments', 'POST', settings())).status).toBe(201);
    expect((await request('/admin/tournaments')).body.tournaments[0].settings.id).toBe('cup');
    expect((await request('/admin/tournaments', 'POST', { ...registry.list()[0].settings, eloK: 99 })).status).toBe(409);
    expect((await request('/admin/tournaments', 'POST', settings('other'))).status).toBe(409);
    expect((await request('/admin/tournaments', 'PUT', settings())).status).toBe(405);
    expect((await request('/admin/tournaments', 'POST', { ...settings(), id: 'old', startsAt: Date.now() - 1000 })).status).toBe(400);
  });
  it('uses fifth callback for actual normal history and validates reporting window', async () => {
    expect((await request('/admin/analytics?days=28')).body.normalMatches).toHaveLength(2); expect(normalEvents).toHaveBeenCalledTimes(1);
    for (const days of ['7', '14.0', '14&days=28']) expect((await request(`/admin/analytics?days=${days}`)).status).toBe(400);
  });
  it('returns only notification counts and labels provider acceptance separately from delivery', async () => {
    await community.store.commit([
      { namespace: 'devices', key: 'push-secret', value: { token: 'push-secret', playerId: 'private-player' } },
      { namespace: 'pushJobs', key: 'j', value: { state: 'accepted', error: 'credentials-error', playerId: 'private-player' } },
      { namespace: 'pushReceipts', key: 'r', value: { status: 'accepted', ticketId: 'private-ticket', token: 'push-secret' } },
      { namespace: 'unrelated-private', key: 'x', value: { token: 'private-token' } },
    ]);
    const reply = await request('/admin/notifications');
    expect(reply.body).toMatchObject({ deviceCount: 1, jobs: { accepted: 1 }, receipts: { accepted: 1, delivered: 0 } });
    expect(JSON.stringify(reply.body)).not.toMatch(/push-secret|private-player|credentials-error|private-ticket|private-token/);
  });
  it('updates the existing reward atomically, preserves fields, deduplicates status retries and sends nothing', async () => {
    const reward: TournamentReward = { id: JSON.stringify(['cup', 'p1', 'champion']), playerId: 'p1', tournamentId: 'cup', description: '운영자 확인', status: 'pending', updatedAt: new Date(0).toISOString() };
    await community.store.commit([{ namespace: 'rewards', key: reward.id, value: reward }]);
    expect((await request('/admin/rewards')).body.rewards[0].id).toBe(reward.id);
    expect((await request('/admin/rewards', 'POST', { id: reward.id, status: 'fulfilled' })).status).toBe(200);
    expect(await community.store.get('rewards', reward.id)).toMatchObject({ ...reward, status: 'fulfilled', updatedAt: expect.any(String) });
    expect((await request('/admin/rewards', 'POST', { id: reward.id, status: 'fulfilled' })).status).toBe(200);
    expect(await community.store.list('rewardAudit')).toHaveLength(1);
    expect(await community.store.list('pushJobs')).toHaveLength(0);
    expect((await request('/admin/rewards', 'POST', { id: 'unknown', status: 'fulfilled' })).status).toBe(404);
    expect((await request('/admin/rewards', 'POST', { id: reward.id, status: 'sent' })).status).toBe(400);
    expect((await request('/admin/rewards', 'POST', { id: reward.id, status: 'pending', description: 'rewritten' })).status).toBe(400);
  });
  it('authenticates bounded client events, rejects invalid tournament IDs and deduplicates retries before rate limiting', async () => {
    await registry.publish(settings());
    const body = { playerId: 'p1', token: PLAYER_TOKEN, tournamentId: 'cup', eventId: 'view1', kind: 'view' };
    expect((await request('/tournament/analytics', 'POST', { ...body, token: 'bad' }, false)).status).toBe(401);
    expect((await request('/tournament/analytics', 'POST', { ...body, tournamentId: '../cup' }, false)).status).toBe(400);
    expect((await request('/tournament/analytics', 'POST', { ...body, tournamentId: 'unknown' }, false)).status).toBe(404);
    expect((await request('/tournament/analytics', 'POST', body, false)).body).toEqual({ saved: true, duplicate: false });
    expect((await request('/tournament/analytics', 'POST', body, false)).body.duplicate).toBe(true);
    expect((await request('/tournament/analytics', 'POST', { ...body, kind: 'started' }, false)).status).toBe(400);
    for (let i = 2; i <= 30; i++) expect((await request('/tournament/analytics', 'POST', { ...body, eventId: `view${i}` }, false)).status).toBe(200);
    expect((await request('/tournament/analytics', 'POST', { ...body, eventId: 'view31' }, false)).status).toBe(429);
    expect(JSON.stringify(await community.store.list('tournamentClientEvents'))).not.toContain(PLAYER_TOKEN);
  });
  it('exports canonical completed human tournament records while omitting all identifiers and arbitrary fields', async () => {
    await registry.publish(settings());
    const store = new FileTournamentStore('cup', join(dir, 'cup.json'));
    const record: TournamentMatchRecord = { matchId: 'private-match', blackId: 'private-black', whiteId: 'private-white', blackName: 'private-name', whiteName: 'private-name', blackKind: 'human', whiteKind: 'human', scoring: 'elo-v1', status: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), winner: 'WHITE', reason: 'resign', moves: [legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]] };
    await store.finishMatch(record, []);
    await store.finishMatch({ ...record, matchId: 'bot-game', whiteKind: 'bot' }, []);
    await store.finishMatch({ ...record, matchId: 'legacy-game', scoring: undefined }, []); await store.close();
    const reply = await request('/admin/training-export');
    expect(reply.status).toBe(200); expect(reply.body.tournamentCount).toBe(1);
    expect(reply.body.records[0]).toMatchObject({ source: 'human_tournament', winner: 'WHITE', reason: 'resign' });
    expect(JSON.stringify(reply.body)).not.toMatch(/private-|matchId|playerId|Name|startedAt|endedAt|token/);
  });
});
describe('training allowlist and terminal practice history', () => {
  it('includes AI-terminal interrupted practice, excludes incomplete sessions, and rejects malformed moves', async () => {
    const moves: Move[] = [];
    for (let row = 7; row >= 0; row--) {
      moves.push({ kind: 'MOVE', from: { r: row + 1, c: 4 }, to: { r: row, c: 4 } });
      if (row > 0) moves.push({ kind: 'MOVE', from: { r: 0, c: row % 2 ? 4 : 5 }, to: { r: 0, c: row % 2 ? 5 : 4 } });
    }
    const baseRecord = { completed: true, rulesVersion: 'mongjin-core-1', modelVersion: 'mandako-1', reason: 'interrupted', moves, playerId: 'private-player', token: 'private-token' };
    await community.store.commit([
      { namespace: 'practiceRecords', key: 'good', value: baseRecord },
      { namespace: 'practiceRecords', key: 'incomplete', value: { ...baseRecord, completed: false, moves: [] } },
      { namespace: 'practiceRecords', key: 'bad', value: { ...baseRecord, moves: [{ kind: 'PLACE', to: { r: 99, c: 99 } }] } },
    ]);
    const exported = await trainingExport(community);
    expect(exported).toMatchObject({ exportedCount: 1, rejectedCount: 1, skippedCount: 1, tournamentCount: null });
    expect(exported.records[0]).toMatchObject({ reason: 'interrupted', winner: 'BLACK' });
    expect(JSON.stringify(exported)).not.toMatch(/private-|playerId|token|practiceId/);
  });
});
