import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { FileGameRecordStore, GameRecorder, RECORD_RULES_VERSION, replayRecord, trainingRecord, type GameRecord } from './gameRecords';

function record(): GameRecord {
  return {
    schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId: 'test-game', kind: 'random',
    startedAt: '2026-09-07T00:00:00Z', endedAt: '2026-09-07T00:01:00Z',
    status: 'completed', players: { BLACK: { kind: 'human', rating: 1500 }, WHITE: { kind: 'human', rating: 1200 } },
    config: { ...DEFAULT_CONFIG }, moves: [legalMoves(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG)[0]!],
    winner: 'BLACK', reason: 'resign', revision: 2,
  };
}
const options = { minElo: 1500, both: false, includeBots: false, includeForfeits: true };

describe('기보 저장과 학습 내보내기', () => {
  it('Elo 경계와 진영, 봇/항복/이탈/미완료를 구분한다', () => {
    const game = record();
    expect(trainingRecord(game, options)?.eligibleSides).toEqual(['BLACK']);
    expect(trainingRecord(game, { ...options, minElo: 1501 })).toBeNull();
    expect(trainingRecord(game, { ...options, both: true })).toBeNull();
    expect(trainingRecord(game, { ...options, both: true, minElo: 1200 })?.eligibleSides).toEqual(['BLACK', 'WHITE']);
    expect(trainingRecord(game, { ...options, includeForfeits: false })).toBeNull();
    expect(trainingRecord({ ...game, reason: 'disconnect' }, options)).toBeNull();
    expect(trainingRecord({ ...game, status: 'abandoned' }, options)).toBeNull();
    expect(trainingRecord({ ...game, status: 'playing' }, options)).toBeNull();
    game.kind = 'bot'; game.players.BLACK.kind = 'bot';
    expect(trainingRecord(game, options)).toBeNull();
    expect(trainingRecord(game, { ...options, includeBots: true })).toBeNull();
    expect(trainingRecord(game, { ...options, includeBots: true, minElo: 1200 })?.eligibleSides).toEqual(['WHITE']);
  });
  it('합법 수순 재생, 불법 수/잘못된 결과/규칙 버전을 검증한다', () => {
    const game = record();
    expect(replayRecord(game)).toEqual(applyMove(initialState(game.config), game.moves[0]!));
    expect(() => replayRecord({ ...game, moves: [{ kind: 'PLACE', to: { r: 99, c: 99 } }] })).toThrow('Illegal');
    expect(() => replayRecord({ ...game, reason: 'goal' })).toThrow('Result mismatch');
    expect(() => replayRecord({ ...game, rulesVersion: 'future' })).toThrow('Unsupported');
  });
  it('내보내기에 계정 정보가 들어가지 않는다', () => {
    const game = record();
    Object.assign(game, { token: 'secret', playerId: 'private' });
    Object.assign(game.players.BLACK, { token: 'secret', name: 'private' });
    const serialized = JSON.stringify(trainingRecord(game, options));
    expect(serialized).not.toMatch(/secret|private|token|playerId/);
  });
  it('재시작 후 읽기, 중복/오래된 저장 차단, 스냅샷 격리를 보장한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mongjin-record-unit-'));
    try {
      const store = new FileGameRecordStore(dir);
      const recorder = new GameRecorder(store);
      const game = record();
      const first = recorder.save(game);
      game.players.BLACK.rating = 900;
      await first;
      await store.save({ ...game, revision: 1 });
      const reopened = new FileGameRecordStore(dir);
      const records = [];
      for await (const entry of reopened.records()) records.push(entry);
      expect(records).toHaveLength(1);
      expect(records[0]!.players.BLACK.rating).toBe(1500);
      await expect(store.save({ ...game, matchId: '../escape' })).rejects.toThrow('Invalid');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('일시적 저장 오류를 재시도하고 최종 스냅샷을 보존한다', async () => {
    let calls = 0;
    const saved: GameRecord[] = [];
    const errors: unknown[] = [];
    const recorder = new GameRecorder({
      async save(game) { if (++calls === 1) throw new Error('temporary'); saved.push(game); },
      async *records() {}, async close() {},
    }, (error) => errors.push(error));
    void recorder.save({ ...record(), status: 'playing', revision: 1 });
    void recorder.save(record());
    await recorder.flush();
    expect(saved.map((game) => game.revision)).toEqual([1, 2]);
    expect(errors).toEqual([]);
  });
});
