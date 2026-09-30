import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityService, type PushJob } from './community';
import { FileCommunityStore } from './communityStore';
import { NotificationDelivery } from './notificationDelivery';

const tossRequestMock = vi.fn();

const T1 = 'ExponentPushToken[one]';
const T2 = 'ExponentPushToken[two]';
let dir: string; let store: FileCommunityStore; let svc: CommunityService;

beforeEach(async () => {
  tossRequestMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-10-01T00:00:00Z'));
  dir = await mkdtemp(join(tmpdir(), 'mongjin-delivery-'));
  store = new FileCommunityStore(join(dir, 'c.json'));
  svc = new CommunityService(store, () => Date.now());
});
afterEach(async () => { vi.useRealTimers(); await store.close(); await rm(dir, { recursive: true, force: true }); });

const ok = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
const ticket = (id: string) => ok({ data: { status: 'ok', id } });
const enabled = { MONGJIN_PUSH_ENABLED: '1' };
const delivery = (fetcher: unknown, env: Record<string, string | undefined> = enabled) =>
  new NotificationDelivery(svc, () => undefined, env, fetcher as typeof fetch);
type TossOutcome =
  | { kind: 'reply'; statusCode: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'socket-error'; message: string };
function mockTossRequest(outcome: TossOutcome) {
  tossRequestMock.mockImplementation((...args: unknown[]) => {
    const onResponse = args[1] as (response: EventEmitter & { statusCode: number }) => void;
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: (milliseconds: number, callback: () => void) => EventEmitter;
      destroy: (error?: Error) => void;
      end: (body?: string) => void;
    };
    request.setTimeout = (_milliseconds, callback) => {
      if (outcome.kind === 'timeout') queueMicrotask(callback);
      return request;
    };
    request.destroy = error => {
      if (error) request.emit('error', error);
    };
    request.end = () => {
      if (outcome.kind === 'timeout') return;
      if (outcome.kind === 'socket-error') {
        queueMicrotask(() => request.emit('error', new Error(outcome.message)));
        return;
      }
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = outcome.statusCode;
        onResponse(response);
        response.emit('data', Buffer.from(outcome.body));
        response.emit('end');
      });
    };
    return request as never;
  });
}
const tossEnvironment = () => ({
  ...enabled,
  TOSS_MTLS_CERT_PATH: join(dir, 'fixture-cert.pem'),
  TOSS_MTLS_KEY_PATH: join(dir, 'fixture-key.pem'),
  MONGJIN_TOSS_TEMPLATE_REMINDER: 'fixture-reminder-template',
});
const tossDelivery = (env: Record<string, string | undefined> = tossEnvironment()) =>
  new NotificationDelivery(svc, () => 'fixture-toss-user-key', env, vi.fn() as typeof fetch, tossRequestMock as never);
async function queue(player = 'p1', kind = 'reminder') {
  await svc.consumeEvent({ id: 'e-' + kind, tournamentId: 'cup', title: '대회', kind, occurredAt: Date.now(), playerIds: [player], data: {} });
  return (await store.list<PushJob>('pushJobs'))[0]!;
}
const job = async () => (await store.list<PushJob>('pushJobs'))[0]!;

describe('NotificationDelivery', () => {
  it('sends nothing unless explicitly enabled (default off)', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    const fetcher = vi.fn();
    await delivery(fetcher, {}).flush();
    await delivery(fetcher, { MONGJIN_PUSH_ENABLED: '0' }).flush();
    await tossDelivery({ ...tossEnvironment(), MONGJIN_PUSH_ENABLED: '0' }).flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(tossRequestMock).not.toHaveBeenCalled();
    expect((await job()).state).toBe('pending');
  });

  it('skips a job whose player opted out after it was queued, without sending', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    await svc.preferences('p1', false);
    const fetcher = vi.fn();
    await delivery(fetcher).flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ state: 'skipped', error: 'OPTED_OUT' });
  });

  it('skips when the player has no device', async () => {
    await svc.preferences('p1', true); await queue();
    const fetcher = vi.fn();
    await delivery(fetcher).flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ state: 'skipped', error: 'NO_DEVICE' });
  });

  it('skips reminders for a tournament that was cancelled', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    await svc.consumeEvent({ id: 'x', tournamentId: 'cup', title: '대회', kind: 'cancelled', occurredAt: Date.now(), playerIds: [], data: {} });
    const fetcher = vi.fn();
    await delivery(fetcher).flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ state: 'skipped', error: 'OBSOLETE' });
  });

  it('does not send a delayed reminder after the real start time', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1);
    await svc.consumeEvent({ id: 'late-reminder', tournamentId: 'cup', title: '대회', kind: 'reminder', occurredAt: Date.now(), playerIds: ['p1'], data: { startsAt: Date.now() + 60_000 } });
    vi.setSystemTime(Date.now() + 60_001);
    const fetcher = vi.fn();
    await delivery(fetcher).flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ state: 'skipped', error: 'OBSOLETE' });
  });

  it('sends once to the mocked Expo endpoint and is accepted; a second flush does not resend', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    const fetcher = vi.fn().mockResolvedValue(ticket('tk1'));
    await delivery(fetcher).flush();
    await delivery(fetcher).flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('exp.host');
    expect(JSON.parse(init.body).to).toBe(T1);
    expect((await job()).state).toBe('accepted');
  });

  it('a provider failure keeps the job pending with backoff, then fails permanently after repeated attempts', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    const fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await delivery(fetcher).flush();
    const first = await job();
    expect(first).toMatchObject({ state: 'pending', attempts: 1 });
    expect(first.nextAttemptAt).toBeGreaterThan(Date.now());
    await delivery(fetcher).flush(); // still backing off
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) { vi.setSystemTime(Date.now() + 3_700_000); await delivery(fetcher).flush(); }
    expect(await job()).toMatchObject({ state: 'failed' });
    const calls = fetcher.mock.calls.length;
    vi.setSystemTime(Date.now() + 3_700_000); await delivery(fetcher).flush();
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it('an error ticket status is treated as a failed attempt', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    await delivery(vi.fn().mockResolvedValue(ok({ data: { status: 'error' } }))).flush();
    expect(await job()).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('multi-device partial failure retries only the device that failed', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await svc.registerDevice('p1', T2); await queue();
    const seen: string[] = [];
    let failSecond = true;
    const fetcher = vi.fn(async (_u: string, init: { body: string }) => {
      const to = JSON.parse(init.body).to as string | undefined;
      if (!to) return ok({ data: {} }); // receipt poll, due after the backoff
      seen.push(to);
      if (to === T2 && failSecond) return { ok: false, json: async () => ({}) } as Response;
      return ticket('tk-' + to);
    });
    await delivery(fetcher).flush();
    expect(await job()).toMatchObject({ state: 'pending', attempts: 1 });
    expect(new Set(seen)).toEqual(new Set([T1, T2]));
    seen.length = 0; failSecond = false;
    vi.setSystemTime(Date.now() + 3_700_000);
    await delivery(fetcher).flush();
    expect(seen).toEqual([T2]);
    expect((await job()).state).toBe('accepted');
  });

  it('DeviceNotRegistered at send time removes only that device and still completes the job', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await svc.registerDevice('p1', T2); await queue();
    const fetcher = vi.fn(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).to === T1 ? ok({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }) : ticket('tk2'));
    await delivery(fetcher).flush();
    expect((await job()).state).toBe('accepted');
    expect((await store.list<{ token: string }>('devices')).map((d) => d.token)).toEqual([T2]);
  });

  it('receipt polling waits 15 minutes, marks delivered, and removes devices reported unregistered', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await svc.registerDevice('p1', T2); await queue();
    const send = vi.fn(async (_u: string, init: { body: string }) => ticket('tk-' + JSON.parse(init.body).to));
    await delivery(send).flush();
    const early = vi.fn();
    await delivery(early).flush();
    expect(early).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const receipts = vi.fn().mockResolvedValue(ok({ data: { ['tk-' + T1]: { status: 'ok' }, ['tk-' + T2]: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }));
    await delivery(receipts).flush();
    expect(String(receipts.mock.calls[0]![0])).toContain('getReceipts');
    const saved = await store.list<{ token: string; status: string }>('pushReceipts');
    expect(saved.find((r) => r.token === T1)!.status).toBe('delivered');
    expect(saved.find((r) => r.token === T2)!.status).toBe('failed');
    expect((await store.list<{ token: string }>('devices')).map((d) => d.token)).toEqual([T1]);
  });

  it('a failed receipt request leaves tickets accepted for the next pass and never throws', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    await delivery(vi.fn().mockResolvedValue(ticket('tk1'))).flush();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await delivery(vi.fn().mockRejectedValue(new Error('net'))).flush();
    await delivery(vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })).flush();
    expect((await store.list<{ status: string }>('pushReceipts'))[0]!.status).toBe('accepted');
    await delivery(vi.fn().mockResolvedValue(ok({ data: {} }))).flush(); // not available yet, kept
    expect((await store.list<{ status: string }>('pushReceipts'))[0]!.status).toBe('accepted');
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await delivery(vi.fn().mockResolvedValue(ok({ data: {} }))).flush();
    expect((await store.list<{ status: string }>('pushReceipts'))[0]!.status).toBe('unknown');
  });

  it('concurrent flushes on one instance do not double send', async () => {
    await svc.preferences('p1', true); await svc.registerDevice('p1', T1); await queue();
    const fetcher = vi.fn().mockResolvedValue(ticket('tk1'));
    const d = delivery(fetcher);
    await Promise.all([d.flush(), d.flush(), d.flush()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts a mocked Toss response without making a provider request', async () => {
    await svc.preferences('p1', true); await queue();
    await writeFile(join(dir, 'fixture-cert.pem'), 'test certificate input');
    await writeFile(join(dir, 'fixture-key.pem'), 'test private key input');
    mockTossRequest({
      kind: 'reply',
      statusCode: 200,
      body: JSON.stringify({ resultType: 'SUCCESS', success: { sentPushCount: 1, sentInboxCount: 0 } }),
    });

    await tossDelivery().flush();

    expect(tossRequestMock).toHaveBeenCalledTimes(1);
    expect(await job()).toMatchObject({ state: 'accepted', attempts: 1 });
  });

  it.each([
    ['provider rejection', {
      kind: 'reply',
      statusCode: 403,
      body: JSON.stringify({ resultType: 'FAIL', error: { reason: 'provider-body-secret' } }),
    }],
    ['invalid response', { kind: 'reply', statusCode: 200, body: 'provider-body-secret' }],
    ['timeout', { kind: 'timeout' }],
    ['socket failure', { kind: 'socket-error', message: 'socket-error-secret' }],
  ] as const)('retries a Toss %s using a fixed safe error code', async (_label, outcome) => {
    await svc.preferences('p1', true); await queue();
    await writeFile(join(dir, 'fixture-cert.pem'), 'test certificate input');
    await writeFile(join(dir, 'fixture-key.pem'), 'test private key input');
    mockTossRequest(outcome);

    await tossDelivery().flush();

    const saved = await job();
    expect(saved).toMatchObject({ state: 'pending', attempts: 1, error: 'DELIVERY_FAILED' });
    expect(JSON.stringify(saved)).not.toContain('provider-body-secret');
    expect(JSON.stringify(saved)).not.toContain('socket-error-secret');
  });
});
