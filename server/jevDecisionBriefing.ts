import type { GameState } from '../src/core/types';
import type { RuleConfig } from '../src/core/config';
import type { JevAnalyzedCandidate, JevStateFacts } from './jevAnalysis';
import type { JevPressureAnalysis } from './jevPressure';
import type { JevRolloutAnalysis } from './jevRollouts';
import type { JevRetainedProof } from './jevParallel';
import { buildJevBriefing, describeJevAction } from './jevBriefing';
import { jevMoveId } from './jevPolicy';

/** Action-centred facts for the final choice. Raw analysis stays in the trace.
 * No aggregate score, recommendation, candidate filtering or move override. */
export function buildJevDecisionBriefing(state: GameState, config: RuleConfig, candidates: JevAnalyzedCandidate[],
  pressure: JevPressureAnalysis, rollouts: JevRolloutAnalysis, proofs: JevRetainedProof[], priorities: unknown[]) {
  const facts = (value: JevStateFacts | null, selfNext: boolean) => {
    if (!value) return null;
    // The game has already ended. Frozen routes and a following race are not
    // applicable; do not repeat those empty estimates alongside an exact result.
    if (value.terminal) return { terminal: value.terminal };
    const route = (r: JevStateFacts['routes']['own'], next: boolean) => ({
      status: r.status, kingMoves: r.distance,
      arrivalPlies: r.status === 'reachable' && r.distance !== null
        ? r.distance === 0 ? 0 : r.distance * 2 - Number(next) : null,
    });
    const own = route(value.routes.own, selfNext); const other = route(value.routes.opponent, !selfNext);
    return { terminal: value.terminal, complete: value.complete,
      totalGuardsIncludingReserve: [value.material.own, value.material.opponent],
      frozenKingMoves: [own.status === 'reachable' ? own.kingMoves : own.status, other.status === 'reachable' ? other.kingMoves : other.status],
      frozenFirstStepExamples: [value.routes.own.firstSteps, value.routes.opponent.firstSteps],
      frozenRaceFirst: own.arrivalPlies === null || other.arrivalPlies === null ? 'unknown'
        : own.arrivalPlies === other.arrivalPlies ? 'same-ply'
          : own.arrivalPlies < other.arrivalPlies ? 'SELF' : 'OPPONENT',
      frozenArrivalPlies: [own.arrivalPlies, other.arrivalPlies] };
  };
  const cards = candidates.map(candidate => {
    const id = jevMoveId(candidate.move);
    const entry = pressure.candidates.find(c => c.id === id);
    const examples = entry?.examples.map(e => {
      const groups = { forwardKing: [] as string[], sidewaysKing: [] as string[], backwardKing: [] as string[], guard: [] as string[] };
      for (const r of e.safeResponses) {
        const group = r.action === 'guard' ? 'guard' : r.advancesRow ? 'forwardKing'
          : r.move.kind === 'MOVE' && r.move.to.r === r.move.from.r ? 'sidewaysKing' : 'backwardKing';
        groups[group].push(jevMoveId(r.move));
      }
      const immediateWins = e.safeResponses.filter(r => r.immediateWin).map(r => jevMoveId(r.move));
      const onlyNonForwardKing = e.responsesComplete && !immediateWins.length && !groups.forwardKing.length
        && !groups.guard.length && groups.sidewaysKing.length + groups.backwardKing.length > 0;
      return { opponentReply: jevMoveId(e.opponentReply), allResponsesChecked: e.responsesComplete,
        checkedResponses: e.checkedResponses, totalResponses: e.totalResponses,
        safeResponseCounts: [groups.forwardKing.length, groups.sidewaysKing.length, groups.backwardKing.length, groups.guard.length],
        safeResponseExamples: [groups.forwardKing, groups.sidewaysKing, groups.backwardKing, groups.guard].map(ids => ids.slice(0, 2)), immediateWins,
        consequence: onlyNonForwardKing ? 'only-sideways-or-backward-king'
          : e.responsesComplete && !e.safeResponses.length ? 'all-responses-lose-next-reply'
          : e.responsesComplete ? 'some-next-reply-safe-responses' : 'incomplete' };
    }) ?? [];
    const retained = proofs.find(p => p.id === id);
    const extension = candidate.extension;
    return { id, action: describeJevAction(state, candidate.move),
      afterAction: facts(candidate.afterFacts, false),
      opponentCapturePressure: { allRepliesChecked: entry?.complete ?? false,
        checkedReplies: entry?.checkedOpponentReplies ?? 0, totalReplies: entry?.totalOpponentReplies ?? null,
        captureThreatReplies: entry?.threatsFound ?? null, examples },
      retainedTerminalProof: retained ? { proven: retained.proven, proof: retained.proof,
        searchedDepth: retained.searchedDepth, sourceSearch: retained.sourceSearch,
        proofLine: retained.principalVariation.map(jevMoveId) } : null,
      search: { completedDepth: candidate.searchedDepth, proven: candidate.proven,
        proof: candidate.proof,
        exampleLine: candidate.principalVariation.map(jevMoveId),
        end: facts(candidate.horizonFacts, candidate.principalVariation.length % 2 === 0),
        extension: extension ? { completed: extension.completed, depth: extension.searchedDepth,
          stopReason: extension.stopReason, reasons: extension.reasons, proven: extension.proven, proof: extension.proof,
          exampleLine: extension.principalVariation.map(jevMoveId),
          end: facts(extension.horizonFacts, extension.principalVariation.length % 2 === 0) } : null },
    };
  });
  // Intern entire horizon states. Unlike dropping columns, this keeps every
  // enumerated reply, resulting piece/reserve position and side to move.
  const horizons: unknown[] = [];
  const horizonIndex = new Map<string, number>();
  const guardSets: (string | null)[][] = [];
  const guardSetIndex = new Map<string, number>();
  const replyIds: string[] = [];
  const cell = (p: { r: number; c: number } | null) => p ? `${p.r},${p.c}` : null;
  const internGuards = (cells: { r: number; c: number }[]) => {
    const values = cells.map(cell); const key = JSON.stringify(values);
    let index = guardSetIndex.get(key);
    if (index === undefined) { index = guardSets.length; guardSetIndex.set(key, index); guardSets.push(values); }
    return index;
  };
  const internReply = (id: string | null) => {
    if (id === null) return null;
    let index = replyIds.indexOf(id);
    if (index < 0) { index = replyIds.length; replyIds.push(id); }
    return index;
  };
  const intern = (s: JevRolloutAnalysis['candidates'][number]['scenarios'][number]) => {
    const h = s.horizon;
    if (!h) return null;
    const row = [cell(h.selfKing), cell(h.opponentKing), internGuards(h.selfGuards), internGuards(h.opponentGuards),
      h.selfReserve, h.opponentReserve, h.nextPlayer === null ? null : h.nextPlayer === state.turn ? 'SELF' : 'OPPONENT'];
    const key = JSON.stringify(row);
    let index = horizonIndex.get(key);
    if (index === undefined) { index = horizons.length; horizonIndex.set(key, index); horizons.push(row); }
    return index;
  };
  const continuations = rollouts.candidates.map(c => ({ id: c.id,
    replies: c.scenarios.map(s => [internReply(s.forcedReply ? jevMoveId(s.forcedReply) : null),
      s.terminal ? `${s.terminal.winner === state.turn ? 'SELF' : 'OPPONENT'} won:${s.terminal.reason}` : 'unknown', intern(s)]),
    adverseLines: c.scenarios.filter(s => s.terminal && s.terminal.winner !== state.turn).slice(0, 2).map(s => s.line.map(jevMoveId)),
  }));
  const criteria = Object.fromEntries(cards.map(c => {
    const traps = c.opponentCapturePressure.examples.filter(e => ['only-sideways-or-backward-king', 'all-responses-lose-next-reply'].includes(e.consequence));
    const warning = traps.slice(0, 1).map(e => `After ${e.opponentReply}: ${e.consequence === 'only-sideways-or-backward-king'
      ? 'only sideways/backward king responses avoid the following immediate loss; no safe forward king or guard response'
      : 'every SELF response loses by the following opponent turn'}.`).join(' ');
    const clear = c.opponentCapturePressure.allRepliesChecked && c.opponentCapturePressure.captureThreatReplies === 0
      ? 'No immediate king-capture threat in any checked first opponent reply; longer threats unknown.' : '';
    return [c.id, `${c.action} ${warning || clear} See decisionCards entry ${c.id}.`];
  }));
  const { decisionGuide: _repeatedGuide, ...board } = buildJevBriefing(state, config);
  return { state: {
    briefingVersion: 'jev-decision-1', board, decisionCards: cards,
    safeResponseColumns: ['forwardKing', 'sidewaysKing', 'backwardKing', 'guard'],
    rolePriorities: { values: priorities, meaning: 'Earlier model estimates, not facts, independent votes, or game win probabilities.' },
    evidenceMeaning: {
      pressure: 'Opponent replies are optional possibilities, not forced choices. Counts include every checked safe response; at most two response IDs per group are examples. Response safety checks the following immediate loss only. Sideways and backward are measured from the king AFTER the candidate, not from the original square. Geometric forward movement is not a secured path.',
      search: 'Two-value fact arrays always mean [SELF, OPPONENT]. Frozen first steps are representative examples, NOT every shortest-path first step. Their absence does not prove blockade; unchanged examples do not prove a guard ineffective. A retainedTerminalProof has its own source search, depth and proof line; it remains valid if the latest search is shallower. Exact terminal proofs are distinct from heuristic example lines. Frozen races assume all guards and future deployments remain unchanged. They are estimates, not secured routes.',
      continuations: 'Every legal first opponent reply is branched. Later actions use one shallow fixed policy for BOTH sides, not future JEV decisions. All nonterminal branches stop at the common horizon; earlier terminal branches stop immediately. Even a terminal is conditional, not a forced result. Branch counts are not probabilities. Horizon references index the shared table; no horizon fact is silently discarded.',
    },
    conditionalContinuations: { firstReplyCoverage: rollouts.firstReplyCoverage, commonPlies: rollouts.commonCompletedPlies,
      complete: rollouts.complete, stopReason: rollouts.stopReason,
      replyColumns: ['firstReplyIndex', 'conditionalOutcome', 'horizonIndex'],
      horizonColumns: ['selfKing', 'opponentKing', 'selfGuardSetIndex', 'opponentGuardSetIndex', 'selfReserve', 'opponentReserve', 'nextPlayer'],
      dictionaryMeaning: 'All indexes are zero-based references into replyIds, horizons, or guardSets. Cells use row,column. A null reply means the candidate itself ended the game.',
      horizonDetail: 'lossless-shared-tables', replyIds, guardSets, horizons, candidates: continuations },
  }, questions: { move: { type: 'choice' as const,
    instructions: 'Choose the action that best supports SELF winning against a resisting opponent. Compare decisionCards. Exact terminal proofs take priority. If OPPONENT arrives first in the plain king race, continuing that same race does not catch up: look for blocking, route opening or a forcing capture threat that changes it. Use guardDevelopment to compare the checked effects of guards on opponent forward replies, together with representative route first steps; these counts are not win scores. This is a reason to find concrete counterplay, not to deploy a useless guard. When two nonterminal king moves have the same frozen goal distance, prefer the one that does NOT let a checked opponent reply leave only sideways/backward king responses, unless concrete counterplay justifies accepting that chase. A straight advance is not better than a diagonal advance merely because it is central. Mongjin kings do not attack neighboring squares, so adjacency to the enemy king alone is not danger. Conditional horizons are examples, never promises or votes. Your chosen ID will be played unchanged.',
    criteria } } };
}
