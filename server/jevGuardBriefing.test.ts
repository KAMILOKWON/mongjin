import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { findKing, initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { briefJevGuardDevelopment } from './jevGuardBriefing';
import { jevMoveId } from './jevPolicy';
import {
  JEV_GUARD_PRESSURE_LIMITS,
  JEV_GUARD_PRESSURE_POLICY_VERSION,
  JEV_GUARD_PRESSURE_RESPONSE_SCOPE,
  JEV_GUARD_PRESSURE_SCOPE,
  type JevGuardPressureCandidateStats,
  type JevGuardPressureDecision,
} from './jevPressurePolicy';

function play(state: GameState, id: string): GameState {
  const move = legalMoves(state, DEFAULT_CONFIG).find((candidate) => jevMoveId(candidate) === id);
  expect(move, `${id} must be canonical and legal`).toBeDefined();
  return applyMove(state, move!);
}

function guardianWhitePly7(): GameState {
  let state = initialState(DEFAULT_CONFIG);
  for (const id of [
    'm_8_4_7_4',
    'm_0_4_1_4',
    'm_7_4_6_4',
    'm_1_4_2_3',
    'm_6_4_5_4',
    'm_2_3_3_3',
    'm_5_4_4_3',
  ]) state = play(state, id);
  return state;
}

function candidate(
  id: string,
  canonicalIndex: number,
  overrides: Partial<JevGuardPressureCandidateStats> = {},
): JevGuardPressureCandidateStats {
  return {
    id,
    canonicalIndex,
    guardAction: true,
    actionCreatesCaptureThreat: false,
    directThreat: false,
    proactiveBlocking: false,
    forwardEscapeReduction: 0,
    complete: true,
    checkedResponses: 0,
    totalResponses: 0,
    safeResponses: 0,
    forwardSafeKingEscapes: 0,
    immediateWinningResponses: 0,
    safeCounterCaptures: 0,
    preservesBoardAnchors: true,
    eligible: false,
    ...overrides,
  };
}

function decisionFixture(params: {
  baselineComplete: boolean;
  baselineSafe: number | null;
  baselinePlayer?: 'BLACK' | 'WHITE';
  candidates: JevGuardPressureCandidateStats[];
  selectedId?: string;
  move?: Move;
}): JevGuardPressureDecision {
  const selected = params.candidates.find((entry) => entry.id === params.selectedId) ?? null;
  const move: Move | null = params.move ?? (selected
    ? { kind: 'PLACE', to: { r: Number(selected.id.split('_')[1]), c: Number(selected.id.split('_')[2]) } }
    : null);
  return {
    move,
    source: selected ? 'guard-pressure' : 'fallback',
    stats: {
      version: JEV_GUARD_PRESSURE_POLICY_VERSION,
      scope: JEV_GUARD_PRESSURE_SCOPE,
      responseScope: JEV_GUARD_PRESSURE_RESPONSE_SCOPE,
      complete: params.baselineComplete && params.candidates.every((entry) => entry.complete),
      stopReason: params.baselineComplete ? 'complete' : 'node-budget',
      nodes: 0,
      elapsedMs: 0,
      limits: {
        requestedDeadlineMs: 1,
        deadlineMs: 1,
        maxNodes: 2_048,
        maxMsPerDecision: JEV_GUARD_PRESSURE_LIMITS.maxMsPerDecision,
        fallbackMaxMs: JEV_GUARD_PRESSURE_LIMITS.fallbackMaxMs,
        fallbackMaxDepth: JEV_GUARD_PRESSURE_LIMITS.fallbackMaxDepth,
      },
      legalMoves: 0,
      evaluatedAfterstates: 0,
      immediateWins: [],
      immediateTerminalLosses: [],
      enemyForwardBaseline: {
        scope: 'before-action-enemy-to-move-counterfactual-not-a-legal-pass',
        player: params.baselinePlayer ?? 'BLACK',
        complete: params.baselineComplete,
        checkedMoves: params.baselineComplete ? params.baselineSafe ?? 0 : 1,
        totalMoves: params.baselineSafe ?? 2,
        safeForwardKingMoves: params.baselineSafe,
      },
      pressureCandidates: params.candidates,
      selected,
      fallback: { called: false, maxMs: null, maxNodes: null, search: null },
    },
  };
}

describe('briefJevGuardDevelopment', () => {
  it('reports the canonical initial no-effect guard without converting fallback choice into advice', () => {
    const state = initialState(DEFAULT_CONFIG);
    expect(legalMoves(state, DEFAULT_CONFIG).map(jevMoveId)).toContain('p_7_4');
    const noEffect = candidate('p_7_4', 0, {
      checkedResponses: 6,
      totalResponses: 6,
      safeResponses: 6,
      forwardSafeKingEscapes: 3,
    });

    const brief = briefJevGuardDevelopment(decisionFixture({
      baselineComplete: true,
      baselineSafe: 3,
      baselinePlayer: 'WHITE',
      candidates: [noEffect],
      move: { kind: 'PLACE', to: { r: 7, c: 4 } },
    }));

    expect(brief.beforeForwardKingReplies).toBe(3);
    expect(brief.actions).toEqual([
      ['p_7_4', true, 6, 6, false, 3, 0, 0],
    ]);
    expect(brief.meaning).toContain('No policy recommendation or combined score is supplied.');
  });

  it('maps the canonical guardian-white ply-7 blocking differences in canonical action order', () => {
    const state = guardianWhitePly7();
    expect(state.turn).toBe('WHITE');
    expect(findKing(state, 'WHITE')).toEqual({ r: 3, c: 3 });
    expect(findKing(state, 'BLACK')).toEqual({ r: 4, c: 3 });
    expect(state.board.flat().filter(Boolean)).toHaveLength(2);
    expect(legalMoves(state, DEFAULT_CONFIG).map(jevMoveId)).toEqual(expect.arrayContaining([
      'p_2_3', 'p_3_2', 'p_3_4',
    ]));

    // Copied from one canonical chooseJevGuardPressureMove run. The pressure
    // policy owns the timed computation; this test keeps the briefing mapping deterministic.
    const unchanged = candidate('p_2_3', 0, {
      checkedResponses: 10, totalResponses: 10, safeResponses: 10,
      forwardSafeKingEscapes: 2,
    });
    const leftBlock = candidate('p_3_2', 1, {
      proactiveBlocking: true, forwardEscapeReduction: 1,
      checkedResponses: 9, totalResponses: 9, safeResponses: 8,
      forwardSafeKingEscapes: 1, eligible: true,
    });
    const rightBlock = candidate('p_3_4', 2, {
      proactiveBlocking: true, forwardEscapeReduction: 1,
      checkedResponses: 9, totalResponses: 9, safeResponses: 8,
      forwardSafeKingEscapes: 1, eligible: true,
    });
    const decision = decisionFixture({
      baselineComplete: true,
      baselineSafe: 2,
      candidates: [unchanged, leftBlock, rightBlock],
      selectedId: 'p_3_2',
    });
    (decision.stats as unknown as Record<string, unknown>).combinedScore = 987654321;
    (decision.stats.selected as unknown as Record<string, unknown>).selectionRank = 1;

    const brief = briefJevGuardDevelopment(decision);

    expect(brief.beforeForwardKingReplies).toBe(2);
    expect(brief.actions).toEqual([
      ['p_2_3', true, 10, 10, false, 2, 0, 0],
      ['p_3_2', true, 9, 9, false, 1, 1, 0],
      ['p_3_4', true, 9, 9, false, 1, 1, 0],
    ]);
    expect(brief.actions.map((row) => row[0])).toEqual(['p_2_3', 'p_3_2', 'p_3_4']);
    expect(brief).not.toHaveProperty('selected');
    expect(brief).not.toHaveProperty('source');
    expect(brief).not.toHaveProperty('move');
    expect(JSON.stringify(brief)).not.toMatch(/987654321|combinedScore|selectionRank/);
  });

  it.each([
    ['incomplete baseline', false, true],
    ['incomplete candidate', true, false],
  ] as const)('hides derived claims for an %s instead of emitting unsafe zeroes', (
    _label,
    baselineComplete,
    candidateComplete,
  ) => {
    const partial = candidate('p_3_4', 0, {
      complete: candidateComplete,
      checkedResponses: 3,
      totalResponses: 9,
      directThreat: true,
      actionCreatesCaptureThreat: true,
      forwardSafeKingEscapes: 0,
      forwardEscapeReduction: 2,
      immediateWinningResponses: 0,
    });
    const brief = briefJevGuardDevelopment(decisionFixture({
      baselineComplete,
      baselineSafe: 2,
      candidates: [partial],
    }));

    expect(brief.beforeForwardKingReplies).toBe(baselineComplete ? 2 : null);
    expect(brief.actions).toEqual([
      ['p_3_4', false, 3, 9, null, null, null, null],
    ]);
  });

  it('uses null and an empty action list when no pressure decision exists', () => {
    const brief = briefJevGuardDevelopment(undefined);
    expect(brief.beforeForwardKingReplies).toBeNull();
    expect(brief.actions).toEqual([]);
    expect(brief.scope).toContain('immediate terminal and next-king-capture checks');
    expect(brief.scope).toContain('not long-term safety');
  });
});
