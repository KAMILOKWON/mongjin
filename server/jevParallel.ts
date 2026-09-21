import { randomUUID } from 'node:crypto';
import type { RuleConfig } from '../src/core/config';
import type { GameState } from '../src/core/types';
import { legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { JevError } from './jev';
import { evaluateJev, JEV_MODEL, type JevQuestion, type EvaluateJevResult } from './jevGateway';
import { analyzeJevFacts, analyzeJevCandidates } from './jevAnalysis';
import { analyzeJevPressure } from './jevPressure';
import { chooseJevGuardPressureMove } from './jevPressurePolicy';
import { analyzeJevRollouts } from './jevRollouts';
import { analyzeJevReplyRollouts } from './jevReplyRollouts';
import { prepareJevInput } from './jevInputBudget';
import { buildJevDecisionBriefing } from './jevDecisionBriefing';
import { getJevThreatEscapeIds } from './jevEscapeCoverage';
import { briefJevGuardDevelopment } from './jevGuardBriefing';
import { analyzeJevSearchProposal, briefJevSearchProposal } from './jevSearchProposal';
import type { analyzeJevInitiative } from './jevInitiative';
import { buildJevBriefing, describeJevAction, briefJevRoutes } from './jevBriefing';
import { JEV_PARALLEL_POLICY as POLICY, JEV_ROLES, jevMoveId, jevStateHash } from './jevPolicy';
import type { JevRecord } from './jevRecords';

type Facts = ReturnType<typeof analyzeJevFacts>;
type Search = ReturnType<typeof analyzeJevCandidates>;
export type JevRetainedProof = {
  id: string;
  proven: 'win' | 'loss';
  proof: Search['candidates'][number]['proof'];
  searchedDepth: number;
  sourceSearch: number;
  principalVariation: Search['candidates'][number]['principalVariation'];
};
type ApiStage = {
  phase: 'proposals' | 'reproposal' | 'final';
  request: { model: string; state: unknown; questions: Record<string, JevQuestion> };
  response?: unknown;
  result?: Omit<EvaluateJevResult, 'request' | 'response'>;
  elapsedMs?: number;
  error?: string;
  /** Actual HTTP response status, independent of provider response-body fields. */
  httpStatus?: number;
  inputBudget?: ReturnType<typeof prepareJevInput>['budget'];
};

export interface ParallelTurnTrace extends JevRecord {
  policy: typeof POLICY;
  model: string;
  config: RuleConfig;
  snapshot: GameState;
  deadlineMs: number;
  startedAt: string;
  status: 'running' | 'selected' | 'applied' | 'error' | 'cancelled';
  stages: ApiStage[];
  facts?: Facts;
  searches: Search[];
  proposals: { id: string; roles: string[] }[];
  /** Guard suggestions and legal forward king lanes retained without an extra expert vote. */
  coverage?: { id: string; role: string; probability: number | null; category: 'deployment' | 'guard-action' | 'king-lane' | 'forcing-guard' | 'king-escape' | 'search-proposal' }[];
  /** One bounded forcing-guard suggestion; inclusion never determines the final move. */
  pressureSuggestion?: ReturnType<typeof chooseJevGuardPressureMove>;
  searchProposal?: ReturnType<typeof analyzeJevSearchProposal>;
  searchProposalStartedAt?: number;
  searchProposalDeadlineMs?: number;
  searchProposalOmission?: 'budget-unavailable' | 'injected-unavailable';
  /** v5: exact outcomes survive shallower/restarted searches; common scores stay separate. */
  retainedProofs?: JevRetainedProof[];
  pressure?: ReturnType<typeof analyzeJevPressure>;
  initiative?: ReturnType<typeof analyzeJevInitiative>;
  /** Conditional policy continuations, never terminal proofs or a root move override. */
  rollouts?: ReturnType<typeof analyzeJevRollouts>;
  gates: { reason: string; candidates: string[]; excluded: string[] }[];
  globalResult: 'unknown' | 'proven-win' | 'proven-loss';
  selection?: { id: string; source: 'engine-immediate-win' | 'engine-single-candidate' | 'jev-final'; proposedBy: string[] };
  error?: string;
  errorStatus?: number;
  expectedAfterHash?: string;
  appliedStateHash?: string;
  elapsedMs?: number;
  timings: { factsMs?: number; searchMs: number[]; pressureMs?: number; initiativeMs?: number; rolloutMs?: number; searchProposalMs?: number };
}

export class ParallelTurnError extends JevError {
  constructor(code: JevError['code'], readonly trace: ParallelTurnTrace, status?: number) {
    super(code, `JEV parallel turn failed: ${code}`, status);
  }
}

export interface ParallelTurnOptions {
  gameId: string;
  state: GameState;
  config: RuleConfig;
  apiKey: string;
  deadlineMs: number;
  signal?: AbortSignal;
  evaluate?: typeof evaluateJev;
  facts?: typeof analyzeJevFacts;
  search?: typeof analyzeJevCandidates;
  searchProposal?: typeof analyzeJevSearchProposal;
  rollouts?: typeof analyzeJevRollouts;
  onTrace?: (trace: ParallelTurnTrace) => void;
}

/** A fresh immutable snapshot per attempt; no unlogged reuse of previous model answers. */
export async function chooseParallelJevMove(options: ParallelTurnOptions) {
  const start = Date.now();
  const state = structuredClone(options.state);
  const config = { ...options.config };
  const deadlineMs = Math.min(options.deadlineMs, start + POLICY.turnLimitMs);
  const trace: ParallelTurnTrace = {
    turnId: randomUUID(), gameId: options.gameId, ply: state.history.length,
    stateHash: jevStateHash(state), policy: POLICY, model: JEV_MODEL, config, snapshot: state,
    deadlineMs, startedAt: new Date(start).toISOString(), status: 'running',
    stages: [], searches: [], proposals: [], coverage: [], retainedProofs: [], gates: [], globalResult: 'unknown', timings: { searchMs: [] },
  };
  const checkpoint = () => options.onTrace?.(structuredClone(trace));
  const check = () => {
    if (options.signal?.aborted) throw new JevError('aborted', 'Cancelled JEV turn');
    if (Date.now() >= deadlineMs) throw new JevError('timeout', 'JEV turn deadline reached');
  };
  const stageDeadline = (budgetMs: number) => Math.min(deadlineMs, Date.now() + budgetMs);
  const allMoves = legalMoves(state, config).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
  const movesById = new Map(allMoves.map((move) => [jevMoveId(move), move]));
  const board = buildJevBriefing(state, config);
  const api = async (phase: ApiStage['phase'], input: unknown, questions: Record<string, JevQuestion>) => {
    check();
    const prepared = prepareJevInput(phase, input, questions);
    const stage: ApiStage = { phase, inputBudget: prepared.budget,
      request: { model: JEV_MODEL, state: prepared.state, questions: prepared.questions } };
    trace.stages.push(stage); checkpoint();
    const stageStart = Date.now();
    try {
      const result = await (options.evaluate ?? evaluateJev)({
        state: prepared.state, questions: prepared.questions, apiKey: options.apiKey, signal: options.signal,
        deadlineMs: Math.min(stageDeadline(phase === 'final' ? POLICY.finalBudgetMs : POLICY.proposalBudgetMs),
          // Recovery must leave one verification, first-reply enumeration and
          // the full final-call allocation. The long rollout can be shortened.
          phase === 'reproposal' ? deadlineMs - (POLICY.searchBudgetMs + POLICY.pressureBudgetMs + POLICY.finalBudgetMs + 1_000) : deadlineMs),
        onResponse: (response) => { stage.response = response; checkpoint(); },
      });
      stage.response = result.response;
      const { request: _request, response: _response, ...metadata } = result;
      stage.result = metadata;
      check();
      return result.answers;
    } catch (error) {
      stage.error = error instanceof JevError ? error.code : 'invalid_response';
      stage.httpStatus = error instanceof JevError ? error.status : undefined;
      throw error;
    } finally { stage.elapsedMs = Date.now() - stageStart; checkpoint(); }
  };
  const finish = (id: string, source: NonNullable<ParallelTurnTrace['selection']>['source']) => {
    check();
    const move = movesById.get(id);
    if (!move || jevStateHash(state) !== trace.stateHash || !legalMoves(state, config).some((m) => jevMoveId(m) === id)) {
      throw new JevError('invalid_response', 'Selected move or original snapshot changed');
    }
    trace.selection = { id, source, proposedBy: trace.proposals.find((p) => p.id === id)?.roles ?? [] };
    trace.expectedAfterHash = jevStateHash(applyMove(state, move));
    trace.status = 'selected'; trace.elapsedMs = Date.now() - start; checkpoint();
    return {
      move, trace, elapsedMs: trace.elapsedMs, model: JEV_MODEL, cost: 0,
      inputTokens: trace.stages.reduce((n, s) => n + (s.result?.inputTokens ?? 0), 0),
      outputTokens: trace.stages.reduce((n, s) => n + (s.result?.outputTokens ?? 0), 0),
    };
  };
  try {
    check();
    if (state.history.length >= POLICY.maxPlies) throw new JevError('invalid_response', 'JEV game ply limit reached');
    if (!allMoves.length || getResult(state, config)) throw new JevError('invalid_response', 'Cannot request a terminal turn');
    const factsStart = Date.now();
    const facts = (options.facts ?? analyzeJevFacts)(state, config, { deadlineMs: stageDeadline(POLICY.factsBudgetMs), signal: options.signal });
    trace.timings.factsMs = Date.now() - factsStart;
    trace.facts = facts; checkpoint();
    const factsById = new Map(facts.candidates.map((candidate) => [jevMoveId(candidate.move), candidate]));
    const immediate = facts.candidates.filter((c) => c.immediateWin).map((c) => jevMoveId(c.move));
    if (immediate.length) {
      trace.globalResult = 'proven-win';
      trace.gates.push({ reason: 'exact-immediate-win', candidates: immediate, excluded: [...movesById.keys()].filter((id) => !immediate.includes(id)) });
      return finish(immediate[0]!, 'engine-immediate-win');
    }
    const losesImmediately = (id: string) => {
      const f = factsById.get(id);
      return !!f && (f.immediateLoss || f.opponentWinningReplies.length > 0);
    };
    const hasConfirmedAlternative = facts.candidates.some((f) => !f.immediateLoss && f.repliesComplete && f.opponentWinningReplies.length === 0);
    const allowed = [...movesById.keys()].filter((id) => !hasConfirmedAlternative || !losesImmediately(id));
    const threatEscapes = getJevThreatEscapeIds(state, config, facts);
    trace.pressureSuggestion = chooseJevGuardPressureMove(state, config, {
      deadlineMs: stageDeadline(30), maxNodes: 2_048, signal: options.signal,
      // Coverage ignores fallback results. A canonical placeholder avoids doing
      // another search when no fully checked pressure suggestion exists.
      fallback: () => allMoves[0]!,
    });
    check(); checkpoint();
    const isGuardAction = (id: string) => {
      const move = movesById.get(id)!;
      return move.kind === 'PLACE' || state.board[move.from.r]?.[move.from.c]?.type === 'GUARD';
    };
    const deployed = { own: 0, opponent: 0 };
    for (const row of state.board) for (const piece of row) {
      if (piece?.type === 'GUARD') deployed[piece.player === state.turn ? 'own' : 'opponent']++;
    }
    const strategicContext = {
      deployedGuards: deployed,
      initialRoutes: briefJevRoutes(facts.initialRoute, true),
      checkedKingEscapes: facts.candidates.filter((f) => f.move.kind === 'MOVE'
        && state.board[f.move.from.r]?.[f.move.from.c]?.type === 'KING'
        && f.repliesComplete && !f.immediateLoss && !f.opponentWinningReplies.length).map((f) => jevMoveId(f.move)),
      meaning: 'Reserves are material, not deployed blockers. Frozen routes ignore future deployment. Surviving the next reply does not mean winning the race. Examine guard development and opponent counterplay as well as king movement.',
    };
    const rootFacts = facts.candidates.map((f) => ({ id: jevMoveId(f.move), immediateWin: f.immediateWin,
      immediateLoss: f.immediateLoss, opponentWinningReplies: f.opponentWinningReplies,
      checkedReplies: f.checkedReplies, repliesComplete: f.repliesComplete, totalGuardsIncludingReserve: f.material,
      frozenRoutesAfterAction: briefJevRoutes(f.routes, false) }));
    const proposedRoles = new Map<string, Set<string>>();
    const guardDevelopment = briefJevGuardDevelopment(trace.pressureSuggestion);
    const priorities: Record<string, unknown>[] = [];
    const propose = async (ids: string[], recovery: boolean) => {
      const questions: Record<string, JevQuestion> = {};
      const criteria = Object.fromEntries(ids.map((id) => [id,
        describeJevAction(state, movesById.get(id)!),
      ]));
      for (const role of JEV_ROLES) {
        questions[`proposal_${role.id}`] = { type: 'choice',
          instructions: `${role.purpose} Match each option ID to its shared root facts; route estimates are listed once there. Consider verified facts and limited estimates separately. ${role.priority ? 'Use none if no candidate usefully serves this purpose.' : 'You must choose a listed legal move.'}`,
          criteria: role.priority ? { ...criteria, none: 'No proposal meaningfully serves this purpose.' } : criteria };
        if (role.priority) questions[`priority_${role.id}`] = { type: 'boolean', instructions: `${role.priority} This is a strategic priority estimate, not a test of exact tactical facts or a game win probability.` };
      }
      const answers = await api(recovery ? 'reproposal' : 'proposals', {
        board, strategicContext, guardDevelopment, recentHistory: state.history.slice(-12), facts: rootFacts, allowedCandidateIds: ids, recovery,
        uncertainty: 'Unchecked replies are unknown, never safe. Questions run independently; they cannot read each other answers. Frozen-board routes are estimates, not secured future paths.',
      }, questions);
      if (trace.searchProposal === undefined) {
        // Do not repeat an expensive search when the provider rejects the first
        // call. Leave time for verification, pressure, rollouts and final JEV.
        const suggestionStart = Date.now();
        const remainingStages = POLICY.searchBudgetMs * 2 + POLICY.pressureBudgetMs
          + POLICY.finalBudgetMs + 5_000 + 1_000;
        const allocationDeadline = Math.min(stageDeadline(POLICY.searchProposalBudgetMs), deadlineMs - remainingStages);
        trace.searchProposalStartedAt = suggestionStart;
        trace.searchProposalDeadlineMs = allocationDeadline;
        trace.searchProposal = (options.searchProposal ?? analyzeJevSearchProposal)(state, config, {
          deadlineMs: allocationDeadline, signal: options.signal,
        });
        if (!trace.searchProposal) {
          trace.searchProposalOmission = allocationDeadline <= Date.now() ? 'budget-unavailable' : 'injected-unavailable';
        }
        trace.timings.searchProposalMs = Date.now() - suggestionStart;
        check(); checkpoint();
      }
      const proposed = new Set<string>();
      const assessment: Record<string, unknown> = {};
      for (const role of JEV_ROLES) {
        const answer = answers[`proposal_${role.id}`];
        if (!answer || answer.type !== 'choice') throw new JevError('invalid_response', 'Missing role proposal');
        if (answer.choice !== 'none') {
          if (!ids.includes(answer.choice)) throw new JevError('invalid_response', 'Proposal outside supplied candidates');
          proposed.add(answer.choice);
          const roles = proposedRoles.get(answer.choice) ?? new Set<string>(); roles.add(role.id); proposedRoles.set(answer.choice, roles);
        } else if (!role.priority) throw new JevError('invalid_response', 'General role cannot abstain');
        if (role.priority) assessment[role.id] = answers[`priority_${role.id}`];
      }
      // Keep the six primary choices and at most two distinct guard alternatives.
      // Each alternative uses one role's distribution, never a weighted vote or a
      // replacement for the final model choice. Unsafe/known-losing moves still face gates.
      const guardScopes = [
        { role: 'breakthrough', category: 'deployment' as const, accepts: (id: string) => movesById.get(id)!.kind === 'PLACE' },
        { role: 'blocking', category: 'guard-action' as const, accepts: isGuardAction },
      ];
      for (const scope of guardScopes.slice(0, POLICY.maxGuardAlternatives)) {
        if (trace.coverage!.filter(entry => ['deployment', 'guard-action'].includes(entry.category)).length >= POLICY.maxGuardAlternatives) break;
        // One primary guard move can be a bad sacrifice. Retain distinct guard
        // alternatives too, so the final choice can compare actual defenses.
        const answer = answers[`proposal_${scope.role}`];
        if (answer?.type !== 'choice') continue;
        const alternative = ids.filter((id) => !proposed.has(id) && allowed.includes(id) && scope.accepts(id))
          .sort((a, b) => (answer.probabilities[b] ?? 0) - (answer.probabilities[a] ?? 0) || a.localeCompare(b))[0];
        if (!alternative) continue;
        proposed.add(alternative);
        const roles = proposedRoles.get(alternative) ?? new Set<string>();
        roles.add(`coverage-${scope.role}`); proposedRoles.set(alternative, roles);
        trace.coverage!.push({ id: alternative, role: scope.role, category: scope.category, probability: answer.probabilities[alternative] ?? 0 });
      }
      // Preserve every legal forward king lane, not just the roles' frequently
      // duplicated straight advance. These are alternatives, never endorsements.
      const advanceAnswer = answers.proposal_advance;
      for (const id of ids) {
        if (trace.coverage!.filter(entry => entry.category === 'king-lane').length >= POLICY.maxKingLaneAlternatives) break;
        if (proposed.has(id) || !allowed.includes(id)) continue;
        const move = movesById.get(id)!;
        if (move.kind !== 'MOVE' || state.board[move.from.r]?.[move.from.c]?.type !== 'KING'
          || !(state.turn === 'BLACK' ? move.to.r < move.from.r : move.to.r > move.from.r)) continue;
        proposed.add(id);
        const roles = proposedRoles.get(id) ?? new Set<string>();
        roles.add('coverage-king-lane'); proposedRoles.set(id, roles);
        trace.coverage!.push({ id, role: 'advance', category: 'king-lane',
          probability: advanceAnswer?.type === 'choice' ? advanceAnswer.probabilities[id] ?? 0 : 0 });
      }
      const forcing = trace.pressureSuggestion;
      if (forcing?.source === 'guard-pressure' && forcing.move && forcing.stats.complete) {
        const id = jevMoveId(forcing.move);
        if (ids.includes(id) && allowed.includes(id) && !proposed.has(id)) {
          proposed.add(id);
          const roles = proposedRoles.get(id) ?? new Set<string>();
          roles.add('coverage-forcing-guard'); proposedRoles.set(id, roles);
          const blocking = answers.proposal_blocking;
          trace.coverage!.push({ id, role: 'blocking', category: 'forcing-guard',
            probability: blocking?.type === 'choice' ? blocking.probabilities[id] ?? 0 : 0 });
        }
      }
      for (const id of threatEscapes) {
        if (!ids.includes(id) || !allowed.includes(id) || proposed.has(id)) continue;
        proposed.add(id);
        const roles = proposedRoles.get(id) ?? new Set<string>();
        roles.add('coverage-king-escape'); proposedRoles.set(id, roles);
        const answer = answers.proposal_survival;
        trace.coverage!.push({ id, role: 'survival', category: 'king-escape',
          probability: answer?.type === 'choice' ? answer.probabilities[id] ?? 0 : 0 });
      }
      const searchId = trace.searchProposal?.id;
      if (searchId && ids.includes(searchId) && allowed.includes(searchId)) {
        proposed.add(searchId);
        const roles = proposedRoles.get(searchId) ?? new Set<string>();
        roles.add('coverage-classical-search'); proposedRoles.set(searchId, roles);
        if (!trace.coverage!.some(c => c.id === searchId && c.category === 'search-proposal')) {
          trace.coverage!.push({ id: searchId, role: 'classical-search', category: 'search-proposal', probability: null });
        }
      }
      priorities.push(assessment);
      trace.proposals = [...proposedRoles].map(([id, roles]) => ({ id, roles: [...roles] }));
      return [...proposed];
    };
    let proposed = await propose([...movesById.keys()], false);
    let recovered = false;
    let eligible = proposed.filter((id) => allowed.includes(id));
    trace.gates.push({ reason: 'avoid-confirmed-next-reply-loss', candidates: eligible, excluded: proposed.filter((id) => !eligible.includes(id)) });
    if (!eligible.length && allowed.length) {
      proposed = await propose(allowed, true); recovered = true;
      eligible = proposed.filter((id) => allowed.includes(id));
    }
    const verified = new Map<string, Search['candidates'][number]>();
    const proofs = new Map<string, JevRetainedProof>();
    const proven = (id: string) => proofs.get(id)?.proven ?? 'unknown';
    const verify = (ids: string[]) => {
      const searchStart = Date.now();
      check();
      const search = (options.search ?? analyzeJevCandidates)(state, config, ids.map((id) => movesById.get(id)!), {
        deadlineMs: Math.min(stageDeadline(POLICY.searchBudgetMs), deadlineMs - (POLICY.pressureBudgetMs + POLICY.finalBudgetMs + 1_000)),
        maxDepth: POLICY.maxDepth, maxNodes: POLICY.maxNodes, signal: options.signal,
      });
      trace.searches.push(search);
      trace.timings.searchMs.push(Date.now() - searchStart);
      for (const candidate of search.candidates) {
        const id = jevMoveId(candidate.move);
        verified.set(id, candidate);
        if (candidate.proven !== 'unknown') {
          const old = proofs.get(id);
          if (old && old.proven !== candidate.proven) throw new JevError('invalid_response', 'Conflicting terminal proofs');
          if (!old) proofs.set(id, {
            id, proven: candidate.proven, proof: candidate.proof,
            searchedDepth: candidate.proofSearchedDepth ?? (candidate.extension?.proven === candidate.proven
              ? candidate.extension.searchedDepth : candidate.searchedDepth),
            sourceSearch: trace.searches.length - 1, principalVariation: structuredClone(candidate.principalVariation),
          });
        }
      }
      trace.retainedProofs = [...proofs.values()];
      checkpoint();
    };
    verify(eligible);
    if (eligible.every((id) => proven(id) === 'loss')) {
      const alternatives = allowed.filter((id) => !eligible.includes(id));
      if (alternatives.length && !recovered) {
        const additional = await propose(alternatives, true); recovered = true;
        eligible = [...new Set([...eligible, ...additional])]; verify(eligible);
      }
    }
    const wins = eligible.filter((id) => proven(id) === 'win');
    const unresolved = eligible.filter((id) => proven(id) !== 'loss');
    const finalIds = wins.length ? wins : unresolved.length ? unresolved : eligible;
    trace.globalResult = wins.length ? 'proven-win' : [...movesById.keys()].every((id) => losesImmediately(id) || proven(id) === 'loss') ? 'proven-loss' : 'unknown';
    trace.gates.push({ reason: wins.length ? 'proven-win' : unresolved.length ? 'avoid-proven-loss' : 'candidate-loss-global-scope-recorded',
      candidates: finalIds, excluded: eligible.filter((id) => !finalIds.includes(id)) });
    if (finalIds.length === 1) return finish(finalIds[0]!, 'engine-single-candidate');
    if (!finalIds.length) throw new JevError('invalid_response', 'No final candidate');
    const pressureStart = Date.now();
    trace.pressure = analyzeJevPressure(state, config, finalIds.map((id) => movesById.get(id)!), {
      deadlineMs: Math.min(stageDeadline(POLICY.pressureBudgetMs), deadlineMs - POLICY.finalBudgetMs - 1_000),
      maxNodes: POLICY.pressureMaxNodes, signal: options.signal,
    });
    trace.timings.pressureMs = Date.now() - pressureStart;
    check(); checkpoint();
    const rolloutStart = Date.now();
    trace.rollouts = (options.rollouts ?? analyzeJevReplyRollouts)(state, config, finalIds.map((id) => movesById.get(id)!), {
      deadlineMs: Math.min(stageDeadline(POLICY.rolloutBudgetMs), deadlineMs - POLICY.finalBudgetMs - 500), maxPlies: POLICY.rolloutMaxPlies,
      maxNodesPerDecision: POLICY.rolloutDecisionNodes, signal: options.signal,
    });
    trace.timings.rolloutMs = Date.now() - rolloutStart;
    check(); checkpoint();
    const decision = buildJevDecisionBriefing(state, config, finalIds.map(id => verified.get(id)!),
      trace.pressure, trace.rollouts, [...proofs.values()], priorities);
    const answers = await api('final', { ...decision.state, guardDevelopment, globalResult: trace.globalResult,
      searchProposal: trace.searchProposal && finalIds.includes(trace.searchProposal.id) ? briefJevSearchProposal(trace.searchProposal) : null,
      calculation: trace.searches.map(({ candidates: _candidates, ...scope }) => scope),
      proposals: finalIds.map(id => ({ id, roles: [...(proposedRoles.get(id) ?? [])] })),
      proposalMeaning: 'Role agreement is not independent consensus. Coverage adds alternatives for comparison, not an extra vote or recommendation.',
    }, decision.questions);
    const answer = answers.move;
    if (!answer || answer.type !== 'choice' || !finalIds.includes(answer.choice)) throw new JevError('invalid_response', 'Invalid final ID');
    return finish(answer.choice, 'jev-final');
  } catch (error) {
    const code = error instanceof JevError ? error.code : 'invalid_response';
    trace.status = code === 'aborted' ? 'cancelled' : 'error';
    const status = error instanceof JevError ? error.status : undefined;
    trace.error = code; trace.errorStatus = status; trace.elapsedMs = Date.now() - start; checkpoint();
    throw new ParallelTurnError(code, trace, status);
  }
}
