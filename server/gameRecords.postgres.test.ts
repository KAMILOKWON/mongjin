import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { initialState, legalMoves } from '../src/core/rules';
import type { Move } from '../src/core/types';
import { PostgresGameRecordStore, RECORD_RULES_VERSION, replayRecord, trainingRecord, type GameRecord } from './gameRecords';

// Only point this at a disposable test database. Never falls back to DATABASE_URL.
it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('Postgres 실제 저장·재연결·동시 갱신·페이지 내보내기', async () => {
  const connection = process.env.MONGJIN_TEST_DATABASE_URL!;
  const store = new PostgresGameRecordStore(connection);
  const prefix = randomUUID();
  let state = initialState(DEFAULT_CONFIG);
  const place = legalMoves(state, DEFAULT_CONFIG).find((move) => move.kind === 'PLACE')!;
  state = applyMove(state, place);
  const move = legalMoves(state, DEFAULT_CONFIG).find((candidate) => candidate.kind === 'MOVE')!;
  const moves: Move[] = [place, move];
  const game: GameRecord = {
    schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId: `${prefix}-main`,
    kind: 'random', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: 'completed',
    players: { BLACK: { kind: 'human', rating: 1600 }, WHITE: { kind: 'human', rating: 1200 } },
    config: { ...DEFAULT_CONFIG }, moves, winner: 'WHITE', reason: 'resign', revision: 0,
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
    const restored = records.find((record) => record.matchId === game.matchId)!;
    expect(restored).toEqual({ ...game, revision: 9 });
    expect(replayRecord(restored).history).toEqual(moves);
    expect(trainingRecord(restored, {
      minElo: 1200, both: true, includeBots: false, includeForfeits: true,
    })).toMatchObject({ winner: 'WHITE', reason: 'resign', moves });
  } finally { await reopened.close(); }
}, 15000);
