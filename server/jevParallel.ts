import { randomUUID } from 'node:crypto';
import type { RuleConfig } from '../src/core/config';
import type { GameState } from '../src/core/types';
import { legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { describeJevState, JevError } from './jev';
import { evaluateJev, JEV_MODEL, type JevQuestion, type EvaluateJevResult } from './jevGateway';
import { analyzeJevFacts, analyzeJevCandidates } from './jevAnalysis';
import { JEV_PARALLEL_POLICY as POLICY, JEV_ROLES, jevMoveId, jevStateHash } from './jevPolicy';
import type { JevRecord } from './jevRecords';

type Facts = ReturnType<typeof analyzeJevFacts>;
type Search = ReturnType<typeof analyzeJevCandidates>;
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
  gates: { reason: string; candidates: string[]; excluded: string[] }[];
  globalResult: 'unknown' | 'proven-win' | 'proven-loss';
  selection?: { id: string; source: 'engine-immediate-win' | 'engine-single-candidate' | 'jev-final'; proposedBy: string[] };
  error?: string;
  expectedAfterHash?: string;
  appliedStateHash?: string;
  elapsedMs?: number;
  timings: { factsMs?: number; searchMs: number[] };
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
    stages: [], searches: [], proposals: [], gates: [], globalResult: 'unknown', timings: { searchMs: [] },
  };
  const checkpoint = () => options.onTrace?.(structuredClone(trace));
  const check = () => {
    if (options.signal?.aborted) throw new JevError('aborted', 'Cancelled JEV turn');
    if (Date.now() >= deadlineMs) throw new JevError('timeout', 'JEV turn deadline reached');
  };
  const stageDeadline = (budgetMs: number) => Math.min(deadlineMs, Date.now() + budgetMs);
  const allMoves = legalMoves(state, config).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
  const movesById = new Map(allMoves.map((move) => [jevMoveId(move), move]));
  const board = { ...describeJevState(state, config), selfPlayer: state.turn };
  const criteriaFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, JSON.stringify(movesById.get(id))]));
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
    const rootFacts = facts.candidates.map((f) => ({ id: jevMoveId(f.move), immediateWin: f.immediateWin,
      immediateLoss: f.immediateLoss, opponentWinningReplies: f.opponentWinningReplies,
      checkedReplies: f.checkedReplies, repliesComplete: f.repliesComplete, material: f.material, routes: f.routes }));
    const proposedRoles = new Map<string, Set<string>>();
    const priorities: Record<string, unknown>[] = [];
    const propose = async (ids: string[], recovery: boolean) => {
      const questions: Record<string, JevQuestion> = {};
      const criteria = criteriaFor(ids);
      for (const role of JEV_ROLES) {
        questions[`proposal_${role.id}`] = { type: 'choice',
          instructions: `${role.purpose} Consider verified facts and limited estimates separately. ${role.priority ? 'Use none if no candidate usefully serves this purpose.' : 'You must choose a listed legal move.'}`,
          criteria: role.priority ? { ...criteria, none: 'No proposal meaningfully serves this purpose.' } : criteria };
        if (role.priority) questions[`priority_${role.id}`] = { type: 'boolean', instructions: `${role.priority} This is a strategic priority estimate, not a test of exact tactical facts or a game win probability.` };
      }
      const answers = await api(recovery ? 'reproposal' : 'proposals', {
        board, recentHistory: state.history.slice(-12), facts: rootFacts, allowedCandidateIds: ids, recovery,
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
    const verify = (ids: string[]) => {
      const searchStart = Date.now();
      check();
      const search = (options.search ?? analyzeJevCandidates)(state, config, ids.map((id) => movesById.get(id)!), {
        deadlineMs: stageDeadline(POLICY.searchBudgetMs), maxDepth: POLICY.maxDepth, maxNodes: POLICY.maxNodes, signal: options.signal,
      });
      trace.searches.push(search);
      trace.timings.searchMs.push(Date.now() - searchStart);
      for (const candidate of search.candidates) verified.set(jevMoveId(candidate.move), candidate);
      checkpoint();
    };
    verify(eligible);
    if (eligible.every((id) => verified.get(id)?.proven === 'loss')) {
      const alternatives = allowed.filter((id) => !eligible.includes(id));
      if (alternatives.length && !recovered) {
        const additional = await propose(alternatives, true); recovered = true;
        eligible = [...new Set([...eligible, ...additional])]; verify(eligible);
      }
    }
    const wins = eligible.filter((id) => verified.get(id)?.proven === 'win');
    const unresolved = eligible.filter((id) => verified.get(id)?.proven !== 'loss');
    const finalIds = wins.length ? wins : unresolved.length ? unresolved : eligible;
    trace.globalResult = wins.length ? 'proven-win' : [...movesById.keys()].every((id) => losesImmediately(id) || verified.get(id)?.proven === 'loss') ? 'proven-loss' : 'unknown';
    trace.gates.push({ reason: wins.length ? 'proven-win' : unresolved.length ? 'avoid-proven-loss' : 'candidate-loss-global-scope-recorded',
      candidates: finalIds, excluded: eligible.filter((id) => !finalIds.includes(id)) });
    if (finalIds.length === 1) return finish(finalIds[0]!, 'engine-single-candidate');
    if (!finalIds.length) throw new JevError('invalid_response', 'No final candidate');
    const candidates = finalIds.map((id) => {
      const candidate = verified.get(id)!;
      // Numerical evaluation remains in the trace/control condition, never in the JEV final input.
      const { score: _score, extension, ...evidence } = candidate;
      const extensionEvidence = extension ? (({ score: _extensionScore, ...rest }) => rest)(extension) : null;
      return { id, evidence: { ...evidence, extension: extensionEvidence }, proposedBy: [...(proposedRoles.get(id) ?? [])] };
    });
    const answers = await api('final', { board, candidates, priorities, globalResult: trace.globalResult,
      calculation: trace.searches.map(({ candidates: _candidates, ...scope }) => scope),
      meaning: 'Role agreement is not independent expert consensus. Role distributions and boolean priorities are separate estimates, not game win probability. Example reply lines are legal possibilities, not guaranteed opponent choices. Unknown does not mean safe.',
    }, { move: { type: 'choice', instructions: 'Choose the candidate that best helps SELF win. Use its individual facts, estimates and proof scope. Your returned ID will be played unchanged; no code score or bonus will override it.', criteria: criteriaFor(finalIds) } });
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
