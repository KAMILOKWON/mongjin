import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import { proveJevTerminalLosses } from './jevTerminalProof';

const smallConfig: RuleConfig = {
  ...DEFAULT_CONFIG,
  boardSize: 5,
  guardCount: 0,
  goalCells: 'center-1',
};

function stateWith(
  pieces: Array<{ r: number; c: number; piece: Piece }>,
  turn: Player = 'BLACK',
  config: RuleConfig = smallConfig,
): GameState {
  const board: (Piece | null)[][] = Array.from(
    { length: config.boardSize },
    () => Array.from({ length: config.boardSize }, () => null),
  );
  for (const { r, c, piece } of pieces) board[r]![c] = piece;
  return {
    board,
    turn,
    guardsInHand: { BLACK: config.guardCount, WHITE: config.guardCount },
    history: [],
    positionCounts: {},
  };
}

function move(from: [number, number], to: [number, number]): Move {
  return { kind: 'MOVE', from: { r: from[0], c: from[1] }, to: { r: to[0], c: to[1] } };
}

function place(to: [number, number]): Move {
  return { kind: 'PLACE', to: { r: to[0], c: to[1] } };
}

function findMove(state: GameState, config: RuleConfig, id: string): Move {
  const found = legalMoves(state, config).find((candidate) => jevMoveId(candidate) === id);
  if (!found) throw new Error(`Missing fixture move: ${id}`);
  return found;
}

function replayLegal(state: GameState, config: RuleConfig, moves: Move[]): GameState {
  let replay = structuredClone(state);
  for (const candidate of moves) {
    expect(legalMoves(replay, config)).toContainEqual(candidate);
    replay = applyMove(replay, candidate);
  }
  return replay;
}

function oracleForcedLoss(
  state: GameState,
  config: RuleConfig,
  attacker: Player,
  depth: number,
): boolean {
  const terminal = getResult(state, config);
  if (terminal) return terminal.winner === attacker;
  if (depth === 0) return false;
  const children = legalMoves(state, config).map((candidate) => applyMove(state, candidate));
  return state.turn === attacker
    ? children.some((child) => oracleForcedLoss(child, config, attacker, depth - 1))
    : children.every((child) => oracleForcedLoss(child, config, attacker, depth - 1));
}

const V16_PLY7_HISTORY: Move[] = [
  move([8, 4], [7, 4]),
  move([0, 4], [1, 4]),
  move([7, 4], [6, 4]),
  move([1, 4], [2, 3]),
  move([6, 4], [5, 4]),
  place([3, 3]),
  move([5, 4], [4, 5]),
];

function v16Ply7State(): GameState {
  return replayLegal(initialState(DEFAULT_CONFIG), DEFAULT_CONFIG, V16_PLY7_HISTORY);
}

describe('proveJevTerminalLosses', () => {
  it('matches an independent canonical AND/OR oracle at depths 2 and 4', () => {
    const fixtures = [
      stateWith([
        { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
        { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
      ]),
      stateWith([
        { r: 3, c: 1, piece: { player: 'BLACK', type: 'KING' } },
        { r: 1, c: 3, piece: { player: 'WHITE', type: 'KING' } },
      ]),
    ];

    for (const state of fixtures) {
      const roots = legalMoves(state, smallConfig);
      for (const maxDepth of [2, 4]) {
        const attacker = opponent(state.turn);
        const expected = roots.map((root) => oracleForcedLoss(
          applyMove(state, root), smallConfig, attacker, maxDepth - 1,
        ));
        const result = proveJevTerminalLosses(state, smallConfig, roots, {
          deadlineMs: Date.now() + 2_000,
          maxNodes: 100_000,
          maxDepth,
        });

        expect(result.stopReason).toBe('complete');
        expect(result.candidates.map((candidate) => candidate.move)).toEqual(roots);
        expect(result.candidates.map((candidate) => candidate.proven === 'loss')).toEqual(expected);
        expect(result.candidates.every((candidate) => candidate.completed)).toBe(true);
      }
    }
  });

  it('accepts no roots without spending budget', () => {
    const state = initialState(DEFAULT_CONFIG);
    expect(proveJevTerminalLosses(state, DEFAULT_CONFIG, [], {
      deadlineMs: Date.now() - 1,
      maxNodes: 0,
      maxDepth: 8,
      signal: AbortSignal.abort(),
    })).toEqual({ nodes: 0, stopReason: 'complete', candidates: [] });
  });

  it('keeps interrupted and zero-node work unknown', () => {
    const state = stateWith([
      { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
      { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const root = findMove(state, smallConfig, 'm_4_0_3_0');

    const cases = [
      {
        expected: 'node-budget' as const,
        options: { deadlineMs: Date.now() + 2_000, maxNodes: 0, maxDepth: 4 },
      },
      {
        expected: 'deadline' as const,
        options: { deadlineMs: Date.now() - 1, maxNodes: 100, maxDepth: 4 },
      },
      {
        expected: 'aborted' as const,
        options: {
          deadlineMs: Date.now() + 2_000,
          maxNodes: 100,
          maxDepth: 4,
          signal: AbortSignal.abort(),
        },
      },
    ];

    for (const { expected, options } of cases) {
      const result = proveJevTerminalLosses(state, smallConfig, [root], options);
      expect(result.stopReason).toBe(expected);
      expect(result.candidates[0]).toMatchObject({
        proven: 'unknown',
        proof: null,
        principalVariation: [],
        searchedDepth: 0,
        completed: false,
        stopReason: expected,
      });
    }
  });

  it('does not promote a partial universal search at the node limit', () => {
    const state = v16Ply7State();
    const selected = findMove(state, DEFAULT_CONFIG, 'm_2_3_3_2');
    const result = proveJevTerminalLosses(state, DEFAULT_CONFIG, [selected], {
      deadlineMs: Date.now() + 2_000,
      maxNodes: 1_000,
      maxDepth: 8,
    });

    expect(result).toMatchObject({ nodes: 1_000, stopReason: 'node-budget' });
    expect(result.candidates[0]).toMatchObject({
      proven: 'unknown',
      proof: null,
      principalVariation: [],
      completed: false,
      stopReason: 'node-budget',
    });
  });

  it('proves the recorded ply-7 loss while leaving the two blocking alternatives unknown', () => {
    const state = v16Ply7State();
    expect(state.turn).toBe('WHITE');
    const before = structuredClone(state);
    const roots = [
      findMove(state, DEFAULT_CONFIG, 'm_2_3_3_2'),
      findMove(state, DEFAULT_CONFIG, 'm_3_3_3_4'),
      findMove(state, DEFAULT_CONFIG, 'p_3_4'),
    ];

    const result = proveJevTerminalLosses(state, DEFAULT_CONFIG, roots, {
      deadlineMs: Date.now() + 5_000,
      maxNodes: 100_000,
      maxDepth: 8,
    });

    expect(state).toEqual(before);
    expect(result.stopReason).toBe('complete');
    expect(result.nodes).toBeLessThanOrEqual(100_000);
    expect(result.candidates.map((candidate) => jevMoveId(candidate.move))).toEqual([
      'm_2_3_3_2',
      'm_3_3_3_4',
      'p_3_4',
    ]);
    expect(result.candidates.map((candidate) => candidate.proven)).toEqual([
      'loss',
      'unknown',
      'unknown',
    ]);

    const selected = result.candidates[0]!;
    expect(selected).toMatchObject({
      proof: { winner: 'BLACK', reason: 'goal', plies: 8 },
      searchedDepth: 8,
      completed: true,
      stopReason: 'complete',
    });
    const terminal = replayLegal(state, DEFAULT_CONFIG, selected.principalVariation);
    expect(selected.principalVariation).toHaveLength(selected.proof!.plies);
    expect(getResult(terminal, DEFAULT_CONFIG)).toEqual({
      winner: selected.proof!.winner,
      reason: selected.proof!.reason,
    });

    for (const alternative of result.candidates.slice(1)) {
      expect(alternative).toMatchObject({
        proof: null,
        principalVariation: [],
        searchedDepth: 8,
        completed: true,
        stopReason: 'complete',
      });
    }
  });
});
