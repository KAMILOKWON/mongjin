import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import {
  chooseJevGuardPressureMove,
  JEV_GUARD_PRESSURE_LIMITS,
  JEV_GUARD_PRESSURE_SCOPE,
  type JevGuardPressureFallback,
} from './jevPressurePolicy';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/jev-first-loss.json', import.meta.url), 'utf8'),
) as { moves: Move[] };

function reachableState(moves: Move[]): GameState {
  let state = initialState(DEFAULT_CONFIG);
  for (const saved of moves) {
    const canonical = legalMoves(state, DEFAULT_CONFIG)
      .find((move) => jevMoveId(move) === jevMoveId(saved));
    expect(canonical, `fixture move ${jevMoveId(saved)} must be legal`).toBeDefined();
    state = applyMove(state, canonical!);
  }
  return state;
}

function canonicalMove(state: GameState, id: string): Move {
  const move = legalMoves(state, DEFAULT_CONFIG).find((candidate) => jevMoveId(candidate) === id);
  expect(move, `${id} must be legal`).toBeDefined();
  return move!;
}

const firstLegal: JevGuardPressureFallback = (state, config, options) => {
  options.onSearchComplete?.({
    nodes: Math.min(options.maxNodes ?? 0, 7),
    completedDepth: 1,
    elapsedMs: 0.1,
    aborted: false,
  });
  return legalMoves(state, config)[0] ?? null;
};

const options = (fallback: JevGuardPressureFallback = firstLegal) => ({
  deadlineMs: Date.now() + 5_000,
  maxNodes: 2_048,
  fallback,
});

function rotatedAndSwapped(state: GameState): GameState {
  const n = state.board.length;
  const board: GameState['board'] = Array.from({ length: n }, () => Array(n).fill(null));
  const swap = (player: Player): Player => player === 'BLACK' ? 'WHITE' : 'BLACK';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const piece = state.board[r]![c];
      if (piece) board[n - 1 - r]![n - 1 - c] = { ...piece, player: swap(piece.player) };
    }
  }
  return {
    board,
    turn: swap(state.turn),
    guardsInHand: {
      BLACK: state.guardsInHand.WHITE,
      WHITE: state.guardsInHand.BLACK,
    },
    history: [],
    positionCounts: {},
  };
}

describe('chooseJevGuardPressureMove', () => {
  it.each([false, true])('blocks before contact at ply 5, rotated=%s', (rotate) => {
    const original = reachableState(fixture.moves.slice(0, 5));
    const state = rotate ? rotatedAndSwapped(original) : original;
    const before = structuredClone(state);
    const fallback = vi.fn(firstLegal);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options(fallback));

    expect(jevMoveId(decision.move!)).toBe(rotate ? 'p_5_4' : 'p_3_4');
    expect(decision.source).toBe('guard-pressure');
    expect(decision.stats.enemyForwardBaseline).toMatchObject({
      complete: true, safeForwardKingMoves: 3,
    });
    expect(decision.stats.selected).toMatchObject({
      directThreat: false,
      proactiveBlocking: true,
      forwardEscapeReduction: 1,
      forwardSafeKingEscapes: 2,
      immediateWinningResponses: 0,
      safeCounterCaptures: 0,
      complete: true,
      eligible: true,
    });
    expect(state).toEqual(before);
    expect(legalMoves(state, DEFAULT_CONFIG).map(jevMoveId)).toContain(jevMoveId(decision.move!));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects a proactive blocker with a safe guard countercapture', () => {
    const state = reachableState(fixture.moves.slice(0, 5));
    state.board[3]![3] = { player: 'BLACK', type: 'GUARD' };
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options());

    expect(decision.stats.pressureCandidates.find((candidate) => candidate.id === 'p_3_4'))
      .toMatchObject({
        directThreat: false,
        proactiveBlocking: true,
        safeCounterCaptures: 1,
        eligible: false,
        complete: true,
      });
    expect(decision.stats.selected?.id).not.toBe('p_3_4');
  });

  it('returns unknown when the baseline exhausts its transition budget', () => {
    const state = reachableState(fixture.moves.slice(0, 5));
    const fallback = vi.fn(firstLegal);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(fallback), maxNodes: legalMoves(state, DEFAULT_CONFIG).length + 1,
    });

    expect(decision).toMatchObject({
      move: null,
      source: 'interrupted',
      stats: {
        complete: false,
        stopReason: 'node-budget',
        enemyForwardBaseline: { complete: false, checkedMoves: 1, safeForwardKingMoves: null },
      },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('selects the recorded anchor-preserving p_3_3 pressure at first-loss ply 7', () => {
    const state = reachableState(fixture.moves.slice(0, 7));
    const fallback = vi.fn(firstLegal);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options(fallback));

    expect(state.turn).toBe('WHITE');
    expect(jevMoveId(decision.move!)).toBe('p_3_3');
    expect(legalMoves(state, DEFAULT_CONFIG).map(jevMoveId)).toContain(jevMoveId(decision.move!));
    expect(decision.source).toBe('guard-pressure');
    expect(fallback).not.toHaveBeenCalled();
    expect(decision.stats).toMatchObject({
      version: 'jev-guard-pressure-v2',
      scope: JEV_GUARD_PRESSURE_SCOPE,
      complete: true,
      stopReason: 'complete',
      selected: {
        id: 'p_3_3',
        actionCreatesCaptureThreat: true,
        forwardSafeKingEscapes: 0,
        immediateWinningResponses: 0,
        safeCounterCaptures: 0,
        preservesBoardAnchors: true,
        eligible: true,
      },
    });
    expect(decision.stats.nodes).toBeLessThanOrEqual(128);
    const movedAnchor = decision.stats.pressureCandidates
      .find((candidate) => candidate.id === 'm_3_4_3_3');
    expect(movedAnchor).toMatchObject({
      actionCreatesCaptureThreat: true,
      forwardSafeKingEscapes: 0,
      safeResponses: 5,
      preservesBoardAnchors: false,
      eligible: true,
    });
    expect(decision.stats.selected!.safeResponses).toBe(4);
  });

  it('selects the rotated BLACK deployment with the same color-independent policy', () => {
    const original = reachableState(fixture.moves.slice(0, 7));
    const state = rotatedAndSwapped(original);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options());

    expect(state.turn).toBe('BLACK');
    expect(jevMoveId(decision.move!)).toBe('p_5_5');
    expect(decision).toMatchObject({
      source: 'guard-pressure',
      stats: {
        complete: true,
        selected: {
          id: 'p_5_5',
          actionCreatesCaptureThreat: true,
          forwardSafeKingEscapes: 0,
          preservesBoardAnchors: true,
        },
      },
    });
  });

  it('takes an actual terminal win before any pressure preference or fallback', () => {
    const board: GameState['board'] = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
    board[7]![4] = { player: 'WHITE', type: 'KING' };
    board[4]![3] = { player: 'BLACK', type: 'KING' };
    board[3]![4] = { player: 'WHITE', type: 'GUARD' };
    const state: GameState = {
      board,
      turn: 'WHITE',
      guardsInHand: { BLACK: 0, WHITE: 1 },
      history: [],
      positionCounts: {},
    };
    const fallback = vi.fn(firstLegal);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options(fallback));

    expect(decision.source).toBe('immediate-win');
    expect(jevMoveId(decision.move!)).toBe('m_7_4_8_4');
    expect(getResult(applyMove(state, decision.move!), DEFAULT_CONFIG)).toEqual({
      winner: 'WHITE', reason: 'goal',
    });
    expect(decision.stats.immediateWins).toContain('m_7_4_8_4');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects pressure that permits an immediate king capture and uses the supplied fallback', () => {
    const state = reachableState(fixture.moves.slice(0, 7));
    state.board[2]![3] = { player: 'BLACK', type: 'GUARD' };
    const fallbackMove = canonicalMove(state, 'm_2_4_1_4');
    const fallback = vi.fn<JevGuardPressureFallback>((_state, _config, supplied) => {
      supplied.onSearchComplete?.({
        nodes: supplied.maxNodes ?? 0,
        completedDepth: 1,
        elapsedMs: 0.1,
        aborted: false,
      });
      return fallbackMove;
    });
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options(fallback));

    expect(jevMoveId(decision.move!)).toBe('m_2_4_1_4');
    expect(decision.source).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
    const pressure = decision.stats.pressureCandidates.find((candidate) => candidate.id === 'p_3_3');
    expect(pressure).toMatchObject({
      actionCreatesCaptureThreat: true,
      immediateWinningResponses: 1,
      eligible: false,
    });
    expect(decision.stats.fallback).toMatchObject({ called: true, search: { completedDepth: 1 } });
  });

  it('rejects a pressure guard that has a safe immediate countercapture', () => {
    const board: GameState['board'] = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
    board[2]![4] = { player: 'WHITE', type: 'KING' };
    board[4]![3] = { player: 'BLACK', type: 'KING' };
    board[3]![4] = { player: 'WHITE', type: 'GUARD' };
    board[3]![2] = { player: 'BLACK', type: 'GUARD' };
    const state: GameState = {
      board,
      turn: 'WHITE',
      guardsInHand: { BLACK: 0, WHITE: 0 },
      history: [],
      positionCounts: {},
    };
    const fallbackMove = canonicalMove(state, 'm_2_4_1_4');
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, options(() => fallbackMove));

    expect(jevMoveId(decision.move!)).not.toBe('m_3_4_3_3');
    const countercapturable = decision.stats.pressureCandidates.find((candidate) => (
      candidate.id === 'm_3_4_3_3'
    ));
    expect(countercapturable).toMatchObject({
      actionCreatesCaptureThreat: true,
      safeCounterCaptures: 1,
      eligible: false,
    });
    expect(decision.stats.selected?.id).not.toBe(countercapturable?.id);
  });

  it('uses a bounded deterministic fallback when no direct guard pressure exists', () => {
    const state = initialState(DEFAULT_CONFIG);
    const fallback = vi.fn(firstLegal);
    const deadlineMs = Date.now() + 1_000;
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      deadlineMs,
      maxNodes: 128,
      fallback,
    });

    expect(decision.source).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
    const supplied = fallback.mock.calls[0]![2];
    expect(supplied).toMatchObject({
      maxDepth: 3,
      choiceWindow: 0,
      botSide: 'BLACK',
    });
    expect(supplied.maxMs).toBeGreaterThan(0);
    expect(supplied.maxMs).toBeLessThanOrEqual(30);
    expect(supplied.maxNodes).toBeGreaterThan(0);
    expect(supplied.maxNodes).toBeLessThan(128);
    expect(supplied.rng).toBeUndefined();
    expect(decision.stats.scope).toBe(JEV_GUARD_PRESSURE_SCOPE);
  });

  it('clamps delegated fallback search to 128 nodes with a 2,048-transition budget', () => {
    const state = initialState(DEFAULT_CONFIG);
    let delegatedMaxNodes: number | undefined;
    const fallback: JevGuardPressureFallback = (position, config, supplied) => {
      delegatedMaxNodes = Math.min(128, supplied.maxNodes ?? 128);
      return firstLegal(position, config, { ...supplied, maxNodes: delegatedMaxNodes });
    };
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      deadlineMs: Date.now() + 1_000,
      maxNodes: 2_048,
      fallback,
    });

    expect(decision.source).toBe('fallback');
    expect(decision.stats.limits.maxNodes).toBe(2_048);
    expect(decision.stats.fallback.maxNodes).toBe(128);
    expect(delegatedMaxNodes).toBe(128);
  });

  it.each([
    ['node-budget', { maxNodes: 1 }],
    ['deadline', { deadlineMs: Date.now() - 1 }],
    ['aborted', { signal: AbortSignal.abort() }],
  ] as const)('returns no partial policy choice when stopped by %s', (reason, override) => {
    const state = reachableState(fixture.moves.slice(0, 7));
    const fallback = vi.fn(firstLegal);
    const decision = chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(fallback),
      ...override,
    });

    expect(decision).toMatchObject({
      move: null,
      source: 'interrupted',
      stats: { complete: false, stopReason: reason },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects terminal input, invalid bounds, and a non-canonical fallback move', () => {
    const state = initialState(DEFAULT_CONFIG);
    const terminal = structuredClone(state);
    terminal.board[8]![4] = null;

    expect(() => chooseJevGuardPressureMove(terminal, DEFAULT_CONFIG, options())).toThrow('terminal');
    expect(() => chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(), maxNodes: 0,
    })).toThrow('maxNodes');
    expect(() => chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(), maxNodes: JEV_GUARD_PRESSURE_LIMITS.maxNodes + 1,
    })).toThrow('maxNodes');
    expect(() => chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(), deadlineMs: Number.POSITIVE_INFINITY,
    })).toThrow('deadlineMs');
    expect(() => chooseJevGuardPressureMove(state, DEFAULT_CONFIG, {
      ...options(), fallback: () => ({ kind: 'PLACE', to: { r: -1, c: -1 } }),
    })).toThrow('canonical legal move');
  });
});
