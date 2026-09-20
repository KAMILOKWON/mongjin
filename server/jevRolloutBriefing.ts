import type { Player } from '../src/core/types';
import type { JevRolloutAnalysis, JevRolloutScenario } from './jevRollouts';

const meaning = 'Conditional legal continuation examples, NOT forced wins/losses or a win probability. BOTH sides follow fixed local policies; future JEV decisions can differ. Incomplete lines have unknown outcomes. Different opponent policies are stress scenarios, not independent votes.';

function summarize(scenario: JevRolloutScenario, self: Player) {
  return {
    opponentPolicy: scenario.opponentPolicyId,
    status: scenario.status,
    outcome: scenario.terminal ? scenario.terminal.winner === self ? 'SELF-won' : 'OPPONENT-won' : 'unknown',
    reason: scenario.terminal?.reason ?? null,
    pliesIncludingCandidate: scenario.plies,
    firstMoves: scenario.line.slice(0, 6),
    lastMoves: scenario.line.length > 6 ? scenario.line.slice(-3) : [],
    searchCutoffs: scenario.searchSummary.abortedSearches,
  };
}

export function briefJevRollouts(analysis: JevRolloutAnalysis, self: Player) {
  return {
    scope: analysis.scope, meaning, complete: analysis.complete, stopReason: analysis.stopReason,
    commonCompletedPlies: analysis.commonCompletedPlies,
    policies: analysis.policyDefinitions, limits: analysis.limits,
    candidates: analysis.candidates.map(candidate => ({
      id: candidate.id,
      scenarios: candidate.scenarios.map(scenario => summarize(scenario, self)),
    })),
  };
}

export function describeJevRollouts(analysis: JevRolloutAnalysis, id: string, self: Player): string {
  const candidate = analysis.candidates.find(candidate => candidate.id === id);
  if (!candidate) return 'Conditional continuation evidence is unavailable.';
  const outcomes = candidate.scenarios.map(scenario => {
    const result = scenario.terminal
      ? `${scenario.terminal.winner === self ? 'SELF won' : 'OPPONENT won'} by ${scenario.terminal.reason}`
      : `outcome unknown (${scenario.status})`;
    return `${scenario.opponentPolicyId}: ${result} after ${scenario.plies} simulated plies including this action`;
  });
  return `Conditional continuation examples: ${outcomes.join('; ')}. Both sides use fixed local policies, not future JEV choices; these are not forced outcomes.`;
}
