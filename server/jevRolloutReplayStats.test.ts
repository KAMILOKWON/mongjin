import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import { verifyJevRolloutEvidence } from './jevRolloutReplay';
import { analyzeJevRollouts, type JevRolloutChooseMove } from './jevRollouts';

const firstLoss = JSON.parse(readFileSync(
  new URL('./fixtures/jev-first-loss.json', import.meta.url),
  'utf8',
)) as { moves: Move[] };

const firstLegal: JevRolloutChooseMove = (state, config, options) => {
  options.onSearchComplete?.({
    nodes: Math.min(options.maxNodes ?? 0, 7),
    completedDepth: 1,
    elapsedMs: 0.1,
    aborted: false,
  });
  return legalMoves(state, config)[0] ?? null;
};

function recordedState(plies: number): GameState {
  let state = initialState(DEFAULT_CONFIG);
  for (const saved of firstLoss.moves.slice(0, plies)) {
    const move = legalMoves(state, DEFAULT_CONFIG)
      .find(candidate => jevMoveId(candidate) === jevMoveId(saved))!;
    state = applyMove(state, move);
  }
  return state;
}

function analysisAt(root: GameState, candidate: Move) {
  return analyzeJevRollouts(root, DEFAULT_CONFIG, [candidate], {
    deadlineMs: Date.now() + 2_000,
    maxPlies: 2,
    maxNodesPerDecision: 128,
    choose: firstLegal,
  });
}

describe('verifyJevRolloutEvidence search statistics', () => {
  it('accepts recomputable summaries and rejects altered totals or cutoff labels', () => {
    const root = initialState(DEFAULT_CONFIG);
    const candidate = legalMoves(root, DEFAULT_CONFIG)[0]!;
    const analysis = analysisAt(root, candidate);
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, analysis, [jevMoveId(candidate)],
    )).not.toThrow();

    const summary = structuredClone(analysis);
    summary.candidates[0]!.scenarios[0]!.searchSummary.totalNodes += 1;
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, summary, [jevMoveId(candidate)],
    )).toThrow('Invalid conditional rollout evidence');

    const cutoff = structuredClone(analysis);
    const decision = cutoff.candidates[0]!.scenarios[0]!.decisions[0]!;
    decision.cutoff = 'node-budget';
    cutoff.candidates[0]!.scenarios[0]!.searchSummary.nodeBudgetCutoffs = 1;
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, cutoff, [jevMoveId(candidate)],
    )).toThrow('Invalid conditional rollout evidence');
  });

  it('allows omitted search statistics without fabricating a cutoff or summary contribution', () => {
    const root = initialState(DEFAULT_CONFIG);
    const candidate = legalMoves(root, DEFAULT_CONFIG)[0]!;
    const analysis = analysisAt(root, candidate);
    const scenario = analysis.candidates[0]!.scenarios[0]!;
    const decision = scenario.decisions[0]!;
    scenario.searchSummary.totalNodes -= decision.search?.nodes ?? 0;
    scenario.searchSummary.minCompletedDepth = null;
    scenario.searchSummary.maxCompletedDepth = null;
    scenario.searchSummary.abortedSearches = 0;
    decision.search = null;
    decision.cutoff = null;
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, analysis, [jevMoveId(candidate)],
    )).not.toThrow();

    decision.cutoff = 'time-budget';
    scenario.searchSummary.timeBudgetCutoffs = 1;
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, analysis, [jevMoveId(candidate)],
    )).toThrow('Invalid conditional rollout evidence');
  });

  it('rejects fabricated AI search statistics on a direct pressure selection', () => {
    const root = recordedState(6);
    const candidate = legalMoves(root, DEFAULT_CONFIG)
      .find(move => jevMoveId(move) === jevMoveId(firstLoss.moves[6]!))!;
    const analysis = analysisAt(root, candidate);
    const pressure = analysis.candidates[0]!.scenarios
      .find(scenario => scenario.opponentPolicyId === 'opponent-guard-pressure')!;
    expect(pressure.decisions[0]!.pressure?.source).toBe('guard-pressure');
    expect(pressure.decisions[0]!.search).toBeNull();

    const tampered = structuredClone(analysis);
    const decision = tampered.candidates[0]!.scenarios
      .find(scenario => scenario.opponentPolicyId === 'opponent-guard-pressure')!
      .decisions[0]!;
    decision.search = {
      nodes: 1,
      completedDepth: 1,
      elapsedMs: 0.1,
      aborted: false,
    };
    expect(() => verifyJevRolloutEvidence(
      root, DEFAULT_CONFIG, tampered, [jevMoveId(candidate)],
    )).toThrow('Invalid conditional rollout evidence');
  });
});
