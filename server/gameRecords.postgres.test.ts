import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { PostgresGameRecordStore, RECORD_RULES_VERSION, type GameRecord } from './gameRecords';

// Only point this at a disposable test database. Never falls back to DATABASE_URL.
it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('Postgres 실제 저장·재연결·동시 갱신·페이지 내보내기', async () => {
  const connection = process.env.MONGJIN_TEST_DATABASE_URL!;
  const store = new PostgresGameRecordStore(connection);
  const prefix = randomUUID();
  const game: GameRecord = {
    schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId: `${prefix}-main`,
    kind: 'random', startedAt: new Date().toISOString(), status: 'playing',
    players: { BLACK: { kind: 'human', rating: 1600 }, WHITE: { kind: 'human', rating: 1200 } },
    config: { ...DEFAULT_CONFIG }, moves: [], revision: 0,
  };
  try {
    await store.initialize(); await store.initialize();
    await store.save(game);
    await Promise.all([9, 2, 4, 1, 7].map((revision) => store.save({ ...game, revision })));
    for (let i = 0; i < 201; i++) await store.save({ ...game, matchId: `${prefix}-${i}` });
  } finally { await store.close(); }
  const reopened = new PostgresGameRecordStore(connection);
  try {
    const records = [];
    for await (const record of reopened.records()) if (record.matchId.startsWith(prefix)) records.push(record);
    expect(records).toHaveLength(202);
    expect(records.find((r) => r.matchId === game.matchId)).toEqual({ ...game, revision: 9 });
  } finally { await reopened.close(); }
}, 15000);
