import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { analyzeJevInitiative, type JevInitiativeCandidate } from './jevInitiative';
import { jevMoveId } from './jevPolicy';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/jev-first-loss.json', import.meta.url), 'utf8'),
) as { moves: Move[] };

const options = () => ({ deadlineMs: Date.now() + 5_000, maxNodes: 20_000 });

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

function verifyCandidate(state: GameState, root: Move, candidate: JevInitiativeCandidate): void {
  const self = state.turn;
  const enemy = opponent(self);
  const after = applyMove(state, root);
  const hypotheticalSelfTurn = { ...after, turn: self };
  const hypotheticalMoves = legalMoves(hypotheticalSelfTurn, DEFAULT_CONFIG).map(jevMoveId);
  for (const capture of candidate.captureThreatsIfUnanswered) {
    expect(hypotheticalMoves).toContain(jevMoveId(capture));
    expect(getResult(applyMove(hypotheticalSelfTurn, capture), DEFAULT_CONFIG)?.winner).toBe(self);
  }
  const responses = legalMoves(after, DEFAULT_CONFIG);
  expect(candidate.checkedResponses).toBeLessThanOrEqual(candidate.totalResponses);
  expect(candidate.totalResponses).toBe(responses.length);

  const expectedSafe: JevInitiativeCandidate['safeResponses'] = [];
  for (const response of responses.slice(0, candidate.checkedResponses)) {
    const responded = applyMove(after, response);
    const responseResult = getResult(responded, DEFAULT_CONFIG);
    const safe = responseResult?.winner === enemy || (!responseResult && legalMoves(responded, DEFAULT_CONFIG)
      .every((counter) => getResult(applyMove(responded, counter), DEFAULT_CONFIG)?.winner !== self));
    if (!safe) continue;
    const isKing = response.kind === 'MOVE'
      && after.board[response.from.r]?.[response.from.c]?.type === 'KING';
    expectedSafe.push({
      move: response,
      action: isKing ? 'king' : 'guard',
      advancesRow: isKing && response.kind === 'MOVE'
        && (enemy === 'BLACK' ? response.to.r < response.from.r : response.to.r > response.from.r),
      immediateWin: responseResult?.winner === enemy,
    });
  }
  expect(candidate.safeResponses).toEqual(expectedSafe);
}

describe('analyzeJevInitiative', () => {
  it('reports the recorded WHITE deployment threat against the BLACK king without a long-term claim', () => {
    const state = reachableState(fixture.moves.slice(0, 7));
    expect(state.turn).toBe('WHITE');
    const threat = canonicalMove(state, 'p_3_3');
    const quiet = canonicalMove(state, 'm_2_4_1_4');
    const analysis = analyzeJevInitiative(state, DEFAULT_CONFIG, [threat, quiet], options());

    expect(analysis).toMatchObject({
      version: 'jev-initiative-v1',
      scope: 'direct-offensive-capture-threat-and-opponent-immediate-safety',
      complete: true,
      stopReason: 'complete',
    });
    expect(analysis.candidates.map((candidate) => candidate.id)).toEqual(['p_3_3', 'm_2_4_1_4']);

    const attacking = analysis.candidates[0]!;
    expect(attacking).toMatchObject({
      complete: true,
      directCaptureThreat: true,
      laterInitiative: 'unknown',
      responsesComplete: true,
      checkedResponses: attacking.totalResponses,
    });
    expect(attacking.captureThreatsIfUnanswered.map(jevMoveId)).toEqual(['m_3_3_4_3']);
    expect(attacking.safeResponses.filter((response) => response.advancesRow)).toHaveLength(0);
    expect(attacking).not.toHaveProperty('forcedWin');
    expect(attacking).not.toHaveProperty('score');
    verifyCandidate(state, threat, attacking);

    const noThreat = analysis.candidates[1]!;
    expect(noThreat).toMatchObject({
      complete: true,
      directCaptureThreat: false,
      laterInitiative: 'unknown',
      captureThreatsIfUnanswered: [],
      checkedResponses: 0,
      totalResponses: 0,
      responsesComplete: true,
      safeResponses: [],
    });
  });

  it('uses BLACK forward orientation when checking a reachable BLACK initiative', () => {
    const sequence: Move[] = [
      { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 4 } },
      { kind: 'MOVE', from: { r: 0, c: 4 }, to: { r: 1, c: 4 } },
      { kind: 'MOVE', from: { r: 7, c: 4 }, to: { r: 6, c: 3 } },
      { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 2, c: 4 } },
      { kind: 'MOVE', from: { r: 6, c: 3 }, to: { r: 5, c: 4 } },
      { kind: 'PLACE', to: { r: 1, c: 4 } },
      { kind: 'MOVE', from: { r: 5, c: 4 }, to: { r: 5, c: 5 } },
      { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 1, c: 3 } },
      { kind: 'MOVE', from: { r: 5, c: 5 }, to: { r: 4, c: 4 } },
      { kind: 'MOVE', from: { r: 1, c: 3 }, to: { r: 1, c: 2 } },
    ];
    const state = reachableState(sequence);
    expect(state.turn).toBe('BLACK');
    const root = canonicalMove(state, 'p_3_4');
    const candidate = analyzeJevInitiative(state, DEFAULT_CONFIG, [root], options()).candidates[0]!;

    expect(candidate.directCaptureThreat).toBe(true);
    expect(candidate.captureThreatsIfUnanswered.map(jevMoveId)).toEqual(['m_3_4_2_4']);
    for (const response of candidate.safeResponses.filter((item) => item.action === 'king')) {
      expect(response.advancesRow).toBe(
        response.move.kind === 'MOVE' && response.move.to.r > response.move.from.r,
      );
    }
    verifyCandidate(state, root, candidate);
  });

  it('treats an opponent goal win as a safe, immediate winning response', () => {
    const board: GameState['board'] = Array.from({ length: 9 }, () => Array(9).fill(null));
    board[1]![4] = { player: 'BLACK', type: 'KING' };
    board[4]![4] = { player: 'WHITE', type: 'KING' };
    board[2]![3] = { player: 'WHITE', type: 'GUARD' };
    const state: GameState = {
      board,
      turn: 'WHITE',
      guardsInHand: { BLACK: 0, WHITE: 0 },
      history: [],
      positionCounts: {},
    };
    const root = canonicalMove(state, 'm_2_3_1_3');
    const candidate = analyzeJevInitiative(state, DEFAULT_CONFIG, [root], options()).candidates[0]!;
    const goal = candidate.safeResponses.find((response) => jevMoveId(response.move) === 'm_1_4_0_4');

    expect(goal).toMatchObject({ action: 'king', advancesRow: true, immediateWin: true });
    verifyCandidate(state, root, candidate);
  });

  it('keeps an established direct threat but exposes only a checked response prefix at the node bound', () => {
    const state = reachableState(fixture.moves.slice(0, 7));
    const root = canonicalMove(state, 'p_3_3');
    const analysis = analyzeJevInitiative(state, DEFAULT_CONFIG, [root], {
      ...options(),
      maxNodes: 1,
    });

    expect(analysis).toMatchObject({ complete: false, stopReason: 'node-budget', nodes: 1 });
    expect(analysis.candidates[0]).toMatchObject({
      complete: false,
      directCaptureThreat: true,
      checkedResponses: 0,
      responsesComplete: false,
      safeResponses: [],
    });
  });

  it.each([
    ['node-budget', { maxNodes: 0 }],
    ['deadline', { deadlineMs: Date.now() - 1 }],
    ['aborted', { signal: AbortSignal.abort() }],
  ] as const)('leaves the direct fact unknown when stopped by %s before the root', (reason, override) => {
    const state = reachableState(fixture.moves.slice(0, 7));
    const root = canonicalMove(state, 'p_3_3');
    const analysis = analyzeJevInitiative(state, DEFAULT_CONFIG, [root], { ...options(), ...override });

    expect(analysis).toMatchObject({ complete: false, stopReason: reason, nodes: 0 });
    expect(analysis.candidates[0]).toMatchObject({
      directCaptureThreat: null,
      captureThreatsIfUnanswered: [],
      checkedResponses: 0,
      responsesComplete: false,
      safeResponses: [],
    });
  });

  it('rejects invalid bounds, empty input, illegal roots, duplicates, and terminal states', () => {
    const state = reachableState(fixture.moves.slice(0, 7));
    const root = canonicalMove(state, 'p_3_3');
    const invalidOptions = [
      { ...options(), deadlineMs: Number.POSITIVE_INFINITY },
      { ...options(), maxNodes: -1 },
      { ...options(), maxNodes: 1.5 },
    ];
    for (const invalid of invalidOptions) {
      expect(() => analyzeJevInitiative(state, DEFAULT_CONFIG, [root], invalid)).toThrow();
    }
    expect(() => analyzeJevInitiative(state, DEFAULT_CONFIG, [], options())).toThrow();
    expect(() => analyzeJevInitiative(
      state, DEFAULT_CONFIG, [{ kind: 'PLACE', to: { r: -1, c: 0 } }], options(),
    )).toThrow();
    expect(() => analyzeJevInitiative(state, DEFAULT_CONFIG, [root, root], options())).toThrow();

    const terminalBoard: GameState['board'] = Array.from({ length: 9 }, () => Array(9).fill(null));
    terminalBoard[0]![4] = { player: 'BLACK', type: 'KING' };
    terminalBoard[4]![4] = { player: 'WHITE', type: 'KING' };
    const terminal: GameState = {
      board: terminalBoard,
      turn: 'WHITE',
      guardsInHand: { BLACK: 0, WHITE: 0 },
      history: [],
      positionCounts: {},
    };
    expect(() => analyzeJevInitiative(terminal, DEFAULT_CONFIG, [root], options())).toThrow();
  });
});
