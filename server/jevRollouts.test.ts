import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move, Piece } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import {
  analyzeJevRollouts,
  type JevRolloutAnalysis,
  type JevRolloutChooseMove,
} from './jevRollouts';

const smallConfig: RuleConfig = {
  ...DEFAULT_CONFIG,
  boardSize: 5,
  guardCount: 2,
  goalCells: 'center-1',
};

const firstLoss = JSON.parse(readFileSync(
  new URL('./fixtures/jev-first-loss.json', import.meta.url),
  'utf8',
)) as { moves: Move[] };

function stateWith(entries: { r: number; c: number; piece: Piece }[]): GameState {
  const board = Array.from({ length: smallConfig.boardSize }, () =>
    Array<Piece | null>(smallConfig.boardSize).fill(null));
  for (const entry of entries) board[entry.r]![entry.c] = entry.piece;
  return {
    board,
    turn: 'BLACK',
    guardsInHand: { BLACK: 0, WHITE: 0 },
    history: [],
    positionCounts: {},
  };
}

function replay(root: GameState, analysis: JevRolloutAnalysis, config: RuleConfig = smallConfig): void {
  for (const candidate of analysis.candidates) {
    for (const scenario of candidate.scenarios) {
      expect(jevMoveId(scenario.line[0]!)).toBe(candidate.id);
      let state = root;
      for (const saved of scenario.line) {
        const canonical = legalMoves(state, config)
          .find((move) => jevMoveId(move) === jevMoveId(saved));
        expect(canonical).toBeDefined();
        state = applyMove(state, canonical!);
      }
      expect(getResult(state, config)).toEqual(scenario.terminal);
    }
  }
}

const firstLegal: JevRolloutChooseMove = (state, config, options) => {
  const move = legalMoves(state, config)[0] ?? null;
  options.onSearchComplete?.({
    nodes: Math.min(options.maxNodes ?? 0, 7),
    completedDepth: 1,
    elapsedMs: 0.1,
    aborted: false,
  });
  return move;
};

function recordedState(plies: number): GameState {
  let state = initialState(DEFAULT_CONFIG);
  for (const saved of firstLoss.moves.slice(0, plies)) {
    const move = legalMoves(state, DEFAULT_CONFIG)
      .find((candidate) => jevMoveId(candidate) === jevMoveId(saved));
    expect(move).toBeDefined();
    state = applyMove(state, move!);
  }
  return state;
}

function pressureCutoffFixture(): { state: GameState; config: RuleConfig; root: Move } {
  const boardSize = 25;
  const board = Array.from({ length: boardSize }, () =>
    Array<Piece | null>(boardSize).fill(null));
  board[5]![12] = { player: 'BLACK', type: 'KING' };
  board[1]![1] = { player: 'WHITE', type: 'KING' };
  board[20]![20] = { player: 'BLACK', type: 'GUARD' };
  for (const [r, c] of [[3, 12], [7, 12], [5, 10], [5, 14]]) {
    board[r]![c] = { player: 'WHITE', type: 'GUARD' };
  }
  const config: RuleConfig = {
    ...DEFAULT_CONFIG,
    boardSize,
    guardCount: 625,
    goalCells: 'full-row',
    placement: 'own-half',
    noGuardOnGoal: false,
  };
  const state: GameState = {
    board,
    turn: 'BLACK',
    guardsInHand: { BLACK: 625, WHITE: 625 },
    history: [],
    positionCounts: {},
  };
  const root = legalMoves(state, config).find((move) => (
    move.kind === 'MOVE' && move.from.r === 20 && move.from.c === 20
  ))!;
  return { state, config, root };
}

describe('analyzeJevRollouts', () => {
  it('round-robins both policies with canonical replayable capped lines and full budgets', () => {
    const root = initialState(DEFAULT_CONFIG);
    const snapshot = structuredClone(root);
    const roots = legalMoves(root, DEFAULT_CONFIG).slice(0, 2);
    const choose = vi.fn(firstLegal);
    const deadlineMs = Date.now() + 2_000;
    const analysis = analyzeJevRollouts(root, DEFAULT_CONFIG, roots, {
      deadlineMs,
      maxPlies: 4,
      maxNodesPerDecision: 17,
      choose,
    });

    expect(root).toEqual(snapshot);
    expect(analysis).toMatchObject({
      version: 'jev-rollouts-v3',
      scope: 'conditional-policy-continuations-not-proofs',
      complete: true,
      incomplete: false,
      stopReason: 'complete',
      commonCompletedPlies: 4,
      limits: {
        deadlineMs,
        maxPlies: 4,
        maxNodesPerDecision: 17,
        maxDepth: 3,
        maxMsPerDecision: 30,
        scenarioCount: 4,
      },
    });
    expect(analysis.candidates.map((candidate) => candidate.id)).toEqual(roots.map(jevMoveId));
    expect(analysis.policyDefinitions).toEqual([
      expect.objectContaining({ id: 'self-tactical', role: 'self', options: expect.objectContaining({
        method: 'choose-move', strategyLevel: 3, elite: true, planStrength: 1,
        maxNodes: 17, rng: 'disabled', pressureTransitionBudget: null,
      }) }),
      expect.objectContaining({ id: 'opponent-runner', role: 'opponent', options: expect.objectContaining({
        method: 'choose-move', strategyLevel: 1, elite: false, planStrength: 0,
        maxNodes: 17, rng: 'disabled', pressureTransitionBudget: null,
      }) }),
      expect.objectContaining({ id: 'opponent-guard-pressure', role: 'opponent', options: expect.objectContaining({
        method: 'guard-pressure', strategyLevel: 3, elite: true, planStrength: 1,
        maxNodes: 17, rng: 'disabled', pressureTransitionBudget: {
          version: 'jev-guard-pressure-v2', maxNodes: 2_048, fallbackMaxNodes: 17,
          fallbackMaxDepth: 3, fallbackMaxMs: 30,
        },
      }) }),
    ]);
    for (const candidate of analysis.candidates) {
      expect(candidate.commonCompletedPlies).toBe(4);
      expect(candidate.scenarios.map((scenario) => scenario.opponentPolicyId)).toEqual([
        'opponent-runner', 'opponent-guard-pressure',
      ]);
      for (const scenario of candidate.scenarios) {
        expect(scenario).toMatchObject({ status: 'ply-cap', terminal: null, plies: 4 });
        expect(scenario.searchSummary).toMatchObject({ decisions: 3, totalNodes: 21 });
        for (const decision of scenario.decisions) {
          expect(decision.applied).toBe(true);
          expect(decision.budget).toMatchObject({ maxDepth: 3, maxNodes: 17 });
          expect(decision.budget.maxMs).toBeGreaterThan(0);
          expect(decision.budget.maxMs).toBeLessThanOrEqual(30);
          expect(decision.budget.deadlineMs).toBeLessThanOrEqual(deadlineMs);
          if (decision.policyId === 'opponent-guard-pressure') {
            expect(decision.pressure).toMatchObject({
              version: 'jev-guard-pressure-v2', source: 'fallback',
              stats: {
                maxNodes: 2_048,
                fallback: { called: true, delegatedMaxNodes: 17 },
              },
            });
          }
        }
      }
    }
    for (const [, , options] of choose.mock.calls) {
      expect(options).toMatchObject({ maxDepth: 3, maxNodes: 17, choiceWindow: 0 });
      expect(options.rng).toBeUndefined();
    }
    expect(choose.mock.calls.map(([, , options]) => [
      options.strategyLevel, options.elite, options.planStrength,
    ])).toEqual([
      [1, false, 0], [1, false, 0], [3, true, 1], [3, true, 1],
      [3, true, 1], [3, true, 1], [3, true, 1], [3, true, 1],
      [3, true, 1], [3, true, 1], [1, false, 0], [1, false, 0],
    ]);
    replay(root, analysis, DEFAULT_CONFIG);
  });

  it('records a root terminal result without asking a continuation policy', () => {
    const root = stateWith([
      { r: 1, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 2, c: 0, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const winning = legalMoves(root, smallConfig)
      .find((move) => move.kind === 'MOVE' && move.to.r === 0 && move.to.c === 2)!;
    const choose = vi.fn(firstLegal);
    const analysis = analyzeJevRollouts(root, smallConfig, [winning], {
      deadlineMs: Date.now() + 1_000,
      choose,
    });

    expect(choose).not.toHaveBeenCalled();
    expect(analysis.complete).toBe(true);
    expect(analysis.commonCompletedPlies).toBe(1);
    expect(analysis.limits).toMatchObject({ maxPlies: 40, maxNodesPerDecision: 128 });
    for (const scenario of analysis.candidates[0]!.scenarios) {
      expect(scenario).toMatchObject({
        status: 'terminal',
        terminal: { winner: 'BLACK', reason: 'goal' },
        plies: 1,
      });
    }
    replay(root, analysis);
  });

  it('stops every unfinished scenario at one shared expired deadline', () => {
    const root = initialState(smallConfig);
    const roots = legalMoves(root, smallConfig).slice(0, 2);
    const choose = vi.fn(firstLegal);
    const analysis = analyzeJevRollouts(root, smallConfig, roots, {
      deadlineMs: Date.now() - 1,
      choose,
    });

    expect(choose).not.toHaveBeenCalled();
    expect(analysis).toMatchObject({
      complete: false,
      stopReason: 'deadline',
      commonCompletedPlies: 1,
    });
    expect(analysis.candidates.flatMap((candidate) => candidate.scenarios)
      .every((scenario) => scenario.status === 'deadline' && scenario.line.length === 1)).toBe(true);
  });

  it('checks cancellation after a bounded decision and does not apply its move', () => {
    const root = initialState(smallConfig);
    const controller = new AbortController();
    const choose: JevRolloutChooseMove = (state, config, options) => {
      options.onSearchComplete?.({
        nodes: options.maxNodes ?? 0,
        completedDepth: 0,
        elapsedMs: 0.1,
        aborted: true,
      });
      controller.abort();
      return legalMoves(state, config)[0] ?? null;
    };
    const analysis = analyzeJevRollouts(root, smallConfig, [legalMoves(root, smallConfig)[0]!], {
      deadlineMs: Date.now() + 1_000,
      signal: controller.signal,
      choose,
    });

    expect(analysis).toMatchObject({ complete: false, incomplete: true, stopReason: 'aborted' });
    const scenarios = analysis.candidates[0]!.scenarios;
    expect(scenarios.every((scenario) => scenario.status === 'aborted')).toBe(true);
    expect(scenarios.flatMap((scenario) => scenario.line)).toHaveLength(2);
    expect(scenarios.flatMap((scenario) => scenario.decisions)).toHaveLength(0);
  });

  it('rejects terminal roots, illegal roots, duplicate roots, and unbounded limits', () => {
    const root = initialState(smallConfig);
    const legal = legalMoves(root, smallConfig)[0]!;
    const illegal: Move = { kind: 'PLACE', to: { r: 99, c: 99 } };
    const terminal = stateWith([
      { r: 0, c: 2, piece: { player: 'BLACK', type: 'KING' } },
      { r: 2, c: 0, piece: { player: 'WHITE', type: 'KING' } },
    ]);
    const options = { deadlineMs: Date.now() + 1_000, choose: firstLegal };

    expect(() => analyzeJevRollouts(terminal, smallConfig, [illegal], options)).toThrow('terminal');
    expect(() => analyzeJevRollouts(root, smallConfig, [illegal], options)).toThrow('illegal root');
    expect(() => analyzeJevRollouts(root, smallConfig, [legal, legal], options)).toThrow('unique');
    expect(() => analyzeJevRollouts(root, smallConfig, [legal], {
      ...options, maxPlies: 41,
    })).toThrow('maxPlies');
    expect(() => analyzeJevRollouts(root, smallConfig, [legal], {
      ...options, maxNodesPerDecision: 4_097,
    })).toThrow('maxNodesPerDecision');
  });

  it('runs at least one real canonical chooseMove continuation within the small budget', () => {
    const root = initialState(smallConfig);
    const analysis = analyzeJevRollouts(root, smallConfig, [legalMoves(root, smallConfig)[0]!], {
      deadlineMs: Date.now() + 2_000,
      maxPlies: 2,
      maxNodesPerDecision: 128,
    });

    expect(analysis.complete).toBe(true);
    for (const scenario of analysis.candidates[0]!.scenarios) {
      expect(scenario.status).toBe('ply-cap');
      expect(scenario.line).toHaveLength(2);
      expect(scenario.decisions).toHaveLength(1);
      expect(scenario.decisions[0]!.search).not.toBeNull();
      expect(scenario.decisions[0]!.budget.maxMs).toBeLessThanOrEqual(30);
    }
    replay(root, analysis);
  });

  it('uses the actual guard-pressure policy for the recorded defensive reaction', () => {
    const root = recordedState(6);
    const candidate = legalMoves(root, DEFAULT_CONFIG)
      .find((move) => jevMoveId(move) === jevMoveId(firstLoss.moves[6]!))!;
    const analysis = analyzeJevRollouts(root, DEFAULT_CONFIG, [candidate], {
      deadlineMs: Date.now() + 2_000,
      maxPlies: 2,
      maxNodesPerDecision: 128,
      choose: firstLegal,
    });
    const pressure = analysis.candidates[0]!.scenarios
      .find((scenario) => scenario.opponentPolicyId === 'opponent-guard-pressure')!;

    expect(pressure.line.map(jevMoveId)).toEqual([jevMoveId(candidate), 'p_3_3']);
    expect(pressure).toMatchObject({ status: 'ply-cap', policyCutoff: null });
    expect(pressure.decisions[0]).toMatchObject({
      policyId: 'opponent-guard-pressure',
      applied: true,
      search: null,
      pressure: {
        version: 'jev-guard-pressure-v2',
        source: 'guard-pressure',
        stats: { complete: true, stopReason: 'complete', selectedId: 'p_3_3' },
      },
    });
  });

  it('records an actual pressure node cutoff as unknown without a null decision', () => {
    const { state, config, root } = pressureCutoffFixture();
    const analysis = analyzeJevRollouts(state, config, [root], {
      deadlineMs: Date.now() + 2_000,
      maxPlies: 2,
      maxNodesPerDecision: 128,
      choose: firstLegal,
    });
    const scenarios = analysis.candidates[0]!.scenarios;
    const runner = scenarios.find((scenario) => scenario.opponentPolicyId === 'opponent-runner')!;
    const pressure = scenarios.find(
      (scenario) => scenario.opponentPolicyId === 'opponent-guard-pressure',
    )!;

    expect(analysis).toMatchObject({
      complete: false,
      incomplete: true,
      stopReason: 'policy-cutoff',
      commonCompletedPlies: 1,
    });
    expect(runner.status).toBe('ply-cap');
    expect(pressure).toMatchObject({
      status: 'policy-cutoff',
      terminal: null,
      plies: 1,
      decisions: [],
      policyCutoff: {
        linePly: 1,
        player: 'WHITE',
        policyId: 'opponent-guard-pressure',
        pressure: {
          version: 'jev-guard-pressure-v2',
          source: 'interrupted',
          stats: { complete: false, maxNodes: 2_048 },
        },
      },
    });
    expect(['deadline', 'node-budget']).toContain(
      pressure.policyCutoff!.pressure.stats.stopReason,
    );
    expect(pressure.policyCutoff!.pressure.stats.nodes).toBeLessThanOrEqual(2_048);
    expect(legalMoves(state, config).map(jevMoveId)).toContain(jevMoveId(pressure.line[0]!));
  });
});
