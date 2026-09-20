import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';
import { analyzeJevCandidates, analyzeJevFacts } from './jevAnalysis';

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
    guardsInHand: { BLACK: 0, WHITE: 0 },
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

function findMove(moves: Move[], expected: Move): Move {
  const serialized = JSON.stringify(expected);
  const found = moves.find((candidate) => JSON.stringify(candidate) === serialized);
  if (!found) throw new Error(`Missing fixture move: ${serialized}`);
  return found;
}

function replayLegal(state: GameState, moves: Move[], config: RuleConfig): GameState {
  let replay = state;
  for (const candidate of moves) {
    expect(legalMoves(replay, config)).toContainEqual(candidate);
    replay = applyMove(replay, candidate);
  }
  return replay;
}

const ORIGINAL_RECORDED_MOVES_THROUGH_PLY_26: Move[] = [
  place([7, 4]),
  move([0, 4], [1, 4]),
  place([6, 4]),
  move([1, 4], [2, 4]),
  place([5, 4]),
  move([2, 4], [3, 3]),
  place([4, 4]),
  move([3, 3], [4, 2]),
  move([6, 4], [6, 3]),
  move([4, 2], [5, 1]),
  move([8, 4], [7, 5]),
  move([5, 1], [6, 1]),
  move([7, 4], [7, 3]),
  place([5, 1]),
  move([7, 5], [6, 5]),
  place([5, 2]),
  move([6, 5], [5, 5]),
  move([6, 1], [7, 1]),
  move([7, 3], [7, 2]),
  move([7, 1], [6, 1]),
  move([5, 5], [4, 5]),
  place([4, 2]),
  move([4, 5], [3, 5]),
  move([5, 1], [4, 1]),
  move([3, 5], [2, 5]),
  place([4, 3]),
];

const RANKED_LOSS_OPENING_THROUGH_PLY_8: Move[] = [
  move([8, 4], [7, 4]),
  move([0, 4], [1, 4]),
  move([7, 4], [6, 4]),
  move([1, 4], [2, 4]),
  move([6, 4], [5, 4]),
  place([3, 4]),
  move([5, 4], [4, 3]),
  move([3, 4], [3, 3]),
];

describe('analyzeJevFacts', () => {
  it('finds an exact immediate goal win across every canonical root move', () => {
    const state = stateWith([
      { r: 1, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 0, c: 0, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const legal = legalMoves(state, smallConfig);
    const winningMove = findMove(legal, move([1, 2], [0, 2]));
    const facts = analyzeJevFacts(state, smallConfig, { deadlineMs: Date.now() + 2_000 });

    expect(facts.candidates.map((candidate) => candidate.move)).toEqual(legal);
    expect(facts.legalMoveCount).toBe(legal.length);
    expect(facts.complete).toBe(true);
    expect(facts.candidates.find((candidate) => JSON.stringify(candidate.move) === JSON.stringify(winningMove))).toMatchObject({
      immediateWin: true,
      immediateLoss: false,
      opponentWinningReplies: [],
      checkedReplies: 0,
      repliesComplete: true,
    });
  });

  it('exhaustively records an opponent immediate winning reply', () => {
    const state = stateWith([
      { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
      { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const candidate = findMove(legalMoves(state, smallConfig), move([4, 0], [3, 0]));
    const facts = analyzeJevFacts(state, smallConfig, { deadlineMs: Date.now() + 2_000 });
    const analyzed = facts.candidates.find((item) => JSON.stringify(item.move) === JSON.stringify(candidate))!;

    expect(analyzed.immediateWin).toBe(false);
    expect(analyzed.immediateLoss).toBe(false);
    expect(analyzed.repliesComplete).toBe(true);
    expect(analyzed.checkedReplies).toBe(legalMoves(applyMove(state, candidate), smallConfig).length);
    expect(analyzed.opponentWinningReplies).toContainEqual(move([3, 2], [4, 2]));
  });

  it('distinguishes an open frozen king path from a fully blocked one', () => {
    const open = stateWith([
      { r: 4, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 0, c: 0, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const barrier = Array.from({ length: 5 }, (_, c) => ({
      r: 2,
      c,
      piece: { player: 'WHITE' as const, type: 'GUARD' as const },
    }));
    const blocked = stateWith([
      { r: 4, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 0, c: 0, piece: { player: 'WHITE', type: 'KING' } },
      ...barrier,
    ]);

    const openFacts = analyzeJevFacts(open, smallConfig, { deadlineMs: Date.now() + 2_000 });
    const blockedFacts = analyzeJevFacts(blocked, smallConfig, { deadlineMs: Date.now() + 2_000 });
    expect(openFacts.initialRoute.own).toMatchObject({ status: 'reachable', distance: 4 });
    expect(blockedFacts.initialRoute.own).toMatchObject({
      status: 'unreachable',
      distance: null,
      reason: 'blocked',
    });
  });

  it('excludes squares attacked by a frozen opposing guard from route examples', () => {
    const state = stateWith([
      { r: 4, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 0, c: 0, piece: { player: 'WHITE', type: 'KING' } },
      { r: 3, c: 1, piece: { player: 'WHITE', type: 'GUARD' } },
    ]);
    const route = analyzeJevFacts(state, smallConfig, {
      deadlineMs: Date.now() + 2_000,
    }).initialRoute.own;
    expect(route.status).toBe('reachable');
    expect(route.firstStepsAreExamples).toBe(true);
    expect(route.firstSteps).not.toContainEqual({ r: 3, c: 2 });
  });

  it('marks expired work unknown instead of reporting unscanned replies as safe', () => {
    const state = stateWith([
      { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
      { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const facts = analyzeJevFacts(state, smallConfig, { deadlineMs: Date.now() - 1 });
    expect(facts.stopReason).toBe('deadline');
    expect(facts.complete).toBe(false);
    expect(facts.analyzedMoves).toBe(0);
    expect(facts.candidates).toHaveLength(legalMoves(state, smallConfig).length);
    for (const candidate of facts.candidates) {
      expect(candidate.immediateWin).toBeNull();
      expect(candidate.immediateLoss).toBeNull();
      expect(candidate.repliesComplete).toBe(false);
      expect(candidate.routes.own.status).toBe('incomplete');
    }
  });
});

describe('analyzeJevCandidates', () => {
  it('proves a losing reply with complete child coverage and returns a legally replayable PV', () => {
    const state = stateWith([
      { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
      { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const candidate = findMove(legalMoves(state, smallConfig), move([4, 0], [3, 0]));
    const analysis = analyzeJevCandidates(state, smallConfig, [candidate], {
      deadlineMs: Date.now() + 2_000,
      maxDepth: 2,
      maxNodes: 20_000,
    });

    expect(analysis.completedDepth).toBe(2);
    expect(analysis.stopReason).toBe('complete');
    expect(analysis.candidates[0]).toMatchObject({
      searchedDepth: 2,
      proven: 'loss',
      proofSearchedDepth: 2,
    });
    expect(analysis.candidates[0]!.proof?.winner).toBe('WHITE');
    const final = replayLegal(state, analysis.candidates[0]!.principalVariation, smallConfig);
    expect(analysis.candidates[0]!.horizonFacts?.terminal).toEqual({ winner: 'WHITE', reason: 'goal' });
    expect(final.history).toHaveLength(analysis.candidates[0]!.principalVariation.length);
  });

  it('commits only a depth shared by every supplied candidate', () => {
    const state = stateWith([
      { r: 3, c: 1, piece: { player: 'BLACK', type: 'KING' } },
      { r: 1, c: 3, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const candidates = legalMoves(state, smallConfig).slice(0, 3);
    const analysis = analyzeJevCandidates(state, smallConfig, candidates, {
      deadlineMs: Date.now() + 2_000,
      maxDepth: 3,
      maxNodes: 50_000,
    });
    expect(analysis.completedDepth).toBe(3);
    expect(analysis.candidates.map((candidate) => candidate.searchedDepth)).toEqual([3, 3, 3]);
    expect(analysis.candidates.map((candidate) => candidate.move)).toEqual(candidates);
  });

  it('promotes an exact selective-extension proof without changing the common searchedDepth', () => {
    const state = stateWith([
      { r: 4, c: 0, piece: { player: 'BLACK', type: 'KING' } },
      { r: 3, c: 2, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const candidate = findMove(legalMoves(state, smallConfig), move([4, 0], [3, 0]));
    const analysis = analyzeJevCandidates(state, smallConfig, [candidate], {
      deadlineMs: Date.now() + 2_000,
      maxDepth: 1,
      maxNodes: 20_000,
    });
    const result = analysis.candidates[0]!;
    expect(analysis.completedDepth).toBe(1);
    expect(result.searchedDepth).toBe(1);
    expect(result.proven).toBe('loss');
    expect(result.extension).toMatchObject({
      searchedDepth: 2,
      completed: true,
      proven: 'loss',
      stopReason: 'complete',
    });
    expect(result.proofSearchedDepth).toBe(2);
    expect(result.principalVariation).toEqual(result.extension!.principalVariation);
  });

  it('discards a partial iteration and leaves every proof unknown when no node is available', () => {
    const state = stateWith([
      { r: 3, c: 1, piece: { player: 'BLACK', type: 'KING' } },
      { r: 1, c: 3, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const candidates = legalMoves(state, smallConfig).slice(0, 2);
    const analysis = analyzeJevCandidates(state, smallConfig, candidates, {
      deadlineMs: Date.now() + 2_000,
      maxDepth: 4,
      maxNodes: 0,
    });
    expect(analysis.completedDepth).toBe(0);
    expect(analysis.nodes).toBe(0);
    expect(analysis.stopReason).toBe('node-budget');
    expect(analysis.candidates.every((candidate) => (
      candidate.proven === 'unknown'
      && candidate.searchedDepth === 0
      && candidate.horizonFacts === null
    ))).toBe(true);
  });

  it('retains a four-ply proof while scores stay at the completed three-ply depth', () => {
    const state = stateWith([
      { r: 3, c: 1, piece: { player: 'WHITE', type: 'GUARD' } },
      { r: 4, c: 3, piece: { player: 'WHITE', type: 'GUARD' } },
      { r: 6, c: 3, piece: { player: 'WHITE', type: 'GUARD' } },
      { r: 6, c: 4, piece: { player: 'WHITE', type: 'KING' } },
      { r: 8, c: 3, piece: { player: 'BLACK', type: 'KING' } },
    ], 'BLACK', DEFAULT_CONFIG);
    state.guardsInHand = { BLACK: 8, WHITE: 5 };
    const legal = legalMoves(state, DEFAULT_CONFIG);
    const candidates = [
      findMove(legal, move([8, 3], [7, 4])),
      findMove(legal, move([8, 3], [7, 3])),
      findMove(legal, place([7, 3])),
      findMove(legal, move([8, 3], [8, 4])),
    ];
    const commonDepthReference = analyzeJevCandidates(state, DEFAULT_CONFIG, candidates, {
      deadlineMs: Date.now() + 5_000,
      maxDepth: 3,
      maxNodes: 3_000,
    });
    const interrupted = analyzeJevCandidates(state, DEFAULT_CONFIG, candidates, {
      deadlineMs: Date.now() + 5_000,
      maxDepth: 4,
      maxNodes: 3_000,
    });

    expect(interrupted.completedDepth).toBe(3);
    expect(interrupted.nodes).toBe(3_000);
    expect(interrupted.stopReason).toBe('node-budget');
    expect(interrupted.candidates.map((candidate) => candidate.score)).toEqual(
      commonDepthReference.candidates.map((candidate) => candidate.score),
    );
    expect(interrupted.candidates.map((candidate) => candidate.searchedDepth)).toEqual([3, 3, 3, 3]);
    expect(interrupted.candidates[0]).toMatchObject({
      proven: 'loss',
      proofSearchedDepth: 4,
      proof: { winner: 'WHITE', plies: 4 },
    });
    replayLegal(state, interrupted.candidates[0]!.principalVariation, DEFAULT_CONFIG);
  });

  it('completes four common plies for four ranked candidates within 3,000 nodes', () => {
    const state = replayLegal(
      initialState(DEFAULT_CONFIG),
      RANKED_LOSS_OPENING_THROUGH_PLY_8,
      DEFAULT_CONFIG,
    );
    const legal = legalMoves(state, DEFAULT_CONFIG);
    const candidates = [
      findMove(legal, move([4, 3], [5, 3])),
      findMove(legal, move([4, 3], [3, 4])),
      findMove(legal, move([4, 3], [3, 2])),
      findMove(legal, move([4, 3], [4, 2])),
    ];
    const analysis = analyzeJevCandidates(state, DEFAULT_CONFIG, candidates, {
      deadlineMs: Date.now() + 5_000,
      maxDepth: 4,
      maxNodes: 3_000,
    });

    expect(analysis.completedDepth).toBe(4);
    expect(analysis.nodes).toBeLessThanOrEqual(3_000);
    expect(analysis.candidates.map((candidate) => candidate.searchedDepth)).toEqual([4, 4, 4, 4]);
    expect(analysis.candidates.map((candidate) => candidate.score)).toEqual([
      0, -999_998, -999_998, 0,
    ]);
    expect(analysis.candidates.map((candidate) => candidate.proven)).toEqual([
      'unknown', 'loss', 'loss', 'unknown',
    ]);
  });

  it('replays the original game through ply 26 inline and recognizes the 23-move pre-ply-26 crisis', () => {
    let state = initialState(DEFAULT_CONFIG);
    for (const recorded of ORIGINAL_RECORDED_MOVES_THROUGH_PLY_26.slice(0, 25)) {
      expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(recorded);
      state = applyMove(state, recorded);
    }
    expect(state.turn).toBe('WHITE');
    const legal = legalMoves(state, DEFAULT_CONFIG);
    expect(legal).toHaveLength(23);
    expect(legal).toContainEqual(ORIGINAL_RECORDED_MOVES_THROUGH_PLY_26[25]);

    const recordedChoice = findMove(legal, ORIGINAL_RECORDED_MOVES_THROUGH_PLY_26[25]!);
    const analysis = analyzeJevCandidates(state, DEFAULT_CONFIG, [recordedChoice], {
      deadlineMs: Date.now() + 5_000,
      maxDepth: 4,
      maxNodes: 100_000,
    });
    expect(analysis.completedDepth).toBe(4);
    expect(analysis.candidates[0]!.proven).toBe('loss');
    replayLegal(state, analysis.candidates[0]!.principalVariation, DEFAULT_CONFIG);

    const afterPly26 = applyMove(state, recordedChoice);
    expect(afterPly26.history).toHaveLength(26);
    expect(afterPly26.turn).toBe('BLACK');
  });
});
