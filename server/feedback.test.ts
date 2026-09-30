import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackHandler, createLazyFeedbackHandler, type FeedbackConfig } from './feedback';
import { FileFeedbackStore } from './feedbackStore';

const servers: Server[] = [];
const stores: FileFeedbackStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-feedback-'));
  directories.push(directory);
  return directory;
}

function testConfig(): FeedbackConfig {
  return {
    apiKey: 're_test_only_not_a_real_key',
    from: 'Mongjin Support <feedback@studiozzg.com>',
    to: 'hello@studiozzg.com',
  };
}

async function startServer(
  dataDir: string,
  options: Partial<Parameters<typeof createFeedbackHandler>[0]> = {},
) {
  const store = new FileFeedbackStore(dataDir);
  stores.push(store);
  const handler = createFeedbackHandler({
    store,
    getConfig: testConfig,
    fetchImpl: async () => new Response(null, { status: 200 }),
    ...options,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server address');
  return { url: `http://127.0.0.1:${address.port}/feedback`, store, server };
}

async function startLazyRouter(handler: ReturnType<typeof createLazyFeedbackHandler>) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else if (req.url === '/feedback') {
      void handler(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { healthUrl: `${baseUrl}/health`, feedbackUrl: `${baseUrl}/feedback` };
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    message: '게임 중 화면이 갑자기 꺼져요.',
    context: {
      appVersion: '1.2.3',
      platform: 'ios',
      osVersion: '18.1',
      language: 'ko-KR',
      playerId: 'player-123',
      screen: 'GameScreen',
      mode: 'ranked',
    },
    ...overrides,
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('feedback HTTP endpoint', () => {
  it('keeps health available and skips storage initialization without mail configuration', async () => {
    const createStore = vi.fn(async () => { throw new Error('storage is not available'); });
    const handler = createLazyFeedbackHandler({ createStore, getConfig: () => null });
    const router = await startLazyRouter(handler);

    expect((await fetch(router.healthUrl)).status).toBe(200);
    expect((await fetch(router.feedbackUrl)).status).toBe(405);
    const oversized = await post(router.feedbackUrl, 'x'.repeat(20 * 1024 + 1));
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).code).toBe('BODY_TOO_LARGE');
    const unavailable = await post(router.feedbackUrl, submission());
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).code).toBe('FEEDBACK_NOT_CONFIGURED');
    expect(createStore).not.toHaveBeenCalled();
  });

  it('contains feedback storage initialization failure to the feedback route', async () => {
    const createStore = vi.fn(() => { throw new Error('test storage failure'); });
    const handler = createLazyFeedbackHandler({ createStore, getConfig: testConfig });
    const router = await startLazyRouter(handler);

    expect((await fetch(router.healthUrl)).status).toBe(200);
    const firstUnavailable = await post(router.feedbackUrl, submission());
    expect(firstUnavailable.status).toBe(503);
    expect((await firstUnavailable.json()).code).toBe('FEEDBACK_STORAGE_UNAVAILABLE');
    const retryUnavailable = await post(router.feedbackUrl, submission());
    expect(retryUnavailable.status).toBe(503);
    expect((await retryUnavailable.json()).code).toBe('FEEDBACK_STORAGE_UNAVAILABLE');
    expect(createStore).toHaveBeenCalledTimes(2);
    expect((await fetch(router.healthUrl)).status).toBe(200);
  });

  it('accepts trimmed 1..3000 character reports and rejects blank or oversized fields', async () => {
    const directory = newDirectory();
    const sent: string[] = [];
    const endpoint = await startServer(directory, {
      fetchImpl: async (_input, init) => {
        sent.push(String(init?.body ?? ''));
        return new Response(null, { status: 200 });
      },
    });

    const oneCharacter = submission({ message: '  앱  ' });
    const accepted = await post(endpoint.url, oneCharacter);
    expect(accepted.status).toBe(201);
    expect(JSON.parse(sent[0]!).text).toContain('\n문의 내용:\n앱');

    const maximum = await post(endpoint.url, submission({ message: ` ${'가'.repeat(3000)} ` }));
    expect(maximum.status).toBe(201);
    const tooLong = await post(endpoint.url, submission({ message: '가'.repeat(3001) }));
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).code).toBe('INVALID_REQUEST');
    const blank = await post(endpoint.url, submission({ message: ' \n ' }));
    expect(blank.status).toBe(400);
    expect(sent).toHaveLength(2);
  });

  it('enforces the 20KB wire limit and allowlisted context lengths', async () => {
    const directory = newDirectory();
    const endpoint = await startServer(directory, {
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const oversized = await post(endpoint.url, 'x'.repeat(20 * 1024 + 1));
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).code).toBe('BODY_TOO_LARGE');

    const badContext = submission({
      context: { appVersion: '1', platform: 'ios', osVersion: 'x'.repeat(129), language: 'ko-KR' },
    });
    const response = await post(endpoint.url, badContext);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_REQUEST');

    const unknownContext = submission({
      context: { appVersion: '1', platform: 'ios', osVersion: '18', language: 'ko', token: 'must-not-be-accepted' },
    });
    expect((await post(endpoint.url, unknownContext)).status).toBe(400);
    await expect(endpoint.store.get((badContext as { requestId: string }).requestId)).resolves.toBeNull();
  });

  it('returns 503 without storing a report when Resend is not configured', async () => {
    const directory = newDirectory();
    const store = new FileFeedbackStore(directory);
    stores.push(store);
    const handler = createFeedbackHandler({
      store,
      getConfig: () => null,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const server = createServer((req, res) => { void handler(req, res); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local server address');

    const response = await post(`http://127.0.0.1:${address.port}/feedback`, submission());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'FEEDBACK_NOT_CONFIGURED',
      message: '문의 접수 기능이 아직 설정되지 않았습니다.',
    });
    expect(readdirSync(directory)).toEqual([]);
  });

  it('keeps failed deliveries pending and retries durably with the same Resend key', async () => {
    const directory = newDirectory();
    const body = submission({ replyEmail: 'player@example.org' });
    const calls: Array<{ key: string | null; body: Record<string, unknown> }> = [];
    const firstEndpoint = await startServer(directory, {
      fetchImpl: async (_input, init) => {
        calls.push({
          key: new Headers(init?.headers).get('Idempotency-Key'),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(null, { status: 503 });
      },
    });

    const failed = await post(firstEndpoint.url, body);
    expect(failed.status).toBe(503);
    expect((await failed.json()).code).toBe('FEEDBACK_DELIVERY_UNAVAILABLE');
    const pending = await firstEndpoint.store.get(body.requestId);
    expect(pending?.status).toBe('pending');
    expect(pending?.submission.message).toBe(body.message);
    const persistedFile = readFileSync(join(directory, `${body.requestId}.json`), 'utf8');
    expect(persistedFile).not.toContain('re_test_only_not_a_real_key');

    const restarted = await startServer(directory, {
      fetchImpl: async (_input, init) => {
        calls.push({
          key: new Headers(init?.headers).get('Idempotency-Key'),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ id: 'email-test-id' }), { status: 200 });
      },
    });
    const accepted = await post(restarted.url, body);
    expect(accepted.status).toBe(201);
    const receiptId = (await accepted.json()).receiptId;
    expect(receiptId).toBe(pending?.receiptId);
    expect((await restarted.store.get(body.requestId))?.status).toBe('completed');
    expect(calls[0]?.key).toBe(`mongjin-feedback-${body.requestId}`);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(calls[1]?.body.reply_to).toBe('player@example.org');
    expect(calls[1]?.body.from).toBe('Mongjin Support <feedback@studiozzg.com>');
    expect(calls[1]?.body.to).toEqual(['hello@studiozzg.com']);

    const replay = await post(restarted.url, body);
    expect(replay.status).toBe(201);
    expect((await replay.json()).receiptId).toBe(receiptId);
    expect(calls).toHaveLength(2);

    const collision = await post(restarted.url, { ...body, message: '다른 문의 내용입니다.' });
    expect(collision.status).toBe(400);
    expect((await collision.json()).code).toBe('REQUEST_ID_CONFLICT');
  });

  it('stops automatic retries before Resend idempotency can expire', async () => {
    const directory = newDirectory();
    const body = submission();
    const startTime = Date.UTC(2026, 8, 29, 1, 0, 0);
    const first = await startServer(directory, {
      now: () => startTime,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    expect((await post(first.url, body)).status).toBe(503);
    const pending = await first.store.get(body.requestId);
    expect(pending?.status).toBe('pending');

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const lateRetry = await startServer(directory, {
      now: () => startTime + 23 * 60 * 60 * 1000,
      fetchImpl,
    });
    const response = await post(lateRetry.url, body);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('FEEDBACK_DELIVERY_STATE_UNKNOWN');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await lateRetry.store.get(body.requestId))?.status).toBe('pending');
  });

  it('escapes HTML, preserves plaintext, and omits reply_to when no address was supplied', async () => {
    const directory = newDirectory();
    const sent: Array<Record<string, unknown>> = [];
    const endpoint = await startServer(directory, {
      fetchImpl: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 200 });
      },
    });

    const body = submission({ message: "<script>alert('x')</script> & 종료" });
    const response = await post(endpoint.url, body);
    expect(response.status).toBe(201);
    expect(sent[0]?.from).toBe('Mongjin Support <feedback@studiozzg.com>');
    expect(sent[0]?.text).toContain(body.message);
    expect(sent[0]?.html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; 종료');
    expect(sent[0]?.html).not.toContain('<script>');
    expect(Object.hasOwn(sent[0]!, 'reply_to')).toBe(false);
  });

  it('rejects header injection and invalid reply addresses before delivery', async () => {
    const directory = newDirectory();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const endpoint = await startServer(directory, { fetchImpl });
    const injected = await post(endpoint.url, submission({ replyEmail: 'player@example.org\r\nBcc: attacker@example.org' }));
    expect(injected.status).toBe(400);
    expect((await injected.json()).code).toBe('INVALID_REQUEST');
    const malformed = await post(endpoint.url, submission({ replyEmail: 'not-an-email' }));
    expect(malformed.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throttles by source IP with Retry-After and lets completed requests replay', async () => {
    const directory = newDirectory();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const endpoint = await startServer(directory, { fetchImpl, rateLimit: { limit: 1, windowMs: 60_000 } });
    const firstBody = submission();
    expect((await post(endpoint.url, firstBody)).status).toBe(201);
    expect((await post(endpoint.url, firstBody)).status).toBe(201);

    const limited = await post(endpoint.url, submission());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect((await limited.json()).code).toBe('RATE_LIMITED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores forwarded addresses unless the socket peer is explicitly trusted', async () => {
    const directory = newDirectory();
    const endpoint = await startServer(directory, {
      fetchImpl: async () => new Response(null, { status: 200 }),
      rateLimit: { limit: 1, windowMs: 60_000 },
    });
    const first = await post(endpoint.url, submission(), { 'X-Forwarded-For': '198.51.100.10' });
    const second = await post(endpoint.url, submission(), { 'X-Forwarded-For': '203.0.113.20' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it('uses the rightmost validated client address behind an explicitly trusted proxy', async () => {
    const directory = newDirectory();
    const endpoint = await startServer(directory, {
      fetchImpl: async () => new Response(null, { status: 200 }),
      rateLimit: { limit: 1, windowMs: 60_000 },
      trustedProxyIps: ['127.0.0.1'],
    });
    const first = await post(endpoint.url, submission(), {
      'X-Forwarded-For': '192.0.2.50, 198.51.100.10',
    });
    const second = await post(endpoint.url, submission(), {
      'X-Forwarded-For': '203.0.113.90, 198.51.100.10',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });
});
