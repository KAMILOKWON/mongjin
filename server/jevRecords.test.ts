import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJevRecordStore, waitForJevRecord, type JevRecord } from './jevRecords';

describe('createJevRecordStore (file mode)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jev-records-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function collectRecords(
    generator: AsyncGenerator<JevRecord>,
  ): Promise<JevRecord[]> {
    const results: JevRecord[] = [];
    for await (const r of generator) {
      results.push(r);
    }
    return results;
  }

  it('handles saving failed then successful record for the same turn (atomic overwrite)', async () => {
    const store = await createJevRecordStore(tempDir);

    const failedRecord: JevRecord = {
      turnId: 'g1-ply-001',
      gameId: 'game-1',
      ply: 1,
      stateHash: 'hash-turn1',
      status: 'failed',
      error: 'timeout',
      attempt: 1,
    };

    await store.save(failedRecord);

    let records = await collectRecords(store.records());
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(failedRecord);

    const successRecord: JevRecord = {
      turnId: 'g1-ply-001',
      gameId: 'game-1',
      ply: 1,
      stateHash: 'hash-turn1',
      status: 'success',
      move: 'm2',
      attempt: 2,
    };

    await store.save(successRecord);

    records = await collectRecords(store.records());
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(successRecord);

    // Verify only one file exists on disk, no dangling .tmp files
    const files = await readdir(tempDir);
    expect(files).toEqual(['g1-ply-001.json']);
  });

  it('preserves separate turns cleanly', async () => {
    const store = await createJevRecordStore(tempDir);

    const turn1: JevRecord = {
      turnId: 'game1-ply-01',
      gameId: 'game-1',
      ply: 1,
      stateHash: 'hash-1',
      move: 'm0',
    };
    const turn2: JevRecord = {
      turnId: 'game1-ply-02',
      gameId: 'game-1',
      ply: 2,
      stateHash: 'hash-2',
      move: 'm3',
    };
    const turn3: JevRecord = {
      turnId: 'game1-ply-03',
      gameId: 'game-1',
      ply: 3,
      stateHash: 'hash-3',
      move: 'm1',
    };

    await store.save(turn1);
    await store.save(turn2);
    await store.save(turn3);

    const records = await collectRecords(store.records());
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.turnId)).toEqual([
      'game1-ply-01',
      'game1-ply-02',
      'game1-ply-03',
    ]);
  });

  it('serializes overlapping updates to a turn so the last status wins', async () => {
    const store = await createJevRecordStore(tempDir);
    const record = { turnId: 'overlapping', gameId: 'g1', ply: 0, stateHash: 'hash', status: 'selected' };
    const first = store.save(record);
    record.status = 'error';
    await Promise.all([first, store.save(record)]);
    expect(await collectRecords(store.records())).toEqual([record]);
    expect(await readdir(tempDir)).toEqual(['overlapping.json']);
    await store.close();
  });

  it('filters records by gameId accurately', async () => {
    const store = await createJevRecordStore(tempDir);

    const g1t1: JevRecord = {
      turnId: 'g1-p1',
      gameId: 'game-alpha',
      ply: 1,
      stateHash: 'h-a1',
    };
    const g1t2: JevRecord = {
      turnId: 'g1-p2',
      gameId: 'game-alpha',
      ply: 2,
      stateHash: 'h-a2',
    };
    const g2t1: JevRecord = {
      turnId: 'g2-p1',
      gameId: 'game-beta',
      ply: 1,
      stateHash: 'h-b1',
    };

    await store.save(g1t1);
    await store.save(g1t2);
    await store.save(g2t1);

    const alphaRecords = await collectRecords(store.records('game-alpha'));
    expect(alphaRecords).toHaveLength(2);
    expect(alphaRecords.map((r) => r.turnId)).toEqual(['g1-p1', 'g1-p2']);

    const betaRecords = await collectRecords(store.records('game-beta'));
    expect(betaRecords).toHaveLength(1);
    expect(betaRecords.map((r) => r.turnId)).toEqual(['g2-p1']);

    const nonExistent = await collectRecords(store.records('game-gamma'));
    expect(nonExistent).toHaveLength(0);

    const allRecords = await collectRecords(store.records());
    expect(allRecords).toHaveLength(3);
  });

  it('rejects invalid turnId with directory traversal attempts and malformed characters', async () => {
    const store = await createJevRecordStore(tempDir);

    const traversalIds = [
      '../evil',
      '../../etc/passwd',
      'sub/dir',
      '/root-escape',
      'turn 1',
      'turn.json',
      'turn*bad',
      'turn$var',
      '',
    ];

    for (const badId of traversalIds) {
      const invalidRecord: JevRecord = {
        turnId: badId,
        gameId: 'game-1',
        ply: 1,
        stateHash: 'hash-bad',
      };

      await expect(store.save(invalidRecord)).rejects.toThrow('Invalid JEV turn ID');
    }

    // Ensure no files were created
    let files: string[] = [];
    try {
      files = await readdir(tempDir);
    } catch {
      // directory might not even exist
    }
    expect(files).toHaveLength(0);
  });

  it('returns empty generator without error if store directory does not exist yet', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    const store = await createJevRecordStore(nonExistentDir);

    const records = await collectRecords(store.records());
    expect(records).toEqual([]);
  });

  it('automatically creates directory when saving first record', async () => {
    const nestedDir = join(tempDir, 'sub', 'storage');
    const store = await createJevRecordStore(nestedDir);

    await store.save({
      turnId: 'valid-turn-1',
      gameId: 'g1',
      ply: 1,
      stateHash: 'h1',
    });

    const files = await readdir(nestedDir);
    expect(files).toEqual(['valid-turn-1.json']);

    await store.close();
  });
});

describe('JEV recording deadline', () => {
  afterEach(() => vi.useRealTimers());
  it('rejects a stalled write at the absolute turn deadline', async () => {
    vi.useFakeTimers();
    const write = new Promise<void>(() => {});
    const result = expect(waitForJevRecord(write, Date.now() + 30_000)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels waiting for persistence without applying a stale move', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = expect(waitForJevRecord(new Promise<void>(() => {}), Date.now() + 30_000, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('round-trips JSONB decisions and paginates a game past 100 turns', async () => {
  const url = process.env.MONGJIN_TEST_DATABASE_URL!;
  const store = await createJevRecordStore('/unused-postgres-path', url);
  const gameId = randomUUID();
  try {
    await Promise.all(Array.from({ length: 101 }, (_, ply) => store.save({
      turnId: `${gameId}-${String(ply).padStart(3, '0')}`, gameId, ply, stateHash: `hash-${ply}`,
      nested: { distribution: { first: 0.3, second: 0.7 }, status: 'selected' },
    })));
    const records = [];
    for await (const record of store.records(gameId)) records.push(record);
    expect(records).toHaveLength(101);
    expect(records[100]).toMatchObject({ ply: 100, nested: { distribution: { first: 0.3, second: 0.7 } } });
    await store.save({ ...records[0]!, status: 'applied' });
    for await (const record of store.records(gameId)) {
      if (record.ply === 0) expect(record.status).toBe('applied');
    }
  } finally {
    await store.close();
    const cleanup = new Pool({ connectionString: url });
    try { await cleanup.query('DELETE FROM mongjin_jev_turns WHERE game_id = $1', [gameId]); }
    finally { await cleanup.end(); }
  }
});
