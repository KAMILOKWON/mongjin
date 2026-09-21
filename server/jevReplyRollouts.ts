import { chooseMove } from '../src/ai/ai';
import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import { JevError } from './jev';
import { jevMoveId } from './jevPolicy';
import type { JevRolloutAnalysis, JevRolloutDecision, JevRolloutOptions, JevRolloutScenario } from './jevRollouts';

export const JEV_REPLY_ROLLOUT_VERSION = 'jev-rollouts-v4' as const;
export const JEV_REPLY_ROLLOUT_LIMITS = { maxPlies: 8, maxNodes: 64, maxMs: 4, maxDepth: 3 } as const;

export function replyHorizon(state: GameState, self: Player, terminal = false): NonNullable<JevRolloutScenario['horizon']> {
  const guards = (side: Player) => state.board.flatMap((row, r) => row.flatMap((piece, c) =>
    piece?.player === side && piece.type === 'GUARD' ? [{ r, c }] : []));
  return { nextPlayer: terminal ? null : state.turn, selfReserve: state.guardsInHand[self], opponentReserve: state.guardsInHand[opponent(self)], selfKing: findKing(state, self), opponentKing: findKing(state, opponent(self)),
    selfGuards: guards(self), opponentGuards: guards(opponent(self)) };
}

export function replySearchSummary(decisions: JevRolloutDecision[]) {
  const searches = decisions.flatMap(d => d.search ? [d.search] : []);
  return { decisions: decisions.length, totalNodes: searches.reduce((n, s) => n + s.nodes, 0),
    minCompletedDepth: searches.length ? Math.min(...searches.map(s => s.completedDepth)) : null,
    maxCompletedDepth: searches.length ? Math.max(...searches.map(s => s.completedDepth)) : null,
    abortedSearches: searches.filter(s => s.aborted).length,
    nodeBudgetCutoffs: decisions.filter(d => d.cutoff === 'node-budget').length,
    timeBudgetCutoffs: decisions.filter(d => d.cutoff === 'time-budget').length };
}

/** All legal first replies, then complete whole breadth rounds.
 * 4ms is a requested search target, not synchronous preemption; the absolute
 * stage deadline is checked after every decision. A partially
 * computed round is discarded, so faster, optimistic branches never receive a
 * longer displayed horizon. These fixed-policy continuations are not proofs. */
export function analyzeJevReplyRollouts(state: GameState, config: RuleConfig, moves: Move[], options: JevRolloutOptions): JevRolloutAnalysis {
  const maxPlies = options.maxPlies ?? JEV_REPLY_ROLLOUT_LIMITS.maxPlies;
  const maxNodes = options.maxNodesPerDecision ?? JEV_REPLY_ROLLOUT_LIMITS.maxNodes;
  if (!Number.isFinite(options.deadlineMs) || !Number.isSafeInteger(maxPlies) || maxPlies < 2 || maxPlies > 8
    || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 64 || !moves.length || getResult(state, config)) {
    throw new Error('Invalid all-reply continuation options');
  }
  const interrupted = () => options.signal?.aborted ? 'aborted' as const
    : Date.now() >= options.deadlineMs ? 'deadline' as const : null;
  const rootMoves = new Map(legalMoves(state, config).map(m => [jevMoveId(m), m]));
  const ids = moves.map(jevMoveId);
  if (new Set(ids).size !== ids.length || ids.some(id => !rootMoves.has(id))) throw new Error('Invalid all-reply roots');
  const scheduled: { output: JevRolloutScenario; state: GameState }[] = [];
  const candidates = ids.map(id => {
    const move = rootMoves.get(id)!;
    const after = applyMove(state, move);
    const replies: (Move | null)[] = getResult(after, config) ? [null]
      : legalMoves(after, config).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
    const scenarios = replies.map(reply => {
      const stop = interrupted();
      if (stop) throw new JevError(stop === 'aborted' ? 'aborted' : 'timeout', 'First-reply enumeration interrupted');
      const position = reply ? applyMove(after, reply) : after;
      const terminal = getResult(position, config);
      const line = reply ? [move, reply] : [move];
      const output: JevRolloutScenario = {
        id: `${id}:reply:${reply ? jevMoveId(reply) : 'terminal'}`, opponentPolicyId: 'opponent-tactical',
        forcedReply: reply, line, plies: line.length, status: terminal ? 'terminal' : 'ply-cap', terminal,
        decisions: [], searchSummary: replySearchSummary([]), policyCutoff: null,
      };
      scheduled.push({ output, state: position });
      return output;
    });
    return { id, move, commonCompletedPlies: Math.min(...scenarios.map(s => s.plies)), scenarios };
  });
  let commonDepth = Math.max(...scheduled.map(s => s.output.plies));
  let stopReason: JevRolloutAnalysis['stopReason'] = 'complete';
  const chooser = options.choose ?? chooseMove;
  while (commonDepth < maxPlies && scheduled.some(s => !s.output.terminal)) {
    const pending: { item: typeof scheduled[number]; next: GameState; decision: JevRolloutDecision }[] = [];
    for (const item of scheduled) {
      if (item.output.terminal) continue;
      const halt = interrupted();
      if (halt) { stopReason = halt; break; }
      const now = Date.now();
      const maxMs = Math.min(JEV_REPLY_ROLLOUT_LIMITS.maxMs, options.deadlineMs - now);
      let search: JevRolloutDecision['search'] = null;
      const selected = chooser(structuredClone(item.state), config, {
        maxMs, maxDepth: 3, maxNodes, choiceWindow: 0, planStrength: 1, strategyLevel: 3,
        elite: true, botSide: item.state.turn, onSearchComplete: value => { search = value; },
      });
      const canonical = selected && legalMoves(item.state, config).find(m => jevMoveId(m) === jevMoveId(selected));
      if (!canonical) throw new Error('Continuation returned an illegal move');
      const actualSearch = search as JevRolloutDecision['search'];
      if (!actualSearch && !options.choose) throw new Error('Missing continuation search record');
      const decision: JevRolloutDecision = {
        linePly: item.output.line.length, player: item.state.turn,
        policyId: item.state.turn === state.turn ? 'self-tactical' : 'opponent-tactical',
        move: canonical, applied: true, budget: { deadlineMs: now + maxMs, maxMs, maxDepth: 3, maxNodes },
        search: actualSearch, cutoff: !actualSearch?.aborted ? null : actualSearch.nodes >= maxNodes ? 'node-budget' : 'time-budget',
        pressure: null,
      };
      pending.push({ item, next: applyMove(item.state, canonical), decision });
      const after = interrupted();
      if (after) { stopReason = after; break; }
    }
    if (stopReason !== 'complete') break;
    for (const { item, next, decision } of pending) {
      item.state = next;
      item.output.line.push(decision.move);
      item.output.decisions.push(decision);
      item.output.terminal = getResult(next, config);
    }
    commonDepth++;
  }
  for (const item of scheduled) {
    const s = item.output;
    s.plies = s.line.length;
    s.status = s.terminal ? 'terminal' : stopReason === 'complete' ? 'ply-cap' : stopReason;
    s.searchSummary = replySearchSummary(s.decisions);
    s.horizon = replyHorizon(item.state, state.turn, !!s.terminal);
  }
  for (const c of candidates) c.commonCompletedPlies = Math.min(...c.scenarios.map(s => s.plies));
  return {
    version: JEV_REPLY_ROLLOUT_VERSION, scope: 'conditional-policy-continuations-not-proofs',
    decisionTimeMeaning: 'requested-search-target-not-hard-preemption',
    firstReplyCoverage: 'all-legal', rootPlayer: state.turn, complete: stopReason === 'complete',
    incomplete: stopReason !== 'complete', stopReason, commonCompletedPlies: commonDepth,
    limits: { deadlineMs: options.deadlineMs, maxPlies, maxNodesPerDecision: maxNodes, maxDepth: 3,
      maxMsPerDecision: 4, scenarioCount: scheduled.length },
    policyDefinitions: (['self-tactical', 'opponent-tactical'] as const).map((id, i) => ({
      id, role: i === 0 ? 'self' : 'opponent', options: {
        method: 'choose-move', maxDepth: 3, maxNodes, maxMsPerDecision: 4, choiceWindow: 0,
        planStrength: 1, strategyLevel: 3, elite: true, rng: 'disabled', botSide: 'current-turn', pressureTransitionBudget: null,
      },
    })), candidates,
  };
}
