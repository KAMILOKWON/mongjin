import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, expect, it } from 'vitest';
import { createFeedbackHandler, type FeedbackConfig } from './feedback';
import { PostgresFeedbackStore } from './feedbackStore';

const connection = process.env.MONGJIN_TEST_DATABASE_URL;
const servers: Server[] = [];
const stores: PostgresFeedbackStore[] = [];
let cleanupRequestId: string | undefined;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(stores.splice(0).map(store => store.close()));
  if (cleanupRequestId && connection) {
    const cleanup = new Pool({ connectionString: localTestConnection() });
    await cleanup.query('DELETE FROM mongjin_feedback_reports WHERE request_id = $1', [cleanupRequestId]);
    await cleanup.end();
    cleanupRequestId = undefined;
  }
});

function localTestConnection(): string {
  if (!connection) throw new Error('MONGJIN_TEST_DATABASE_URL is not set');
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55433') {
    throw new Error('Postgres feedback tests require a loopback-only test database on port 55433');
  }
  return connection;
}

function payload(requestId: string) {
  return {
    requestId,
    message: '대국 중 앱이 종료되어 진행 상태를 잃었습니다.',
    replyEmail: 'player@example.org',
    context: {
      appVersion: '1.2.3',
      platform: 'ios',
      osVersion: '18.1',
      language: 'ko-KR',
      playerId: 'player-test-1',
      screen: 'GameScreen',
      mode: 'ranked',
    },
  };
}

async function startServer(store: PostgresFeedbackStore, fetchImpl: typeof fetch): Promise<string> {
  const config: FeedbackConfig = {
    apiKey: 're_test_only_not_a_real_key',
    from: 'Mongjin Support <feedback@studiozzg.com>',
    to: 'hello@studiozzg.com',
  };
  const handler = createFeedbackHandler({ store, getConfig: () => config, fetchImpl });
  const server = createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local server address');
  return `http://127.0.0.1:${address.port}/feedback`;
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it.skipIf(!connection)('Postgres serializes same-ID delivery across handlers and preserves completion across restart', async () => {
  const testConnection = localTestConnection();
  const firstStore = new PostgresFeedbackStore(testConnection);
  stores.push(firstStore);
  await firstStore.initialize();
  const secondStore = new PostgresFeedbackStore(testConnection);
  stores.push(secondStore);
  await secondStore.initialize();

  const requestId = randomUUID();
  cleanupRequestId = requestId;
  const body = payload(requestId);
  let finishProvider!: () => void;
  let providerStarted!: () => void;
  const providerGate = new Promise<void>(resolve => { finishProvider = resolve; });
  const firstCallStarted = new Promise<void>(resolve => { providerStarted = resolve; });
  let providerCalls = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const emailPayloads: Array<Record<string, unknown>> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    providerCalls++;
    activeCalls++;
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
    emailPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (providerCalls === 1) {
      providerStarted();
      await providerGate;
    }
    activeCalls--;
    return new Response(JSON.stringify({ id: 'mock-resend-accepted' }), { status: 200 });
  };

  const firstUrl = await startServer(firstStore, mockFetch);
  const secondUrl = await startServer(secondStore, mockFetch);
  const firstRequest = post(firstUrl, body);
  await firstCallStarted;
  const concurrentRequest = post(secondUrl, body);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(providerCalls).toBe(1);
  finishProvider();

  const [firstResponse, secondResponse] = await Promise.all([firstRequest, concurrentRequest]);
  expect(firstResponse.status).toBe(201);
  expect(secondResponse.status).toBe(201);
  const firstReceipt = (await firstResponse.json()).receiptId;
  expect((await secondResponse.json()).receiptId).toBe(firstReceipt);
  expect(providerCalls).toBe(1);
  expect(maxActiveCalls).toBe(1);
  expect(emailPayloads[0]?.reply_to).toBe('player@example.org');
  expect(emailPayloads[0]?.from).toBe('Mongjin Support <feedback@studiozzg.com>');
  expect(emailPayloads[0]?.to).toEqual(['hello@studiozzg.com']);

  const restartStore = new PostgresFeedbackStore(testConnection);
  stores.push(restartStore);
  await restartStore.initialize();
  const restartedUrl = await startServer(restartStore, async () => {
    throw new Error('completed replay must not call Resend');
  });
  const replay = await post(restartedUrl, body);
  expect(replay.status).toBe(201);
  expect((await replay.json()).receiptId).toBe(firstReceipt);
  expect((await restartStore.get(requestId))?.status).toBe('completed');

  const collision = await post(restartedUrl, { ...body, message: '수정된 내용으로 같은 ID를 재사용했습니다.' });
  expect(collision.status).toBe(400);
  expect((await collision.json()).code).toBe('REQUEST_ID_CONFLICT');
});
