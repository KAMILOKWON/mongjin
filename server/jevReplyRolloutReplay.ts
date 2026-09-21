import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { legalMoves } from '../src/core/rules';
import type { GameState } from '../src/core/types';
import { jevMoveId } from './jevPolicy';
import { replyHorizon, replySearchSummary } from './jevReplyRollouts';
import type { JevRolloutAnalysis } from './jevRollouts';

const assert = (value: unknown) => { if (!value) throw new Error('Invalid all-reply continuation evidence'); };
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
const normalized = (v: unknown): unknown => Array.isArray(v) ? v.map(normalized)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalized(x)])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

/** Replays all displayed moves, checks complete first-reply coverage and equal
 * nonterminal horizons. Fixed-policy lines are deliberately not certified as proofs. */
export function verifyJevReplyRollouts(root: GameState, config: RuleConfig, data: JevRolloutAnalysis, expectedIds?: string[]): void {
  assert(data.version === 'jev-rollouts-v4' && data.scope === 'conditional-policy-continuations-not-proofs'
    && data.firstReplyCoverage === 'all-legal' && data.decisionTimeMeaning === 'requested-search-target-not-hard-preemption' && data.rootPlayer === root.turn);
  assert(['complete', 'deadline', 'aborted'].includes(data.stopReason)
    && data.complete === (data.stopReason === 'complete') && data.incomplete === !data.complete);
  const limits = data.limits;
  assert(limits && Number.isFinite(limits.deadlineMs) && integer(limits.maxPlies, 2, 8)
    && integer(limits.maxNodesPerDecision, 1, 64) && limits.maxDepth === 3 && limits.maxMsPerDecision === 4);
  assert(integer(data.commonCompletedPlies, 1, limits.maxPlies));
  const canonical = new Map(legalMoves(root, config).map(m => [jevMoveId(m), m]));
  assert(Array.isArray(data.candidates) && data.candidates.length > 0 && data.candidates.length <= canonical.size);
  const ids = data.candidates.map(c => c.id);
  assert(new Set(ids).size === ids.length && (!expectedIds || same(ids, expectedIds)));
  assert(data.policyDefinitions?.length === 2);
  data.policyDefinitions.forEach((p, i) => {
    const o = p.options;
    assert(p.id === (i === 0 ? 'self-tactical' : 'opponent-tactical') && p.role === (i === 0 ? 'self' : 'opponent')
      && o.method === 'choose-move' && o.maxDepth === 3 && o.maxNodes === limits.maxNodesPerDecision
      && o.maxMsPerDecision === 4 && o.choiceWindow === 0 && o.planStrength === 1 && o.strategyLevel === 3
      && o.elite === true && o.rng === 'disabled' && o.botSide === 'current-turn' && o.pressureTransitionBudget === null);
  });
  let scenarioCount = 0;
  let maxLine = 0;
  for (const c of data.candidates) {
    assert(canonical.has(c.id) && jevMoveId(c.move) === c.id);
    const after = applyMove(root, canonical.get(c.id)!);
    const replies = getResult(after, config) ? [null]
      : legalMoves(after, config).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
    assert(Array.isArray(c.scenarios) && c.scenarios.length === replies.length);
    let shortest = Infinity;
    c.scenarios.forEach((s, index) => {
      const reply = replies[index]!;
      const prefixLength = reply ? 2 : 1;
      assert(s.opponentPolicyId === 'opponent-tactical' && s.id === `${c.id}:reply:${reply ? jevMoveId(reply) : 'terminal'}`
        && (reply ? !!s.forcedReply && jevMoveId(s.forcedReply) === jevMoveId(reply) : s.forcedReply === null));
      assert(Array.isArray(s.line) && integer(s.line.length, prefixLength, limits.maxPlies)
        && s.plies === s.line.length && jevMoveId(s.line[0]!) === c.id
        && (!reply || jevMoveId(s.line[1]!) === jevMoveId(reply)));
      assert(Array.isArray(s.decisions) && s.decisions.length === s.line.length - prefixLength && s.policyCutoff === null);
      let position = root;
      s.line.forEach((move, ply) => {
        assert(!getResult(position, config));
        const actual = legalMoves(position, config).find(m => jevMoveId(m) === jevMoveId(move));
        assert(actual);
        if (ply >= prefixLength) {
          const d = s.decisions[ply - prefixLength]!;
          assert(d.linePly === ply && d.player === position.turn && d.applied === true && d.pressure === null
            && d.policyId === (position.turn === root.turn ? 'self-tactical' : 'opponent-tactical')
            && jevMoveId(d.move) === jevMoveId(move));
          assert(d.budget && Number.isFinite(d.budget.deadlineMs) && d.budget.deadlineMs <= limits.deadlineMs
            && d.budget.maxMs > 0 && d.budget.maxMs <= 4 && d.budget.maxDepth === 3 && d.budget.maxNodes === limits.maxNodesPerDecision);
          assert(d.search);
          if (d.search) {
            assert(integer(d.search.nodes, 0, limits.maxNodesPerDecision) && integer(d.search.completedDepth, 0, 3)
              && Number.isFinite(d.search.elapsedMs) && d.search.elapsedMs >= 0 && typeof d.search.aborted === 'boolean');
            assert(d.cutoff === (!d.search.aborted ? null : d.search.nodes >= limits.maxNodesPerDecision ? 'node-budget' : 'time-budget'));
          } else assert(d.cutoff === null);
        }
        position = applyMove(position, actual!);
      });
      const terminal = getResult(position, config);
      assert(s.terminal?.winner === terminal?.winner && s.terminal?.reason === terminal?.reason);
      if (terminal) assert(s.status === 'terminal' && s.plies <= data.commonCompletedPlies);
      else assert(s.terminal === null && s.plies === data.commonCompletedPlies
        && (data.complete ? s.status === 'ply-cap' && s.plies === limits.maxPlies : s.status === data.stopReason));
      const h = replyHorizon(position, root.turn, !!terminal);
      assert(s.horizon && ['nextPlayer', 'selfReserve', 'opponentReserve', 'selfKing', 'opponentKing', 'selfGuards', 'opponentGuards'].every(k =>
        same(s.horizon![k as keyof typeof h], h[k as keyof typeof h])));
      const summary = replySearchSummary(s.decisions);
      assert(Object.keys(summary).every(k => s.searchSummary[k as keyof typeof summary] === summary[k as keyof typeof summary]));
      scenarioCount++;
      shortest = Math.min(shortest, s.plies); maxLine = Math.max(maxLine, s.plies);
    });
    assert(c.commonCompletedPlies === shortest);
  }
  assert(limits.scenarioCount === scenarioCount && data.commonCompletedPlies === maxLine);
}
