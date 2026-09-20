import { describe, expect, it } from 'vitest';
import { chooseMove } from '../src/ai/ai';
import { moveKey } from '../src/bot/moveKey';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves, positionKey } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';
import { RECORD_RULES_VERSION, type GameRecord } from './gameRecords';
import {
  buildHumanStyleBook,
  humanStylePositionKey,
  humanStylePreference,
  type HumanStyleBook,
  type HumanStyleSample,
} from './humanStyle';

const config: RuleConfig = { ...DEFAULT_CONFIG };
const budget = {
  maxMs: 5_000,
  maxNodes: 4_000,
  maxDepth: 4,
  strategyLevel: 2 as const,
  choiceWindow: 48,
};

function finishedRecord(matchId: string, firstMove?: Move): GameRecord {
  let state = initialState(config);
  for (let ply = 0; ply < 30 && !getResult(state, config); ply += 1) {
    const moves = legalMoves(state, config);
    const move = ply === 0 && firstMove
      ? firstMove
      : state.turn === 'BLACK'
        ? moves.find((candidate) => candidate.kind === 'MOVE' && candidate.to.r === candidate.from.r - 1)
        : moves.find((candidate) => candidate.kind === 'MOVE' && candidate.to.r === candidate.from.r);
    if (!move || !moves.some((candidate) => JSON.stringify(candidate) === JSON.stringify(move))) {
      throw new Error(`Missing legal fixture move at ply ${ply + 1}`);
    }
    state = applyMove(state, move);
  }
  const result = getResult(state, config);
  if (!result) throw new Error('Fixture did not reach a natural result');
  return {
    schemaVersion: 1,
    rulesVersion: RECORD_RULES_VERSION,
    matchId,
    kind: 'random',
    startedAt: '2026-09-20T00:00:00.000Z',
    endedAt: '2026-09-20T00:01:00.000Z',
    status: 'completed',
    players: {
      BLACK: { kind: 'human', rating: 1800 },
      WHITE: { kind: 'human', rating: 1750 },
    },
    config: { ...config },
    moves: state.history,
    ...result,
    revision: 1,
  };
}

function subjectMoveCount(record: GameRecord, side: Player): number {
  return record.moves.filter((_move, index) => (index % 2 === 0 ? 'BLACK' : 'WHITE') === side).length;
}

function replayPrefix(record: GameRecord, length: number): GameState {
  return record.moves.slice(0, length).reduce((state, move) => applyMove(state, move), initialState(record.config));
}

function reordered(move: Move): Move {
  if (move.kind === 'PLACE') return { to: { c: move.to.c, r: move.to.r }, kind: 'PLACE' };
  return {
    to: { c: move.to.c, r: move.to.r },
    from: { c: move.from.c, r: move.from.r },
    kind: 'MOVE',
  };
}

function syntheticBook(state: GameState, preferred: Move, count = 8): HumanStyleBook {
  return {
    version: 1,
    rulesVersion: RECORD_RULES_VERSION,
    games: 1,
    moves: count,
    positions: {
      [humanStylePositionKey(state, config)]: { [moveKey(preferred)]: count },
    },
  };
}

function tacticalPosition(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  guardsInHand: Record<Player, number> = { BLACK: 1, WHITE: 0 },
): GameState {
  const state = initialState(config);
  state.board = state.board.map((row) => row.map(() => null));
  for (const [r, c, player, type] of pieces) state.board[r]![c] = { player, type };
  state.turn = turn;
  state.guardsInHand = guardsInHand;
  state.history = [];
  state.positionCounts = { [positionKey(state)]: 1 };
  return state;
}

describe('human-style 기보 빌더', () => {
  it('자연 종료 기보에서 지정한 사람 진영의 수만 익명 빈도로 집계한다', () => {
    const record = finishedRecord('private-match-id');
    const book = buildHumanStyleBook([{ record, eligibleSide: 'BLACK' }]);
    const root = initialState(config);
    const preference = humanStylePreference(book, root, config, 'BLACK');

    expect(book).toMatchObject({
      version: 1,
      rulesVersion: RECORD_RULES_VERSION,
      games: 1,
      moves: subjectMoveCount(record, 'BLACK'),
    });
    expect(Object.values(book.positions).flatMap((counts) => Object.values(counts))
      .reduce((sum, count) => sum + count, 0)).toBe(book.moves);
    expect(preference?.(root, record.moves[0]!)).toBeCloseTo(1 / 3);
    expect(humanStylePreference(book, replayPrefix(record, 1), config, 'WHITE')).toBeUndefined();

    const serialized = JSON.stringify(book);
    expect(Object.keys(book).sort()).toEqual(['games', 'moves', 'positions', 'rulesVersion', 'version']);
    expect(serialized).not.toContain(record.matchId);
    for (const privateField of ['matchId', 'players', 'rating', 'name', 'token', 'startedAt', 'endedAt']) {
      expect(serialized).not.toContain(`\"${privateField}\"`);
    }
  });

  it('JSONB가 객체 키 순서를 바꿔도 같은 합법 기보로 처리한다', () => {
    const canonical = finishedRecord('canonical-order');
    const jsonbOrder: GameRecord = {
      ...canonical,
      matchId: 'jsonb-order',
      moves: canonical.moves.map(reordered),
    };

    expect(buildHumanStyleBook([{ record: jsonbOrder, eligibleSide: 'BLACK' }]))
      .toEqual(buildHumanStyleBook([{ record: canonical, eligibleSide: 'BLACK' }]));
  });

  it('관측 빈도와 표본 수를 함께 반영하고 미관측 수는 0점으로 둔다', () => {
    const root = initialState(config);
    const straight = legalMoves(root, config).find((move) => move.kind === 'MOVE' && move.to.r === 7 && move.to.c === 4)!;
    const sidestep = legalMoves(root, config).find((move) => move.kind === 'MOVE' && move.to.r === 8 && move.to.c === 3)!;
    const unobserved = legalMoves(root, config).find((move) => move.kind === 'PLACE')!;
    const samples: HumanStyleSample[] = [
      { record: finishedRecord('frequency-a', straight), eligibleSide: 'BLACK' },
      { record: finishedRecord('frequency-b', straight), eligibleSide: 'BLACK' },
      { record: finishedRecord('frequency-c', sidestep), eligibleSide: 'BLACK' },
    ];
    const preference = humanStylePreference(buildHumanStyleBook(samples), root, config, 'BLACK')!;

    expect(preference(root, straight)).toBeCloseTo(3 / 5);
    expect(preference(root, sidestep)).toBeCloseTo(3 / 10);
    expect(preference(root, unobserved)).toBe(0);
  });

  it('흑과 백의 관측 국면을 분리하고 규칙 설정이 다른 조회를 거부한다', () => {
    const black = finishedRecord('black-subject');
    const white = finishedRecord('white-subject');
    const book = buildHumanStyleBook([
      { record: black, eligibleSide: 'BLACK' },
      { record: white, eligibleSide: 'WHITE' },
    ]);
    const blackRoot = initialState(config);
    const whiteRoot = replayPrefix(white, 1);
    const otherConfig = { ...config, kingCapture: !config.kingCapture };

    expect(humanStylePreference(book, blackRoot, config, 'BLACK')?.(blackRoot, black.moves[0]!)).toBeGreaterThan(0);
    expect(humanStylePreference(book, whiteRoot, config, 'WHITE')?.(whiteRoot, white.moves[1]!)).toBeGreaterThan(0);
    expect(humanStylePreference(book, blackRoot, config, 'WHITE')).toBeUndefined();
    expect(humanStylePreference(book, whiteRoot, config, 'BLACK')).toBeUndefined();
    expect(humanStylePositionKey(blackRoot, otherConfig)).not.toBe(humanStylePositionKey(blackRoot, config));
    expect(humanStylePreference(book, blackRoot, otherConfig, 'BLACK')).toBeUndefined();
    expect(humanStylePreference({ ...book, version: 2 } as unknown as HumanStyleBook, blackRoot, config, 'BLACK')).toBeUndefined();
    expect(humanStylePreference({ ...book, rulesVersion: 'future-rules' }, blackRoot, config, 'BLACK')).toBeUndefined();
    expect(humanStylePreference({ ...book, positions: {} }, blackRoot, config, 'BLACK')).toBeUndefined();
  });

  it('불완전·비자연 종료와 지원하지 않는 규칙 버전을 거부한다', () => {
    const record = finishedRecord('invalid-completion');
    const invalid = [
      { ...record, status: 'playing' as const, endedAt: undefined, winner: undefined, reason: undefined },
      { ...record, reason: 'resign' },
      { ...record, reason: 'disconnect' },
      { ...record, schemaVersion: 2 as 1 },
      { ...record, rulesVersion: 'future-rules' },
    ];
    for (const candidate of invalid) {
      expect(() => buildHumanStyleBook([{ record: candidate, eligibleSide: 'BLACK' }])).toThrow();
    }
  });

  it('형태가 엄격하지 않거나 합법적으로 재생할 수 없는 수를 거부한다', () => {
    const record = finishedRecord('invalid-move');
    const withExtraMoveField = {
      ...record,
      moves: [{ ...record.moves[0]!, source: 'private-annotation' }, ...record.moves.slice(1)] as Move[],
    };
    const impossible = {
      ...record,
      moves: [
        { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 0, c: 0 } } as Move,
        ...record.moves.slice(1),
      ],
    };

    expect(() => buildHumanStyleBook([{ record: withExtraMoveField, eligibleSide: 'BLACK' }])).toThrow();
    expect(() => buildHumanStyleBook([{ record: impossible, eligibleSide: 'BLACK' }])).toThrow();
  });

  it('기보 결과 불일치, 사람이 아닌 대상 진영, 중복 matchId를 거부한다', () => {
    const record = finishedRecord('duplicate-match');
    const wrongResult = { ...record, winner: record.winner === 'BLACK' ? 'WHITE' as const : 'BLACK' as const };
    const botSubject: GameRecord = {
      ...record,
      matchId: 'bot-subject',
      players: { ...record.players, BLACK: { kind: 'bot', rating: 1600 } },
    };

    expect(() => buildHumanStyleBook([{ record: wrongResult, eligibleSide: 'BLACK' }])).toThrow();
    expect(() => buildHumanStyleBook([{ record: botSubject, eligibleSide: 'BLACK' }])).toThrow();
    expect(() => buildHumanStyleBook([
      { record, eligibleSide: 'BLACK' },
      { record, eligibleSide: 'WHITE' },
    ])).toThrow();
  });
});

describe('human-style 선호와 탐색 안전성', () => {
  it('학습 빈도가 다른 수를 가리켜도 즉시 승리와 유일한 즉시 패배 방어를 지킨다', () => {
    const winning = tacticalPosition([
      [7, 4, 'WHITE', 'KING'],
      [0, 0, 'BLACK', 'KING'],
    ], 'WHITE');
    const misleadingWinMove = legalMoves(winning, config).find((move) => move.to.r === 6)!;
    const winPreference = humanStylePreference(
      syntheticBook(winning, misleadingWinMove), winning, config, 'WHITE',
    )!;
    expect(winPreference(winning, misleadingWinMove)).toBeGreaterThan(0);
    const winner = chooseMove(winning, config, { ...budget, movePreference: winPreference })!;
    expect(getResult(applyMove(winning, winner), config)?.winner).toBe('WHITE');

    const defending = tacticalPosition([
      [7, 3, 'BLACK', 'KING'],
      [7, 2, 'WHITE', 'KING'],
    ], 'BLACK');
    const misleadingDefense = legalMoves(defending, config).find((move) => move.kind === 'PLACE')!;
    const defensePreference = humanStylePreference(
      syntheticBook(defending, misleadingDefense), defending, config, 'BLACK',
    )!;
    expect(defensePreference(defending, misleadingDefense)).toBeGreaterThan(0);
    for (const rng of [() => 0, () => 0.999]) {
      expect(chooseMove(defending, config, {
        ...budget,
        maxDepth: 1,
        rng,
        movePreference: defensePreference,
      })).toEqual({ kind: 'MOVE', from: { r: 7, c: 3 }, to: { r: 8, c: 3 } });
    }
  });

  it('관측된 저평가 수를 근접 최선 후보군으로 끌어올리지 않는다', () => {
    const state = initialState(config);
    const misplacedGuard = legalMoves(state, config).find((move) => move.kind === 'PLACE')!;
    const preference = humanStylePreference(syntheticBook(state, misplacedGuard), state, config, 'BLACK')!;
    const selected = chooseMove(state, config, { ...budget, movePreference: preference });

    expect(preference(state, misplacedGuard)).toBeGreaterThan(0);
    expect(selected?.kind).toBe('MOVE');
    expect(selected?.to.r).toBe(7);
  });
});
