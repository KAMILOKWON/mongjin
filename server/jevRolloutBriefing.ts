import type { Player } from '../src/core/types';
import type { JevRolloutAnalysis, JevRolloutScenario } from './jevRollouts';
import { jevMoveId } from './jevPolicy';

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
  if (analysis.version === 'jev-rollouts-v4') {
    const cell = (p: { r: number; c: number } | null | undefined) => p ? `${p.r},${p.c}` : null;
    return {
      scope: analysis.scope, meaning: `${meaning} Every legal first OPPONENT reply is explicitly branched. Later moves follow one shallow tactical policy. Nonterminal branches all stop at the SAME horizon. Branch counts are not probabilities; one credible adverse branch matters even if many other branches look favorable. No continuation is allowed to receive extra displayed depth merely because it computes faster.`,
      firstReplyCoverage: analysis.firstReplyCoverage, commonCompletedPlies: analysis.commonCompletedPlies,
      complete: analysis.complete, stopReason: analysis.stopReason, limits: analysis.limits, decisionTimeMeaning: analysis.decisionTimeMeaning,
      replyColumns: ['firstOpponentReply', 'conditionalOutcome', 'selfKingRowColumn', 'opponentKingRowColumn', 'selfGuardCells', 'opponentGuardCells', 'selfReserve', 'opponentReserve', 'nextPlayer', 'searchCutoffs'],
      candidates: analysis.candidates.map(c => ({ id: c.id, replies: c.scenarios.map(s => [
        s.forcedReply ? jevMoveId(s.forcedReply) : null,
        s.terminal ? `${s.terminal.winner === self ? 'SELF-won' : 'OPPONENT-won'}:${s.terminal.reason}` : 'unknown',
        cell(s.horizon?.selfKing), cell(s.horizon?.opponentKing),
        s.horizon?.selfGuards.map(cell), s.horizon?.opponentGuards.map(cell), s.horizon?.selfReserve, s.horizon?.opponentReserve, s.horizon?.nextPlayer, s.searchSummary.abortedSearches,
      ]), adverseLineExamples: c.scenarios.filter(s => s.terminal && s.terminal.winner !== self).slice(0, 2).map(s => ({ firstReply: s.forcedReply ? jevMoveId(s.forcedReply) : null, moves: s.line.map(jevMoveId) })) })),
    };
  }
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
  if (analysis.version === 'jev-rollouts-v4') {
    const losses = candidate.scenarios.filter(s => s.terminal && s.terminal.winner !== self);
    return `All ${candidate.scenarios.length} legal first opponent replies are branched, with a common ${analysis.commonCompletedPlies}-ply horizon including this move (earlier terminals stop immediately). Every branch follows one shallow policy for later moves; even a displayed terminal is conditional, not a proof. Favorable branch totals are deliberately not used to rank actions. Compare adverse reply lines and the king/guard horizon positions; do not choose by counting favorable branches. ${losses.length ? `Adverse first replies include ${losses.slice(0, 3).map(s => s.forcedReply ? jevMoveId(s.forcedReply) : 'terminal').join(', ')}.` : 'No displayed loss does not establish safety.'}`;
  }
  const outcomes = candidate.scenarios.map(scenario => {
    const result = scenario.terminal
      ? `${scenario.terminal.winner === self ? 'SELF won' : 'OPPONENT won'} by ${scenario.terminal.reason}`
      : `outcome unknown (${scenario.status})`;
    return `${scenario.opponentPolicyId}: ${result} after ${scenario.plies} simulated plies including this action`;
  });
  return `Conditional continuation examples: ${outcomes.join('; ')}. Both sides use fixed local policies, not future JEV choices; these are not forced outcomes.`;
}
