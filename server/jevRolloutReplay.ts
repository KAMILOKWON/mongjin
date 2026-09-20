import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { legalMoves } from '../src/core/rules';
import type { GameState } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import type { JevRolloutAnalysis, JevRolloutPressureMetadata, JevRolloutScenario } from './jevRollouts';

const assert = (condition: unknown): void => { if (!condition) throw new Error('Invalid conditional rollout evidence'); };
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

function verifySearchSummary(scenario: JevRolloutScenario): void {
  const searches = [];
  for (const decision of scenario.decisions) {
    const directPressure = decision.policyId === 'opponent-guard-pressure'
      && decision.pressure?.source !== 'fallback';
    if (directPressure) {
      assert(decision.search === null && decision.cutoff === null);
      continue;
    }
    const search = decision.search;
    if (!search) {
      assert(decision.cutoff === null);
      continue;
    }
    assert(integer(search.nodes, 0, decision.budget.maxNodes)
      && integer(search.completedDepth, 0, decision.budget.maxDepth)
      && Number.isFinite(search.elapsedMs) && search.elapsedMs >= 0
      && typeof search.aborted === 'boolean');
    const expectedCutoff = !search.aborted
      ? null
      : search.nodes >= decision.budget.maxNodes ? 'node-budget' : 'time-budget';
    assert(decision.cutoff === expectedCutoff);
    searches.push(search);
  }

  const summary = scenario.searchSummary;
  const minimum = searches.length
    ? Math.min(...searches.map(search => search.completedDepth))
    : null;
  const maximum = searches.length
    ? Math.max(...searches.map(search => search.completedDepth))
    : null;
  assert(summary && summary.decisions === scenario.decisions.length
    && summary.totalNodes === searches.reduce((total, search) => total + search.nodes, 0)
    && summary.minCompletedDepth === minimum
    && summary.maxCompletedDepth === maximum
    && summary.abortedSearches === searches.filter(search => search.aborted).length
    && summary.nodeBudgetCutoffs === scenario.decisions.filter(decision => decision.cutoff === 'node-budget').length
    && summary.timeBudgetCutoffs === scenario.decisions.filter(decision => decision.cutoff === 'time-budget').length);
}

function verifyPressure(value: JevRolloutPressureMetadata | null, deadline: number, selectedId: string | null, expectedVersion: string): void {
  assert(value && value.version === expectedVersion);
  const { source, stats } = value!;
  assert(['immediate-win', 'guard-pressure', 'fallback', 'interrupted'].includes(source));
  assert(stats && integer(stats.nodes, 0, 2048) && stats.maxNodes === 2048
    && Number.isFinite(stats.deadlineMs) && stats.deadlineMs <= deadline);
  assert(['complete', 'deadline', 'node-budget', 'aborted'].includes(stats.stopReason)
    && stats.complete === (stats.stopReason === 'complete'));
  assert(integer(stats.legalMoves, 1, 10000) && integer(stats.evaluatedAfterstates, 0, stats.legalMoves)
    && integer(stats.pressureCandidates, 0, stats.legalMoves)
    && integer(stats.eligiblePressureCandidates, 0, stats.pressureCandidates));
  assert(selectedId === null ? source === 'interrupted' && !stats.complete : source !== 'interrupted' && stats.complete);
  assert(source === 'guard-pressure' ? stats.selectedId === selectedId : stats.selectedId === null);
  assert(stats.fallback && typeof stats.fallback.called === 'boolean');
  if (stats.fallback.called) {
    assert(source === 'fallback' || source === 'interrupted');
    assert(integer(stats.fallback.requestedMaxNodes, 1, 2048)
      && integer(stats.fallback.delegatedMaxNodes, 1, Math.min(128, stats.fallback.requestedMaxNodes!))
      && Number(stats.fallback.delegatedMaxMs) > 0 && Number(stats.fallback.delegatedMaxMs) <= 30
      && Number(stats.fallback.requestedMaxMs) >= Number(stats.fallback.delegatedMaxMs)
      && Number(stats.fallback.requestedMaxMs) <= 30);
  } else assert(source !== 'fallback' && stats.fallback.search === null);
}

/** Audits recorded legal lines and terminal outcomes. Does not re-run time-limited
 * policies or interpret one conditional line as a full adversarial proof. */
export function verifyJevRolloutEvidence(root: GameState, config: RuleConfig, value: unknown, expectedIds?: string[]): void {
  const data = value as Omit<JevRolloutAnalysis, 'version'> & { version: string };
  assert(data && ['jev-rollouts-v1', 'jev-rollouts-v2', 'jev-rollouts-v3'].includes(data.version) && data.scope === 'conditional-policy-continuations-not-proofs');
  const v2 = data.version !== 'jev-rollouts-v1';
  const pressureVersion = data.version === 'jev-rollouts-v3' ? 'jev-guard-pressure-v2' : 'jev-guard-pressure-v1';
  const policies = ['opponent-runner', v2 ? 'opponent-guard-pressure' : 'opponent-tactical'];
  assert(data.rootPlayer === root.turn && ['complete', 'deadline', 'aborted', ...(v2 ? ['policy-cutoff'] : [])].includes(data.stopReason));
  assert(data.complete === (data.stopReason === 'complete'));
  assert(!v2 && data.incomplete === undefined || data.incomplete === !data.complete);
  assert(data.limits && Number.isFinite(data.limits.deadlineMs)
    && integer(data.limits.maxPlies, 1, 40) && integer(data.limits.maxNodesPerDecision, 1, 4096)
    && data.limits.maxDepth === 3 && data.limits.maxMsPerDecision === 30);
  assert(Array.isArray(data.candidates) && data.candidates.length > 0);
  const rootMoves = new Map(legalMoves(root, config).map(move => [jevMoveId(move), move]));
  assert(data.candidates.length <= rootMoves.size && data.limits.scenarioCount === data.candidates.length * 2);
  const ids = data.candidates.map(candidate => candidate.id);
  assert(new Set(ids).size === ids.length);
  if (expectedIds) assert(JSON.stringify(ids) === JSON.stringify(expectedIds));
  assert(Array.isArray(data.policyDefinitions) && data.policyDefinitions.length === 3);
  const definitions = ['self-tactical', ...policies];
  data.policyDefinitions.forEach((policy, index) => {
    const tactical = policy.id !== 'opponent-runner';
    const pressure = v2 && policy.id === 'opponent-guard-pressure';
    assert(policy.id === definitions[index] && policy.role === (index === 0 ? 'self' : 'opponent'));
    const o = policy.options;
    assert(o.maxNodes === (pressure ? Math.min(128, data.limits.maxNodesPerDecision) : data.limits.maxNodesPerDecision) && o.maxDepth === 3 && o.maxMsPerDecision === 30
      && o.choiceWindow === 0 && o.planStrength === (tactical ? 1 : 0) && o.strategyLevel === (tactical ? 3 : 1)
      && o.elite === tactical && o.rng === 'disabled' && o.botSide === 'current-turn');
    if (v2) {
      assert(o.method === (pressure ? 'guard-pressure' : 'choose-move'));
      if (pressure) assert(o.pressureTransitionBudget?.version === pressureVersion
        && o.pressureTransitionBudget.maxNodes === 2048 && o.pressureTransitionBudget.fallbackMaxNodes === o.maxNodes
        && o.pressureTransitionBudget.fallbackMaxDepth === 3 && o.pressureTransitionBudget.fallbackMaxMs === 30);
      else assert(o.pressureTransitionBudget === null);
    }
  });
  let shortest = Infinity;
  let interrupted = false;
  for (const candidate of data.candidates) {
    assert(rootMoves.has(candidate.id) && jevMoveId(candidate.move) === candidate.id);
    assert(Array.isArray(candidate.scenarios) && candidate.scenarios.length === 2);
    let candidateShortest = Infinity;
    for (let index = 0; index < candidate.scenarios.length; index++) {
      const scenario = candidate.scenarios[index]!;
      assert(scenario.opponentPolicyId === policies[index] && scenario.id === `${candidate.id}:${policies[index]}`);
      assert(Array.isArray(scenario.line) && integer(scenario.line.length, 1, data.limits.maxPlies));
      assert(scenario.plies === scenario.line.length && jevMoveId(scenario.line[0]!) === candidate.id);
      let current = structuredClone(root);
      for (const recorded of scenario.line) {
        assert(!getResult(current, config));
        const canonical = legalMoves(current, config).find(move => jevMoveId(move) === jevMoveId(recorded));
        assert(canonical);
        current = applyMove(current, canonical!);
      }
      const terminal = getResult(current, config);
      assert(['terminal', 'ply-cap', 'deadline', 'aborted', ...(v2 ? ['policy-cutoff'] : [])].includes(scenario.status));
      if (terminal) {
        assert(scenario.status === 'terminal' && scenario.terminal?.winner === terminal.winner && scenario.terminal?.reason === terminal.reason);
      } else {
        assert(scenario.terminal === null && scenario.status !== 'terminal');
        if (scenario.status === 'ply-cap') assert(scenario.plies === data.limits.maxPlies);
        else { interrupted = true; assert(scenario.plies < data.limits.maxPlies && (scenario.status === 'policy-cutoff' || scenario.status === data.stopReason)); }
      }
      assert(Array.isArray(scenario.decisions));
      const applied = scenario.decisions.filter(decision => decision.applied);
      assert(applied.length === scenario.line.length - 1 && scenario.decisions.length - applied.length <= 1);
      let decisionState = applyMove(root, candidate.move);
      for (let j = 0; j < scenario.decisions.length; j++) {
        const decision = scenario.decisions[j]!;
        assert(decision.linePly === j + 1 && decision.player === decisionState.turn);
        assert(decision.policyId === (decisionState.turn === root.turn ? 'self-tactical' : scenario.opponentPolicyId));
        assert(decision.budget && Number.isFinite(decision.budget.deadlineMs)
          && decision.budget.deadlineMs <= data.limits.deadlineMs && decision.budget.maxMs > 0 && decision.budget.maxMs <= 30
          && decision.budget.maxDepth === 3);
        const pressure = v2 && decision.policyId === 'opponent-guard-pressure';
        if (pressure) {
          assert(integer(decision.budget.maxNodes, 1, Math.min(128, data.limits.maxNodesPerDecision)));
          verifyPressure(decision.pressure, decision.budget.deadlineMs, jevMoveId(decision.move), pressureVersion);
          assert(JSON.stringify(decision.search) === JSON.stringify(decision.pressure!.stats.fallback.search));
        } else {
          assert(decision.budget.maxNodes === data.limits.maxNodesPerDecision);
          if (v2) assert(decision.pressure === null);
        }
        const canonical = legalMoves(decisionState, config).find(move => jevMoveId(move) === jevMoveId(decision.move));
        assert(canonical);
        if (decision.applied) {
          assert(jevMoveId(decision.move) === jevMoveId(scenario.line[j + 1]!));
          decisionState = applyMove(decisionState, canonical!);
        } else assert(j === scenario.decisions.length - 1 && ['deadline', 'aborted'].includes(scenario.status));
      }
      if (v2) {
        if (scenario.status === 'policy-cutoff') {
          const cutoff = scenario.policyCutoff;
          assert(cutoff && cutoff.linePly === scenario.line.length && cutoff.player === decisionState.turn
            && cutoff.player !== root.turn && cutoff.policyId === scenario.opponentPolicyId
            && cutoff.policyId === 'opponent-guard-pressure');
          verifyPressure(cutoff!.pressure, data.limits.deadlineMs, null, pressureVersion);
        } else assert(scenario.policyCutoff === null);
      }
      verifySearchSummary(scenario);
      candidateShortest = Math.min(candidateShortest, scenario.plies);
    }
    assert(candidate.commonCompletedPlies === candidateShortest);
    shortest = Math.min(shortest, candidateShortest);
  }
  assert(data.commonCompletedPlies === shortest && data.complete === !interrupted);
}
