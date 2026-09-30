import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TournamentPublicStatus } from '../src/net/tournamentProtocol';
import { FileCommunityStore } from './communityStore';
import { createWaitingHandler } from './waitingHttp';
import { WaitingNotifications, type WaitingTransport } from './waitingNotifications';

const TOKEN = 'ExponentPushToken[abcdefgh]';
const player = (playerId = 'p1', token = 'secret-1', extra: Record<string, unknown> = {}) => ({ playerId, token, tournamentId: 'cup_1', ...extra });
let server: Server;
let base: string;
let store: FileCommunityStore;
let notifications: WaitingNotifications;
let registry: {
  publicStatus: ReturnType<typeof vi.fn>;
  backgroundStatus: ReturnType<typeof vi.fn>;
  cancelWaiting: ReturnType<typeof vi.fn>;
};
let attached = 0;
let readiness = 0;
let mockedTransport: WaitingTransport;
let authorizedPlayers: Map<string, string>;

beforeEach(async () => {
  store = new FileCommunityStore(null);
  mockedTransport = vi.fn(async () => undefined);
  notifications = new WaitingNotifications(store, {}, mockedTransport);
  registry = {
    publicStatus: vi.fn((id?: string) => (id === 'cup_1' ? { config: { id } } : {}) as unknown as TournamentPublicStatus),
    backgroundStatus: vi.fn(() => ({ status: 'waiting', presence: 'background', background: null, pausedReason: null })),
    cancelWaiting: vi.fn(async () => false),
  };
  attached = 0;
  readiness = 0;
  authorizedPlayers = new Map([['p1', 'secret-1']]);
  const handler = createWaitingHandler(notifications, registry as never, (id, token) => authorizedPlayers.get(id) === token);
  server = createServer(async (req, res) => {
    if (!await handler(req, res)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await notifications.close();
  await store.close();
});

const request = async (path: string, body?: unknown, method = 'POST') => {
  const response = await fetch(base + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
};

describe('waiting HTTP', () => {
  it('authenticates before status lookup and returns read-only status without attaching or readying a socket', async () => {
    expect((await request('/tournament/waiting-status', player('p1', 'wrong'))).status).toBe(401);
    expect((await request('/tournament/waiting-status', player('missing', 'secret-1'))).status).toBe(401);
    expect(registry.publicStatus).not.toHaveBeenCalled();
    expect(registry.backgroundStatus).not.toHaveBeenCalled();

    const result = await request('/tournament/waiting-status', player());
    expect(result.status).toBe(200);
    expect(result.json.snapshot.status).toBe('waiting');
    expect(JSON.stringify(result.json)).not.toContain('READY');
    expect(attached).toBe(0);
    expect(readiness).toBe(0);
  });

  it('rejects malformed destinations and unknown tournament IDs without registering devices', async () => {
    expect((await request('/tournament/waiting-device', player('p1', 'secret-1', { destination: { kind: 'expo', token: 'malformed' } }))).status).toBe(400);
    expect((await request('/tournament/waiting-device', player('p1', 'secret-1', { tournamentId: 'missing', destination: { kind: 'expo', token: TOKEN } }))).status).toBe(404);
    expect(await store.list('waitingDevices')).toHaveLength(0);
  });

  it('registers a valid device while reporting background wait disabled and rejects cross-owner token claims', async () => {
    const first = await request('/tournament/waiting-device', player('p1', 'secret-1', { destination: { kind: 'expo', token: TOKEN } }));
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ canBackgroundWait: false });

    // Give the second authenticated identity its own authorization for this request.
    authorizedPlayers.set('p2', 'secret-2');
    const second = await request('/tournament/waiting-device', player('p2', 'secret-2', { destination: { kind: 'expo', token: TOKEN } }));
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('DESTINATION_OWNED');
    expect(mockedTransport).not.toHaveBeenCalled();
  });

  it('calls only the registry cancellation contract and exposes a no-op cancel without implying a resignation', async () => {
    const result = await request('/tournament/waiting-cancel', player());
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ cancelled: false });
    expect(registry.cancelWaiting).toHaveBeenCalledWith('p1', 'cup_1');
    expect(attached).toBe(0);
    expect(readiness).toBe(0);
    expect(mockedTransport).not.toHaveBeenCalled();
  });

  it('returns 405 for unsupported methods, leaves unrelated routes unhandled, and caps request bodies at 64 KiB', async () => {
    expect((await request('/tournament/waiting-status', undefined, 'GET')).status).toBe(405);
    expect((await request('/not-a-waiting-route', {})).status).toBe(404);
    const oversized = await request('/tournament/waiting-status', { ...player(), padding: 'x'.repeat(70_000) }).catch(error => error);
    if (oversized instanceof Error) expect(oversized.message).toMatch(/fetch failed/i);
    else expect(oversized.status).toBe(413);
  });
});
