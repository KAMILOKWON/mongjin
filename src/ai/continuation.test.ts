import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../core/config';
import { applyMove } from '../core/apply';
import { getResult } from '../core/result';
import { initialState, legalMoves } from '../core/rules';
import type { GameState, Move, Piece } from '../core/types';
import { chooseMove, type AiSearchStats } from './ai';

const SMALL_CONFIG: RuleConfig = {
  boardSize: 5,
  guardCount: 0,
  goalCells: 'center-1',
  placement: 'adjacent',
  guardMove: 'step',
  kingSurroundLoss: true,
  noGuardOnGoal: true,
  kingCapture: true,
};

function isLegal(state: GameState, move: Move): boolean {
  return legalMoves(state, SMALL_CONFIG).some((candidate) =>
    JSON.stringify(candidate) === JSON.stringify(move));
}

function immediateGoalState(): GameState {
  const board: (Piece | null)[][] = Array.from(
    { length: SMALL_CONFIG.boardSize },
    () => Array.from({ length: SMALL_CONFIG.boardSize }, () => null),
  );
  board[0]![0] = { player: 'BLACK', type: 'KING' };
  board[3]![2] = { player: 'WHITE', type: 'KING' };
  return {
    board,
    turn: 'WHITE',
    guardsInHand: { BLACK: 0, WHITE: 0 },
    history: [],
    positionCounts: {},
  };
}

describe('AI conditional continuation callback', () => {
  it('returns a bounded canonical-legal TT continuation without changing selection or source state', () => {
    const state = initialState(SMALL_CONFIG);
    const before = structuredClone(state);
    const options = { maxMs: 2_000, maxDepth: 3, maxNodes: 50_000 };
    const baseline = chooseMove(state, SMALL_CONFIG, options);
    let line: Move[] | null = null;
    let stats: AiSearchStats | null = null;

    const selected = chooseMove(state, SMALL_CONFIG, {
      ...options,
      onSearchComplete: (value) => { stats = value; },
      onContinuation: (value) => { line = value; },
    });

    expect(selected).toEqual(baseline);
    expect(state).toEqual(before);
    expect(line).not.toBeNull();
    expect(line![0]).toEqual(selected);
    expect(line!.length).toBeGreaterThan(1);
    expect(line!.length).toBeLessThanOrEqual(Math.max(1, stats!.completedDepth));

    let replay = state;
    for (let index = 0; index < line!.length; index++) {
      const move = line![index]!;
      expect(isLegal(replay, move)).toBe(true);
      replay = applyMove(replay, move);
      if (getResult(replay, SMALL_CONFIG)) expect(index).toBe(line!.length - 1);
    }
  });

  it('reports an immediate selected win as a one-move terminal line at completed depth zero', () => {
    const state = immediateGoalState();
    const before = structuredClone(state);
    let line: Move[] | null = null;
    let completedDepth = -1;

    const selected = chooseMove(state, SMALL_CONFIG, {
      maxMs: 500,
      maxDepth: 4,
      maxNodes: 1_000,
      onSearchComplete: (stats) => { completedDepth = stats.completedDepth; },
      onContinuation: (value) => { line = value; },
    });

    expect(completedDepth).toBe(0);
    expect(line).toEqual([selected]);
    expect(selected).not.toBeNull();
    expect(getResult(applyMove(state, selected!), SMALL_CONFIG)).toEqual({
      winner: 'WHITE',
      reason: 'goal',
    });
    expect(state).toEqual(before);
  });
});
