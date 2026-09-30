import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FeedbackSubmission } from './feedback';
import { FileFeedbackStore, type FeedbackRecord } from './feedbackStore';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mongjin-feedback-store-'));
  directories.push(directory);
  return directory;
}

function feedbackRecord(requestId: string, message: string): FeedbackRecord {
  const submission: FeedbackSubmission = {
    message,
    context: { appVersion: '1.2.3', platform: 'ios', osVersion: '18', language: 'ko-KR' },
  };
  return {
    schemaVersion: 1,
    requestId,
    payloadHash: createHash('sha256').update(JSON.stringify(submission)).digest('hex'),
    submission,
    receiptId: randomUUID(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    from: 'Mongjin <feedback@studiozzg.com>',
    to: 'hello@studiozzg.com',
  };
}

it('atomically creates one record for a request ID and preserves the winning payload', async () => {
  const directory = newDirectory();
  const firstStore = new FileFeedbackStore(directory);
  const secondStore = new FileFeedbackStore(directory);
  const requestId = randomUUID();
  const first = feedbackRecord(requestId, '첫 번째 문의입니다.');
  const second = feedbackRecord(requestId, '다른 문의 내용입니다.');

  const [left, right] = await Promise.all([
    firstStore.createIfAbsent(first),
    secondStore.createIfAbsent(second),
  ]);
  expect(left.payloadHash).toBe(right.payloadHash);
  expect([first.payloadHash, second.payloadHash]).toContain(left.payloadHash);
  expect((await firstStore.get(requestId))?.payloadHash).toBe(left.payloadHash);
  await firstStore.close();
  await secondStore.close();
});

it('serializes retry work and durably exposes a completed state to a reopened store', async () => {
  const directory = newDirectory();
  const store = new FileFeedbackStore(directory);
  const requestId = randomUUID();
  const pending = feedbackRecord(requestId, '게임 중 화면이 꺼져요.');
  await store.createIfAbsent(pending);

  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
  let deliveryAttempts = 0;

  const first = store.withRecordLock(requestId, async (record, save) => {
    expect(record.status).toBe('pending');
    deliveryAttempts++;
    announceFirst();
    await firstGate;
    await save({ ...record, status: 'completed', completedAt: new Date().toISOString() });
    return record.status;
  });
  await firstStarted;
  const retry = store.withRecordLock(requestId, async record => {
    if (record.status === 'pending') deliveryAttempts++;
    return record.status;
  });
  releaseFirst();

  expect(await Promise.all([first, retry])).toEqual(['completed', 'completed']);
  expect(deliveryAttempts).toBe(1);
  const reopened = new FileFeedbackStore(directory);
  const stored = await reopened.get(requestId);
  expect(stored?.status).toBe('completed');
  expect(stored?.receiptId).toBe(pending.receiptId);
  await store.close();
  await reopened.close();
});
