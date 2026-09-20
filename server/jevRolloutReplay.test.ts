import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { analyzeJevRollouts, type JevRolloutScenario } from './jevRollouts';
import { verifyJevRolloutEvidence } from './jevRolloutReplay';

function truncateToRoot(scenario: JevRolloutScenario): void {
  scenario.line = scenario.line.slice(0, 1);
  scenario.plies = 1;
  scenario.decisions = [];
  scenario.searchSummary = {
    decisions: 0, totalNodes: 0, minCompletedDepth: null, maxCompletedDepth: null,
    abortedSearches: 0, nodeBudgetCutoffs: 0, timeBudgetCutoffs: 0,
  };
}

function fixture(maxPlies = 1) {
  const state = initialState(DEFAULT_CONFIG);
  const evidence = analyzeJevRollouts(state, DEFAULT_CONFIG, legalMoves(state, DEFAULT_CONFIG).slice(0, 1), {
    deadlineMs: Date.now() + 1000, maxPlies,
  });
  return { state, evidence };
}

describe('conditional rollout evidence versions and unknown outcomes', () => {
  it('retains v2 evidence with the original direct-threat pressure policy', () => {
    const { state, evidence } = fixture();
    const legacy = JSON.parse(JSON.stringify(evidence));
    legacy.version = 'jev-rollouts-v2';
    legacy.policyDefinitions[2].options.pressureTransitionBudget.version = 'jev-guard-pressure-v1';
    expect(() => verifyJevRolloutEvidence(state, DEFAULT_CONFIG, legacy)).not.toThrow();
  });

  it('retains v1 historical legal-line verification', () => {
    const { state, evidence } = fixture();
    const legacy = JSON.parse(JSON.stringify(evidence));
    legacy.version = 'jev-rollouts-v1';
    delete legacy.incomplete;
    legacy.policyDefinitions[2].id = 'opponent-tactical';
    for (const policy of legacy.policyDefinitions) {
      delete policy.options.method;
      delete policy.options.pressureTransitionBudget;
    }
    const scenario = legacy.candidates[0].scenarios[1];
    scenario.opponentPolicyId = 'opponent-tactical';
    scenario.id = `${legacy.candidates[0].id}:opponent-tactical`;
    for (const scenario of legacy.candidates[0].scenarios) delete scenario.policyCutoff;
    expect(() => verifyJevRolloutEvidence(state, DEFAULT_CONFIG, legacy)).not.toThrow();
  });

  it('allows a logged pressure cutoff as unknown, including with a later global deadline', () => {
    const { state, evidence } = fixture(2);
    evidence.complete = false;
    evidence.incomplete = true;
    evidence.stopReason = 'policy-cutoff';
    const scenario = evidence.candidates[0]!.scenarios[1]!;
    truncateToRoot(scenario);
    evidence.commonCompletedPlies = evidence.candidates[0]!.commonCompletedPlies = 1;
    scenario.status = 'policy-cutoff';
    scenario.policyCutoff = {
      linePly: 1, player: 'WHITE', policyId: 'opponent-guard-pressure',
      pressure: {
        version: 'jev-guard-pressure-v2', source: 'interrupted',
        stats: {
          complete: false, stopReason: 'node-budget', nodes: 2048,
          deadlineMs: evidence.limits.deadlineMs, maxNodes: 2048,
          legalMoves: 20, evaluatedAfterstates: 20, pressureCandidates: 4,
          eligiblePressureCandidates: 0, selectedId: null,
          fallback: { called: false, requestedMaxMs: null, requestedMaxNodes: null,
            delegatedMaxMs: null, delegatedMaxNodes: null, search: null },
        },
      },
    };
    expect(() => verifyJevRolloutEvidence(state, DEFAULT_CONFIG, evidence)).not.toThrow();
    evidence.stopReason = 'deadline';
    const runner = evidence.candidates[0]!.scenarios[0]!;
    runner.status = 'deadline';
    truncateToRoot(runner);
    expect(() => verifyJevRolloutEvidence(state, DEFAULT_CONFIG, evidence)).not.toThrow();
    scenario.terminal = { winner: 'WHITE', reason: 'goal' };
    expect(() => verifyJevRolloutEvidence(state, DEFAULT_CONFIG, evidence)).toThrow();
  });
});
