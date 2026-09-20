import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { chooseParallelJevMove, ParallelTurnError } from './jevParallel';
import { analyzeJevFacts, type JevCandidateAnalysis, type JevAnalyzedCandidate, type JevStateFacts } from './jevAnalysis';
import { JEV_ROLES, jevMoveId, jevStateHash } from './jevPolicy';
import { JevError } from './jev';
import { type evaluateJev, type EvaluateJevOptions, type EvaluateJevResult } from './jevGateway';

const state = initialState(DEFAULT_CONFIG);
const allFacts = analyzeJevFacts(state, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
const stateFacts: JevStateFacts = { terminal: null, material: { own: 8, opponent: 8 }, routes: allFacts.initialRoute, complete: true };
const search: NonNullable<Parameters<typeof chooseParallelJevMove>[0]['search']> = (_state, _config, moves) => ({
  version: 'jev-search-1', completedDepth: 4, nodes: 100, stopReason: 'complete',
  extension: { policyVersion: 'jev-extension-1', maxDepth: 6, attemptedCandidates: 0, completedCandidates: 0, nodes: 0, stopReason: 'complete', scope: 'unstable-candidates-only' },
  candidates: moves.map((move, index): JevAnalyzedCandidate => ({
    move, score: index === 0 ? 999 : -999, searchedDepth: 4, proven: 'unknown', proof: null,
    principalVariation: [move], afterFacts: stateFacts, horizonFacts: stateFacts,
    extension: { requestedDepth: 6, searchedDepth: 4, completed: false, nodes: 1, stopReason: 'node-budget',
      reasons: ['goal-race'], score: 123456, proven: 'unknown', proof: null, principalVariation: [move], horizonFacts: stateFacts },
  })),
});

function response(options: EvaluateJevOptions): EvaluateJevResult {
  const answers: EvaluateJevResult['answers'] = {};
  let roleIndex = 0;
  for (const [id, question] of Object.entries(options.questions)) {
    if (question.type === 'boolean') { answers[id] = { type: 'boolean', probability: 0.01 }; continue; }
    const keys = Object.keys(question.criteria).filter((key) => key !== 'none');
    const choice = id === 'move' ? keys.at(-1)! : keys[roleIndex++ % Math.min(2, keys.length)]!;
    answers[id] = { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, Number(key === choice)])) };
  }
  return { model: 'typesafe-ai/jev', answers, request: { model: 'typesafe-ai/jev', state: options.state, questions: options.questions },
    response: { answers }, elapsedMs: 1, inputTokens: 100, outputTokens: 10, cost: 0 };
}
function options(evaluate: typeof evaluateJev) {
  return { gameId: 'local-test', state, config: DEFAULT_CONFIG, apiKey: 'test-key',
    deadlineMs: Date.now() + 30_000, facts: () => structuredClone(allFacts), search, evaluate };
}

it('always asks six roles and five priorities; final JEV ID wins even with a lower engine score', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => response(input));
  const before = structuredClone(state);
  const result = await chooseParallelJevMove(options(api));
  expect(api).toHaveBeenCalledTimes(2);
  const first = api.mock.calls[0]![0];
  expect(Object.values(first.questions).filter((q) => q.type === 'choice')).toHaveLength(6);
  expect(Object.values(first.questions).filter((q) => q.type === 'boolean')).toHaveLength(5);
  for (const role of JEV_ROLES) {
    const q = first.questions[`proposal_${role.id}`]!;
    expect(q.type).toBe('choice');
    expect(q.criteria && Object.hasOwn(q.criteria, 'none')).toBe(role.id !== 'general');
  }
  const final = api.mock.calls[1]![0];
  expect(JSON.stringify(final.state)).not.toMatch(/"score"|BEST|LOWER/);
  const criteria = (final.questions.move as { criteria: Record<string, string> }).criteria;
  expect(result.trace.selection).toMatchObject({ id: Object.keys(criteria).at(-1), source: 'jev-final' });
  expect(jevMoveId(result.move)).toBe(result.trace.selection?.id);
  expect(state).toEqual(before);
  expect(result.trace.stateHash).toBe(jevStateHash(state));
  expect(result.trace.stages).toHaveLength(2);
});

it('deduplicates unanimous proposals and records an engine single-candidate decision without final API', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    const first = Object.keys((input.questions.proposal_general as { criteria: Record<string, string> }).criteria)[0]!;
    for (const answer of Object.values(result.answers)) if (answer.type === 'choice') answer.choice = first;
    return result;
  });
  const result = await chooseParallelJevMove(options(api));
  expect(api).toHaveBeenCalledTimes(1);
  expect(result.trace.selection?.source).toBe('engine-single-candidate');
  expect(result.trace.selection?.proposedBy).toHaveLength(6);
});

it('reproposes once when every proposal loses immediately but a checked alternative exists', async () => {
  const ordered = legalMoves(state, DEFAULT_CONFIG).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
  const unsafe = new Set(ordered.slice(0, 2).map(jevMoveId));
  const facts = structuredClone(allFacts);
  for (const candidate of facts.candidates) if (unsafe.has(jevMoveId(candidate.move))) candidate.opponentWinningReplies = [ordered[0]!];
  const api = vi.fn(async (input: EvaluateJevOptions) => response(input));
  const result = await chooseParallelJevMove({ ...options(api), facts: () => facts });
  expect(result.trace.stages.map((stage) => stage.phase)).toEqual(['proposals', 'reproposal', 'final']);
  const reproposal = api.mock.calls[1]![0].questions.proposal_general as { criteria: Record<string, string> };
  expect(Object.keys(reproposal.criteria).some((id) => unsafe.has(id))).toBe(false);
  expect(unsafe.has(jevMoveId(result.move))).toBe(false);
});

it('does not claim global forced loss from losing proposals while unexplored alternatives remain', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => response(input));
  const loseSearch: typeof search = (...args) => {
    const result: JevCandidateAnalysis = search(...args);
    result.candidates.forEach((c) => { c.proven = 'loss'; });
    return result;
  };
  const result = await chooseParallelJevMove({ ...options(api), search: loseSearch });
  expect(result.trace.stages.filter((s) => s.phase === 'reproposal')).toHaveLength(1);
  expect(result.trace.globalResult).toBe('unknown');
});

it('records API errors without advancing the board or calling a fallback engine', async () => {
  const api = vi.fn(async () => { throw new JevError('http_429', 'Limited'); });
  const before = structuredClone(state);
  let failure: ParallelTurnError | undefined;
  try { await chooseParallelJevMove(options(api)); }
  catch (error) { expect(error).toBeInstanceOf(ParallelTurnError); failure = error as ParallelTurnError; }
  expect(failure?.trace.status).toBe('error');
  expect(failure?.trace.stages[0]?.error).toBe('http_429');
  expect(failure?.trace.selection).toBeUndefined();
  expect(api).toHaveBeenCalledTimes(1);
  expect(state).toEqual(before);
});

it('skips API only for an engine-confirmed immediate winning move', async () => {
  const winState = structuredClone(state);
  winState.board[8]![4] = null;
  winState.board[1]![4] = { type: 'KING', player: 'BLACK' };
  const api = vi.fn(async (input: EvaluateJevOptions) => response(input));
  const result = await chooseParallelJevMove({ ...options(api), state: winState, facts: analyzeJevFacts });
  expect(api).not.toHaveBeenCalled();
  expect(result.trace.selection?.source).toBe('engine-immediate-win');
  expect(result.trace.globalResult).toBe('proven-win');
});

it('does not start an expired request or accept an invalid final ID', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const out = response(input);
    if (out.answers.move?.type === 'choice') out.answers.move.choice = 'invented';
    return out;
  });
  await expect(chooseParallelJevMove({ ...options(api), deadlineMs: Date.now() - 1 })).rejects.toThrow('timeout');
  expect(api).not.toHaveBeenCalled();
  await expect(chooseParallelJevMove(options(api))).rejects.toThrow('invalid_response');
});
