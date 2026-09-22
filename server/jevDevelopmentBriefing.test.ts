import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';
import { buildJevDevelopmentBriefing } from './jevDevelopmentBriefing';
import { jevMoveId } from './jevPolicy';

function makeState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  guardsInHand: Record<Player, number> = { BLACK: 8, WHITE: 8 },
  config: RuleConfig = DEFAULT_CONFIG,
): GameState {
  const board: GameState['board'] = Array.from({ length: config.boardSize }, () => (
    Array.from({ length: config.boardSize }, () => null)
  ));
  for (const [r, c, player, type] of pieces) board[r]![c] = { player, type };
  return { board, turn, guardsInHand: { ...guardsInHand }, history: [], positionCounts: {} };
}

function canonical(state: GameState, id: string, config: RuleConfig = DEFAULT_CONFIG): Move {
  const move = legalMoves(state, config).find((candidate) => jevMoveId(candidate) === id);
  expect(move, `${id} must be canonically legal`).toBeDefined();
  return move!;
}

const cells = (items: Array<{ r: number; c: number }>) => items.map(({ r, c }) => `${r},${c}`);

describe('buildJevDevelopmentBriefing', () => {
  it('reports the initial canonical deployment geometry without inventing candidate rows', () => {
    const state = initialState(DEFAULT_CONFIG);
    const briefing = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG);

    expect(briefing.current.self).toEqual({
      player: 'BLACK', king: { r: 8, c: 4 }, deployedGuards: [], reserveGuards: 8,
    });
    expect(cells(briefing.current.deployment.legalCells)).toEqual(['7,4']);
    expect(cells(briefing.current.deployment.kingOnlyCells)).toEqual(['7,4']);
    expect(briefing.current.deployment.guardSupportedCells).toEqual([]);
    expect(briefing.candidates).toEqual([]);
    expect(briefing.semantics.coordinates).toContain('zero-based');
    expect(briefing.semantics.futureTiming).toContain('not a legal same-player extra turn');

    const openGoalConfig = { ...DEFAULT_CONFIG, noGuardOnGoal: false };
    const openGoal = buildJevDevelopmentBriefing(initialState(openGoalConfig), openGoalConfig);
    expect(cells(openGoal.current.deployment.kingOnlyCells)).toEqual(['7,4', '8,3', '8,5']);
  });

  it('shows D6 establishing an anchor and E6 extending BLACK deployment geometry', () => {
    let state = makeState([
      [5, 2, 'BLACK', 'KING'], // C6
      [3, 3, 'WHITE', 'KING'], // D4
    ], 'BLACK');
    const d6 = canonical(state, 'p_5_3');
    const d6Briefing = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG, [d6]);
    const afterD6 = d6Briefing.candidates[0]!.futureSelfTurnDeployment!;

    expect(cells(afterD6.kingIndependentGuardAnchors)).toEqual(['5,3']);
    expect(cells(afterD6.guardSupportedCells)).toEqual(['4,3', '5,4', '6,3']);
    expect(cells(afterD6.newCells)).toEqual(['4,3', '5,4', '6,3']);
    expect(cells(afterD6.lostCells)).toEqual(['5,3']);

    state = applyMove(state, d6);
    state = applyMove(state, canonical(state, 'm_3_3_4_4')); // WHITE king E5
    const e6 = canonical(state, 'p_5_4');
    const e6Briefing = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG, [e6]);
    const afterE6 = e6Briefing.candidates[0]!.futureSelfTurnDeployment!;

    expect(cells(e6Briefing.current.deployment.guardSupportedCells)).toContain('5,4');
    expect(cells(afterE6.kingIndependentGuardAnchors)).toEqual(['5,3', '5,4']);
    expect(cells(afterE6.newCells)).toEqual(['5,5', '6,4']);
    expect(cells(afterE6.lostCells)).toEqual(['5,4']);
    expect(cells(afterE6.legalCells)).not.toContain('4,4');
  });

  it('mirrors the D6/E6 expansion for WHITE', () => {
    let state = makeState([
      [3, 2, 'WHITE', 'KING'],
      [5, 3, 'BLACK', 'KING'],
    ], 'WHITE');
    const d4 = canonical(state, 'p_3_3');
    state = applyMove(state, d4);
    state = applyMove(state, canonical(state, 'm_5_3_4_4'));
    const e4 = canonical(state, 'p_3_4');
    const briefing = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG, [e4]);
    const future = briefing.candidates[0]!.futureSelfTurnDeployment!;

    expect(briefing.selfPlayer).toBe('WHITE');
    expect(cells(future.kingIndependentGuardAnchors)).toEqual(['3,3', '3,4']);
    expect(cells(future.newCells)).toEqual(['2,4', '3,5']);
    expect(cells(future.lostCells)).toEqual(['3,4']);
    expect(cells(future.legalCells)).not.toContain('4,4');
  });

  it('separates guard-supported, king-only and non-adjacent-rule placement cells', () => {
    const adjacent = makeState([
      [4, 4, 'BLACK', 'KING'],
      [4, 6, 'BLACK', 'GUARD'],
      [0, 0, 'WHITE', 'KING'],
    ], 'BLACK');
    const adjacentBriefing = buildJevDevelopmentBriefing(adjacent, DEFAULT_CONFIG);
    expect(cells(adjacentBriefing.current.deployment.guardSupportedCells)).toContain('4,5');
    expect(cells(adjacentBriefing.current.deployment.kingOnlyCells)).not.toContain('4,5');
    expect(adjacentBriefing.current.deployment.ruleOnlyCells).toEqual([]);

    const ownHalfConfig = { ...DEFAULT_CONFIG, placement: 'own-half' as const };
    const ownHalf = buildJevDevelopmentBriefing(initialState(ownHalfConfig), ownHalfConfig);
    expect(ownHalf.current.deployment.guardSupportedCells).toEqual([]);
    expect(ownHalf.current.deployment.kingOnlyCells).toEqual([]);
    expect(ownHalf.current.deployment.ruleOnlyCells).toEqual(ownHalf.current.deployment.legalCells);
    expect(ownHalf.current.deployment.kingIndependentGuardAnchors).toEqual([]);
  });

  it('keeps deployed anchor facts but reports no legal deployment cells with zero reserve', () => {
    const state = makeState([
      [5, 2, 'BLACK', 'KING'],
      [5, 3, 'BLACK', 'GUARD'],
      [3, 3, 'WHITE', 'KING'],
    ], 'BLACK', { BLACK: 0, WHITE: 0 });
    const kingMove = canonical(state, 'm_5_2_4_1');
    const briefing = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG, [kingMove]);
    const future = briefing.candidates[0]!.futureSelfTurnDeployment!;

    expect(cells(briefing.current.deployment.kingIndependentGuardAnchors)).toEqual(['5,3']);
    expect(briefing.current.deployment.legalCells).toEqual([]);
    expect(cells(future.kingIndependentGuardAnchors)).toEqual(['5,3']);
    expect(future.legalCells).toEqual([]);
    expect(future.newCells).toEqual([]);
    expect(future.lostCells).toEqual([]);
  });

  it('does not claim future deployment geometry after a terminal candidate', () => {
    const state = makeState([
      [1, 4, 'BLACK', 'KING'],
      [7, 0, 'WHITE', 'KING'],
    ], 'BLACK', { BLACK: 1, WHITE: 1 });
    const winningMove = canonical(state, 'm_1_4_0_4');
    const candidate = buildJevDevelopmentBriefing(state, DEFAULT_CONFIG, [winningMove]).candidates[0]!;

    expect(candidate.terminal).toEqual({ winner: 'BLACK', reason: 'goal' });
    expect(candidate.futureSelfTurnDeployment).toBeNull();
  });
});
