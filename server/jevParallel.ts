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
import { briefJevRollouts, describeJevRollouts } from './jevRolloutBriefing';
import type { analyzeJevInitiative } from './jevInitiative';
import { buildJevBriefing, describeJevAction, describeJevPressure, describeJevRace, briefJevFacts, briefJevRoutes } from './jevBriefing';
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
  coverage?: { id: string; role: string; probability: number; category: 'deployment' | 'guard-action' | 'king-lane' | 'forcing-guard' }[];
  /** One bounded forcing-guard suggestion; inclusion never determines the final move. */
  pressureSuggestion?: ReturnType<typeof chooseJevGuardPressureMove>;
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
  expectedAfterHash?: string;
  appliedStateHash?: string;
  elapsedMs?: number;
  timings: { factsMs?: number; searchMs: number[]; pressureMs?: number; initiativeMs?: number; rolloutMs?: number };
}

export class ParallelTurnError extends JevError {
  constructor(code: JevError['code'], readonly trace: ParallelTurnTrace) {
    super(code, `JEV parallel turn failed: ${code}`);
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
    const stage: ApiStage = { phase, request: { model: JEV_MODEL, state: input, questions } };
    trace.stages.push(stage); checkpoint();
    const stageStart = Date.now();
    try {
      const result = await (options.evaluate ?? evaluateJev)({
        state: input, questions, apiKey: options.apiKey, signal: options.signal,
        deadlineMs: stageDeadline(phase === 'final' ? POLICY.finalBudgetMs : POLICY.proposalBudgetMs),
        onResponse: (response) => { stage.response = response; checkpoint(); },
      });
      stage.response = result.response;
      const { request: _request, response: _response, ...metadata } = result;
      stage.result = metadata;
      check();
      return result.answers;
    } catch (error) {
      stage.error = error instanceof JevError ? error.code : 'invalid_response';
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
    const priorities: Record<string, unknown>[] = [];
    const propose = async (ids: string[], recovery: boolean) => {
      const questions: Record<string, JevQuestion> = {};
      const criteria = Object.fromEntries(ids.map((id) => [id,
        `${describeJevAction(state, movesById.get(id)!)} ${factsById.has(id) ? describeJevRace(factsById.get(id)!.routes, false) : 'Route estimates unknown.'}`,
      ]));
      for (const role of JEV_ROLES) {
        questions[`proposal_${role.id}`] = { type: 'choice',
          instructions: `${role.purpose} Consider verified facts and limited estimates separately. ${role.priority ? 'Use none if no candidate usefully serves this purpose.' : 'You must choose a listed legal move.'}`,
          criteria: role.priority ? { ...criteria, none: 'No proposal meaningfully serves this purpose.' } : criteria };
        if (role.priority) questions[`priority_${role.id}`] = { type: 'boolean', instructions: `${role.priority} This is a strategic priority estimate, not a test of exact tactical facts or a game win probability.` };
      }
      const answers = await api(recovery ? 'reproposal' : 'proposals', {
        board, strategicContext, recentHistory: state.history.slice(-12), facts: rootFacts, allowedCandidateIds: ids, recovery,
        uncertainty: 'Unchecked replies are unknown, never safe. Questions run independently; they cannot read each other answers. Frozen-board routes are estimates, not secured future paths.',
      }, questions);
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
        deadlineMs: stageDeadline(POLICY.searchBudgetMs), maxDepth: POLICY.maxDepth, maxNodes: POLICY.maxNodes, signal: options.signal,
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
      deadlineMs: stageDeadline(POLICY.pressureBudgetMs), maxNodes: POLICY.pressureMaxNodes, signal: options.signal,
    });
    trace.timings.pressureMs = Date.now() - pressureStart;
    check(); checkpoint();
    const rolloutStart = Date.now();
    trace.rollouts = (options.rollouts ?? analyzeJevRollouts)(state, config, finalIds.map((id) => movesById.get(id)!), {
      deadlineMs: stageDeadline(POLICY.rolloutBudgetMs), maxPlies: POLICY.rolloutMaxPlies,
      maxNodesPerDecision: POLICY.rolloutDecisionNodes, signal: options.signal,
    });
    trace.timings.rolloutMs = Date.now() - rolloutStart;
    check(); checkpoint();
    const candidates = finalIds.map((id) => {
      const candidate = verified.get(id)!;
      // Numerical evaluation remains in the trace/control condition, never in the JEV final input.
      const { score: _score, extension, afterFacts, horizonFacts, ...evidence } = candidate;
      const extensionEvidence = extension ? (({ score: _extensionScore, horizonFacts: horizon, ...rest }) => ({
        ...rest, horizonFacts: briefJevFacts(horizon, extension.principalVariation.length % 2 === 0),
      }))(extension) : null;
      return { id, evidence: { ...evidence, afterFacts: briefJevFacts(afterFacts, false),
        horizonFacts: briefJevFacts(horizonFacts, candidate.principalVariation.length % 2 === 0), extension: extensionEvidence },
        retainedTerminalProof: proofs.get(id) ?? null, proposedBy: [...(proposedRoles.get(id) ?? [])] };
    });
    const finalCriteria = Object.fromEntries(finalIds.map((id) => {
      const candidate = verified.get(id)!;
      const after = describeJevRace(candidate.afterFacts.routes, false);
      const horizon = candidate.horizonFacts && !candidate.horizonFacts.terminal
        ? `At end of the example search line: ${describeJevRace(candidate.horizonFacts.routes, candidate.principalVariation.length % 2 === 0)}` : '';
      return [id, `${describeJevAction(state, movesById.get(id)!)} ${describeJevRollouts(trace.rollouts!, id, state.turn)} ${after} ${horizon} ${describeJevPressure(trace.pressure!.candidates.find((entry) => entry.id === id))}`];
    }));
    const answers = await api('final', { board, strategicContext, candidates, priorities, globalResult: trace.globalResult,
      conditionalContinuations: briefJevRollouts(trace.rollouts!, state.turn),
      opponentPressure: trace.pressure,
      pressureMeaning: 'Legal opponent replies can force a response to a king capture threat. Capture threats are conditional on SELF failing to answer, not an extra opponent turn. Listed safe responses avoid only the following terminal loss. advancesRow is geometric progress, not a secured route. A reply that leaves only sideways or backward king escapes can begin a chase; compare guard defenses and development. Incomplete or omitted cases remain unknown. These examples supplement, not replace, the search principal variation.',
      calculation: trace.searches.map(({ candidates: _candidates, ...scope }) => scope),
      meaning: 'Role agreement is not independent expert consensus. Coverage retains guard options from one role distribution, legal forward king lanes, and one fully checked immediate guard-pressure alternative so a forcing sequence is not silently dropped. Inclusion is not an extra vote or an endorsement. Role distributions and boolean priorities are separate estimates, not game win probability. Example reply lines are legal possibilities, not guaranteed opponent choices. Unknown does not mean safe. Retained terminal proofs remain valid even if a later common search is shallower.',
    }, { move: { type: 'choice', instructions: 'Choose the candidate that best helps SELF win the whole game. Exact terminal proofs take priority. Compare the conditional continuation results against both opponent behaviors, along with the goal race and counterplay. Prefer a credible winning continuation to merely moving the king closer while the opponent wins first. Continuations use fixed local policies for BOTH sides, not future JEV choices: they are examples, never forced outcomes, and incomplete lines have unknown results. Guard development can change a losing race but can also waste a turn. Your returned ID will be played unchanged; no code score or bonus will override it.', criteria: finalCriteria } });
    const answer = answers.move;
    if (!answer || answer.type !== 'choice' || !finalIds.includes(answer.choice)) throw new JevError('invalid_response', 'Invalid final ID');
    return finish(answer.choice, 'jev-final');
  } catch (error) {
    const code = error instanceof JevError ? error.code : 'invalid_response';
    trace.status = code === 'aborted' ? 'cancelled' : 'error';
    trace.error = code; trace.elapsedMs = Date.now() - start; checkpoint();
    throw new ParallelTurnError(code, trace);
  }
}
