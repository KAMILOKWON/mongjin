import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommunityService } from './community';
import { createCommunityHandler } from './communityHttp';
import { FileCommunityStore } from './communityStore';

const ADMIN = 'a'.repeat(32);
const TOKENS: Record<string, string> = { p1: 'tok-1', p2: 'tok-2' };
let dir: string; let store: FileCommunityStore; let svc: CommunityService; let server: Server; let base: string;
let savedAdmin: string | undefined;

beforeEach(async () => {
  savedAdmin = process.env.MONGJIN_ADMIN_TOKEN; process.env.MONGJIN_ADMIN_TOKEN = ADMIN;
  dir = await mkdtemp(join(tmpdir(), 'mongjin-community-http-'));
  store = new FileCommunityStore(join(dir, 'c.json'));
  svc = new CommunityService(store);
  const handler = createCommunityHandler(svc, (id, token) => TOKENS[id] === token);
  server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await store.close(); await rm(dir, { recursive: true, force: true });
  if (savedAdmin === undefined) delete process.env.MONGJIN_ADMIN_TOKEN; else process.env.MONGJIN_ADMIN_TOKEN = savedAdmin;
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, any> };
};
const as = (id: string, extra: Record<string, unknown> = {}) => ({ playerId: id, token: TOKENS[id], ...extra });
const admin = { Authorization: `Bearer ${ADMIN}` };

describe('community HTTP', () => {
  it('does not handle unrelated paths', async () => {
    expect((await fetch(base + '/other', { method: 'POST' })).status).toBe(404);
  });

  it('accepts POST only', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(base + '/inbox', { method });
      expect(res.status).toBe(405);
    }
  });

  it('rejects malformed, non-object and array JSON with 400', async () => {
    for (const body of ['{oops', 'null', '[]', '"x"', '']) {
      const r = await post('/inbox', body);
      expect(r.status, body).toBe(400);
      expect(r.json.error).toBe('INVALID_REQUEST');
    }
  });

  it('rejects oversize bodies with 413', async () => {
    const r = await post('/inbox', { ...as('p1'), pad: 'x'.repeat(70_000) }).catch((e) => e);
    if (r instanceof Error) expect(r.message).toMatch(/fetch failed/); // server may reset an oversized upload
    else expect(r.status).toBe(413);
  });

  it('requires valid credentials for every player endpoint', async () => {
    const paths = ['/inbox', '/inbox/read', '/achievements', '/notifications/preferences', '/notifications/device', '/tournament/practice-record'];
    for (const path of paths) {
      expect((await post(path, { playerId: 'p1', token: 'wrong' })).status, path).toBe(401);
      expect((await post(path, { playerId: 'p1' })).status, path).toBe(401);
      expect((await post(path, { playerId: 5, token: 'tok-1' })).status, path).toBe(401);
      expect((await post(path, { playerId: 'ghost', token: 'tok-1' })).status, path).toBe(401);
    }
    expect((await post('/inbox', { playerId: 'p2', token: 'tok-1' })).status).toBe(401);
  });

  it('admin notice creation requires the admin bearer token', async () => {
    const notice = { title: 't', body: 'b' };
    expect((await post('/admin/notices', notice)).status).toBe(401);
    expect((await post('/admin/notices', notice, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post('/admin/notices', notice, { Authorization: `Bearer ${ADMIN}x` })).status).toBe(401);
    expect((await post('/admin/notices', as('p1', notice))).status).toBe(401);
    expect((await post('/admin/notices', { title: '', body: 'b' }, admin)).status).toBe(400);
    const ok = await post('/admin/notices', notice, admin);
    expect(ok.status).toBe(200); expect(typeof ok.json.id).toBe('string');
  });

  it('admin endpoint is closed when the configured secret is missing or too short', async () => {
    process.env.MONGJIN_ADMIN_TOKEN = 'short';
    expect((await post('/admin/notices', { title: 't', body: 'b' }, { Authorization: 'Bearer short' })).status).toBe(401);
    delete process.env.MONGJIN_ADMIN_TOKEN;
    expect((await post('/admin/notices', { title: 't', body: 'b' }, { Authorization: 'Bearer ' })).status).toBe(401);
  });

  it('isolates private notices between authenticated players and answers unknown or foreign ids identically', async () => {
    await post('/admin/notices', { id: 'secret', title: '개인', body: 'b', playerIds: ['p1'] }, admin);
    await post('/admin/notices', { id: 'open', title: '공지', body: 'b' }, admin);
    expect((await post('/inbox', as('p1'))).json.messages.map((m: any) => m.id).sort()).toEqual(['open', 'secret']);
    expect((await post('/inbox', as('p2'))).json.messages.map((m: any) => m.id)).toEqual(['open']);
    const foreign = await post('/inbox/read', as('p2', { id: 'secret' }));
    const unknown = await post('/inbox/read', as('p2', { id: 'nope' }));
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(unknown);
    expect((await post('/inbox', as('p1'))).json.messages.find((m: any) => m.id === 'secret').readAt).toBeNull();
    expect((await post('/inbox/read', as('p1', { id: 'secret' }))).status).toBe(200);
    expect((await post('/inbox/read', as('p1'))).status).toBe(400);
    expect((await post('/inbox/read', as('p1', { id: 7 }))).status).toBe(400);
  });

  it('preferences and devices validate input and stay per player', async () => {
    expect((await post('/notifications/preferences', as('p1'))).json).toEqual({ tournamentReminders: false });
    expect((await post('/notifications/preferences', as('p1', { tournamentReminders: 'yes' }))).status).toBe(400);
    expect((await post('/notifications/preferences', as('p1', { tournamentReminders: true }))).json).toEqual({ tournamentReminders: true });
    expect((await post('/notifications/preferences', as('p2'))).json).toEqual({ tournamentReminders: false });
    expect((await post('/notifications/device', as('p1'))).status).toBe(400);
    expect((await post('/notifications/device', as('p1', { tokenValue: 'bad' }))).status).toBe(400);
    expect((await post('/notifications/device', as('p1', { tokenValue: 'ExponentPushToken[abc]', enabled: 'no' }))).status).toBe(400);
    expect((await post('/notifications/device', as('p1', { tokenValue: 'ExponentPushToken[abc]' }))).json).toEqual({ registered: true });
  });

  it('achievements are returned only for the authenticated player', async () => {
    await svc.consumeEvent({ id: 'c', tournamentId: 'cup', title: 'T', kind: 'champion', occurredAt: Date.now(), playerIds: ['p1'], data: { championTitle: '천하제일' } });
    expect((await post('/achievements', as('p1'))).json.achievements).toHaveLength(1);
    expect((await post('/achievements', as('p2'))).json.achievements).toEqual([]);
  });

  it('practice-record errors do not leak internals and unknown sessions are 400', async () => {
    expect((await post('/tournament/practice-record', as('p1', { practiceId: 'x' }))).status).toBe(400);
    const r = await post('/tournament/practice-record', as('p1', { practiceId: 'ghost', moves: [], reason: 'interrupted' }));
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: 'INVALID_PRACTICE' });
  });
});
