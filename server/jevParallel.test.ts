import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { chooseParallelJevMove, ParallelTurnError } from './jevParallel';
import { analyzeJevFacts, analyzeJevCandidates, type JevCandidateAnalysis, type JevAnalyzedCandidate, type JevStateFacts } from './jevAnalysis';
import { JEV_ROLES, jevMoveId, jevStateHash } from './jevPolicy';
import { JevError } from './jev';
import { analyzeJevReplyRollouts } from './jevReplyRollouts';
import { type evaluateJev, type EvaluateJevOptions, type EvaluateJevResult } from './jevGateway';
import { readFileSync } from 'node:fs';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { Move } from '../src/core/types';
import { analyzeJevSearchProposal } from './jevSearchProposal';

it('fits every legal role choice after early guard development without dropping candidates', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/jev-development-input.json', import.meta.url), 'utf8'));
  let captured: EvaluateJevOptions | undefined;
  let trace: any;
  await expect(chooseParallelJevMove({ gameId: 'development-input-regression', state: fixture.snapshot,
    config: fixture.config, apiKey: 'unused-local-test', deadlineMs: Date.now() + 30_000,
    onTrace: value => { trace = value; },
    evaluate: async input => { captured = input; throw new JevError('aborted', 'stop after local request check'); },
  })).rejects.toMatchObject({ code: 'aborted' });
  expect(captured).toBeDefined();
  const ids = legalMoves(fixture.snapshot, fixture.config).map(jevMoveId).sort();
  for (const q of Object.values(captured!.questions)) if (q.type === 'choice') {
    expect(Object.keys(q.criteria).filter(id => id !== 'none').sort()).toEqual(ids);
  }
  expect(trace.stages[0].inputBudget.sentBytes).toBeLessThanOrEqual(26_000);
  expect(trace.stages[0].inputBudget.steps).toContain('reference-shared-move-ids-in-role-criteria');
  expect(JSON.stringify(captured!.state)).toContain('guardInfrastructure');
});

const firstLoss = JSON.parse(readFileSync(new URL('./fixtures/jev-first-loss.json', import.meta.url), 'utf8')) as {
  moves: Move[]; winner: string; reason: string;
};
function lossPosition(ply: number) {
  let position = initialState(DEFAULT_CONFIG);
  for (const saved of firstLoss.moves.slice(0, ply)) {
    const canonical = legalMoves(position, DEFAULT_CONFIG).find((move) => jevMoveId(move) === jevMoveId(saved));
    if (!canonical) throw new Error('Invalid loss fixture');
    position = applyMove(position, canonical);
  }
  return position;
}

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
    deadlineMs: Date.now() + 30_000, facts: () => structuredClone(allFacts), search, searchProposal: () => null, evaluate };
}

it.each([false, true])('keeps JEV final authority and exact loss gates with a classical alternative (unsafe=%s)', async (unsafe) => {
  const kingId = 'm_8_4_7_4'; const guard: Move = { kind: 'PLACE', to: { r: 7, c: 4 } };
  const guardId = jevMoveId(guard);
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const out = response(input);
    for (const answer of Object.values(out.answers)) if (answer.type === 'choice') {
      answer.choice = kingId;
      answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(id => [id, Number(id === kingId)]));
    }
    return out;
  });
  const facts = structuredClone(allFacts);
  if (unsafe) facts.candidates.find(c => jevMoveId(c.move) === guardId)!.immediateLoss = true;
  const result = await chooseParallelJevMove({ ...options(api), facts: () => facts,
    searchProposal: (state, config, opts) => analyzeJevSearchProposal(state, config, { ...opts,
      choose: (_state, _rules, searchOptions) => {
        searchOptions?.onSearchComplete?.({ nodes: 1, completedDepth: 1, elapsedMs: 1, aborted: false });
        searchOptions?.onContinuation?.([guard]); return guard;
      } }),
  });
  const final = api.mock.calls.at(-1)![0];
  const keys = Object.keys((final.questions.move as { criteria: Record<string, string> }).criteria);
  expect(keys.includes(guardId)).toBe(!unsafe);
  expect(result.trace.coverage?.some(c => c.id === guardId && c.category === 'search-proposal')).toBe(!unsafe);
  expect((api.mock.calls[0]![0].state as any).searchProposal).toBeUndefined();
  expect((final.state as any).searchProposal?.id ?? null).toBe(unsafe ? null : guardId);
  expect(jevMoveId(result.move)).toBe(kingId);
  expect(result.trace.selection?.source).toBe('jev-final');
});

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
  // The final stage intentionally strips the general board decisionGuide.
  // Opening coaching must therefore survive as explicit final-stage context.
  const proposalState = first.state as any;
  const finalState = final.state as any;
  expect(proposalState.board.decisionGuide).toEqual(expect.arrayContaining([
    expect.stringContaining('BEFORE rushing the king'),
  ]));
  expect(finalState.developmentPlan).toEqual(expect.arrayContaining([
    expect.stringContaining('BEFORE rushing the king'),
    expect.stringContaining('Convert the delay into our king progress'),
  ]));
  expect(JSON.stringify(final.state)).not.toMatch(/"score"|BEST|LOWER/);
  const criteria = (final.questions.move as { criteria: Record<string, string> }).criteria;
  expect(result.trace.selection).toMatchObject({ id: Object.keys(criteria).at(-1), source: 'jev-final' });
  expect(jevMoveId(result.move)).toBe(result.trace.selection?.id);
  expect(state).toEqual(before);
  expect(result.trace.stateHash).toBe(jevStateHash(state));
  expect(result.trace.stages).toHaveLength(2);
});

it('deduplicates unanimous proposals when every other candidate is immediately unsafe', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    const first = Object.keys((input.questions.proposal_general as { criteria: Record<string, string> }).criteria)[0]!;
    for (const answer of Object.values(result.answers)) if (answer.type === 'choice') answer.choice = first;
    return result;
  });
  const facts = structuredClone(allFacts);
  for (const candidate of facts.candidates) if (jevMoveId(candidate.move) !== 'm_8_4_7_3') candidate.immediateLoss = true;
  const result = await chooseParallelJevMove({ ...options(api), facts: () => facts });
  expect(api).toHaveBeenCalledTimes(1);
  expect(result.trace.selection?.source).toBe('engine-single-candidate');
  expect(result.trace.selection?.proposedBy).toHaveLength(6);
});

it('recovers a missing guard candidate from one role distribution without forcing that move', async () => {
  const kingId = 'm_8_4_7_4';
  const guardId = 'p_7_4';
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    for (const [id, answer] of Object.entries(result.answers)) if (answer.type === 'choice') {
      answer.choice = kingId;
      if (id !== 'move') answer.probabilities = { ...answer.probabilities, [kingId]: 0.8, [guardId]: 0.2 };
    }
    return result;
  });
  const result = await chooseParallelJevMove(options(api));
  expect(result.trace.coverage?.filter(c => c.category !== 'king-lane')).toEqual([{ id: guardId, role: 'breakthrough', category: 'deployment', probability: 0.2 }]);
  expect(result.trace.proposals.find((p) => p.id === guardId)?.roles).toEqual(['coverage-breakthrough']);
  const final = api.mock.calls.at(-1)![0];
  expect(Object.keys((final.questions.move as { criteria: Record<string, string> }).criteria)).toContain(guardId);
  expect(result.trace.selection).toMatchObject({ id: kingId, source: 'jev-final' });
});

it('keeps all forward king lanes even when every role repeats the straight advance', async () => {
  const kingId = 'm_8_4_7_4';
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    for (const answer of Object.values(result.answers)) if (answer.type === 'choice') answer.choice = kingId;
    return result;
  });
  const result = await chooseParallelJevMove(options(api));
  expect(result.trace.coverage?.filter(c => c.category === 'king-lane').map(c => c.id))
    .toEqual(['m_8_4_7_3', 'm_8_4_7_5']);
  const ids = Object.keys(api.mock.calls.at(-1)![0].questions.move!.criteria!);
  expect(ids).toEqual(expect.arrayContaining(['m_8_4_7_3', kingId, 'm_8_4_7_5']));
  expect(result.trace.selection?.id).toBe(kingId);
});

it('uses increasing rows for WHITE forward-lane coverage and excludes a known losing lane', async () => {
  const position = applyMove(state, { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 4 } });
  const facts = analyzeJevFacts(position, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
  facts.candidates.find(c => jevMoveId(c.move) === 'm_0_4_1_3')!.immediateLoss = true;
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    for (const answer of Object.values(result.answers)) if (answer.type === 'choice') answer.choice = 'm_0_4_1_4';
    return result;
  });
  const result = await chooseParallelJevMove({ ...options(api), state: position, facts: () => facts });
  expect(result.trace.coverage?.filter(c => c.category === 'king-lane').map(c => c.id)).toEqual(['m_0_4_1_5']);
  expect(result.trace.gates.at(-1)?.candidates).not.toContain('m_0_4_1_3');
});

it('keeps defensive deployment available before the recorded first-loss king chase', async () => {
  const position = lossPosition(6);
  const facts = analyzeJevFacts(position, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    for (const [id, answer] of Object.entries(result.answers)) if (answer.type === 'choice') {
      answer.choice = id === 'move' ? 'p_4_4' : 'm_5_4_4_3';
      answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities)
        .map((key) => [key, key === 'm_5_4_4_3' ? 0.8 : key === 'p_4_4' ? 0.2 : 0]));
    }
    return result;
  });
  const result = await chooseParallelJevMove({ ...options(api), state: position, facts: () => facts });
  expect(result.trace.coverage?.some((c) => c.id === 'p_4_4')).toBe(true);
  expect(result.trace.selection).toMatchObject({ id: 'p_4_4', source: 'jev-final' });
  expect(getResult(lossPosition(firstLoss.moves.length), DEFAULT_CONFIG)).toEqual({ winner: firstLoss.winner, reason: firstLoss.reason });
});

it('keeps distinct guard alternatives even when a role already proposed a deployment', async () => {
  const position = lossPosition(6);
  const facts = analyzeJevFacts(position, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    for (const [id, answer] of Object.entries(result.answers)) if (answer.type === 'choice') {
      answer.choice = id === 'move' ? 'p_5_3' : id === 'proposal_breakthrough' ? 'p_4_4' : 'm_5_4_4_3';
      answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities)
        .map((key) => [key, key === 'p_5_3' ? 0.2 : key === 'p_5_5' ? 0.1 : key === answer.choice ? 0.7 : 0]));
    }
    return result;
  });
  const result = await chooseParallelJevMove({ ...options(api), state: position, facts: () => facts });
  expect(result.trace.proposals.find((p) => p.id === 'p_4_4')?.roles).toContain('breakthrough');
  expect(result.trace.coverage?.filter(c => c.category !== 'king-lane').map((c) => c.id)).toEqual(['p_5_3', 'p_5_5']);
  expect(result.trace.selection?.id).toBe('p_5_3');
  expect(result.trace.pressure?.complete).toBe(true);
});

it('retains proven losses when reproposal restarts at a shallower common depth', async () => {
  const losing = new Set<string>();
  let calls = 0;
  const restartSearch: typeof search = (...args) => {
    const result = search(...args);
    if (++calls === 1) {
      for (const candidate of result.candidates) {
        losing.add(jevMoveId(candidate.move));
        candidate.proven = 'loss';
        candidate.proof = { winner: 'WHITE', reason: 'goal', plies: 4 };
      }
    } else {
      result.completedDepth = 3; result.stopReason = 'deadline';
      for (const candidate of result.candidates) candidate.searchedDepth = 3;
    }
    return result;
  };
  const api = vi.fn(async (input: EvaluateJevOptions) => response(input));
  const result = await chooseParallelJevMove({ ...options(api), search: restartSearch });
  expect(calls).toBe(2);
  expect(result.trace.searches[1]!.candidates.every((c) => c.proven === 'unknown')).toBe(true);
  expect(result.trace.retainedProofs?.map((p) => p.id).sort()).toEqual([...losing].sort());
  expect(result.trace.retainedProofs?.every((p) => p.searchedDepth === 4 && p.sourceSearch === 0)).toBe(true);
  expect(result.trace.coverage!.filter(c => c.category !== 'king-lane').length).toBeLessThanOrEqual(2);
  expect(result.trace.coverage!.filter(c => c.category === 'king-lane').length).toBeLessThanOrEqual(3);
  expect(losing.has(result.trace.selection!.id)).toBe(false);
  expect(result.trace.gates.at(-1)!.excluded.sort()).toEqual([...losing].sort());
});

it('preserves the actual first-loss move 27 proof after a shallower restart', async () => {
  const position = lossPosition(26);
  let searches = 0;
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const result = response(input);
    const inputState = input.state as { recovery?: boolean };
    if (!inputState.recovery && !input.questions.move) {
      for (const answer of Object.values(result.answers)) if (answer.type === 'choice') answer.choice = 'm_8_3_7_4';
    }
    return result;
  });
  const result = await chooseParallelJevMove({ ...options(api), state: position, facts: analyzeJevFacts,
    search: (root, config, moves, budget) => {
      if (++searches === 1) return analyzeJevCandidates(root, config, moves, {
        ...budget, deadlineMs: Date.now() + 10_000, maxNodes: 1_000_000, maxDepth: 4,
      });
      const shallower = search(root, config, moves, budget);
      shallower.completedDepth = 3; shallower.stopReason = 'deadline';
      shallower.candidates.forEach((candidate) => { candidate.searchedDepth = 3; });
      return shallower;
    },
  });
  const retained = result.trace.retainedProofs!.find((p) => p.id === 'm_8_3_7_4');
  expect(retained).toMatchObject({ proven: 'loss', searchedDepth: 4,
    proof: { winner: 'WHITE', reason: 'goal', plies: 4 } });
  expect(result.trace.gates.at(-1)!.excluded).toContain('m_8_3_7_4');
  expect(result.trace.selection!.id).not.toBe('m_8_3_7_4');
  expect(result.trace.globalResult).toBe('unknown');
}, 15_000);

it('reproposes once when every proposal loses immediately but a checked alternative exists', async () => {
  const ordered = legalMoves(state, DEFAULT_CONFIG).sort((a, b) => jevMoveId(a).localeCompare(jevMoveId(b)));
  const unsafe = new Set(ordered.filter(move => move.kind === 'MOVE' && move.to.r < move.from.r).map(jevMoveId));
  for (const move of ordered) if (move.kind === 'PLACE') unsafe.add(jevMoveId(move));
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
  const position = lossPosition(4);
  const facts = analyzeJevFacts(position, DEFAULT_CONFIG, { deadlineMs: Date.now() + 2_000 });
  const result = await chooseParallelJevMove({ ...options(api), state: position, facts: () => facts, search: loseSearch });
  expect(result.trace.stages.filter((s) => s.phase === 'reproposal')).toHaveLength(1);
  expect(result.trace.globalResult).toBe('unknown');
});

it('preserves a full final window through a slow proposal and all-loss reproposal path', async () => {
  const startedAt = 1_800_000_000_000;
  let clock = startedAt;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const apiWindows: Array<{ phase: string; startedAt: number; deadlineMs: number }> = [];
  const searchDeadlines: number[] = [];
  let searchCalls = 0;
  let searchProposalCalls = 0;
  let searchProposalDeadline = 0;
  let rolloutDeadline = 0;

  try {
    const api = vi.fn(async (input: EvaluateJevOptions) => {
      const phase = input.questions.move ? 'final'
        : (input.state as { recovery?: boolean }).recovery ? 'reproposal' : 'proposals';
      apiWindows.push({ phase, startedAt: clock, deadlineMs: input.deadlineMs });
      clock = input.deadlineMs;
      return response(input);
    });
    const timedSearch: typeof search = (...args) => {
      const budget = args[3];
      searchDeadlines.push(budget.deadlineMs);
      const result = search(...args);
      clock = budget.deadlineMs;
      if (++searchCalls === 1) {
        // Mark the exact-result category solely to force the bounded recovery
        // branch; this simulated-clock test makes no claim about game strength.
        for (const candidate of result.candidates) candidate.proven = 'loss';
      }
      return result;
    };

    const result = await chooseParallelJevMove({
      ...options(api),
      deadlineMs: startedAt + 30_000,
      search: timedSearch,
      searchProposal: (_root, _rules, budget) => {
        searchProposalCalls++;
        searchProposalDeadline = budget.deadlineMs;
        clock = budget.deadlineMs;
        return null;
      },
      rollouts: (root, rules, moves, budget) => {
        rolloutDeadline = budget.deadlineMs;
        const analysis = analyzeJevReplyRollouts(root, rules, moves, {
          ...budget,
          choose: (position, config, searchOptions) => {
            searchOptions.onSearchComplete?.({ nodes: 1, completedDepth: 1, elapsedMs: 0, aborted: false });
            return legalMoves(position, config)[0] ?? null;
          },
        });
        clock = budget.deadlineMs;
        return analysis;
      },
    });

    expect(result.trace.stages.map(stage => stage.phase)).toEqual(['proposals', 'reproposal', 'final']);
    expect(searchProposalCalls).toBe(1);
    expect(searchProposalDeadline).toBe(startedAt + 9_000);
    expect(result.trace.searchProposal).toBeNull();
    expect(result.trace.searchProposalOmission).toBe('budget-unavailable');
    expect(searchDeadlines).toEqual([startedAt + 12_000, startedAt + 20_000]);
    expect(rolloutDeadline).toBe(startedAt + 21_500);
    expect(apiWindows).toEqual([
      { phase: 'proposals', startedAt, deadlineMs: startedAt + 8_000 },
      { phase: 'reproposal', startedAt: startedAt + 12_000, deadlineMs: startedAt + 17_000 },
      { phase: 'final', startedAt: startedAt + 21_500, deadlineMs: startedAt + 29_500 },
    ]);
    expect(apiWindows[2]!.deadlineMs - apiWindows[2]!.startedAt).toBe(8_000);
    expect(result.trace.selection?.source).toBe('jev-final');
    expect(clock - startedAt).toBe(29_500);
  } finally {
    now.mockRestore();
  }
});

it('records hard API errors without retrying, advancing the board or calling a fallback engine', async () => {
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    input.onResponse?.({ model: 'typesafe-ai/jev', answers: null });
    throw new JevError('invalid_response', 'Malformed answer');
  });
  const before = structuredClone(state);
  let failure: ParallelTurnError | undefined;
  try { await chooseParallelJevMove(options(api)); }
  catch (error) { expect(error).toBeInstanceOf(ParallelTurnError); failure = error as ParallelTurnError; }
  expect(failure?.trace.status).toBe('error');
  expect(failure?.trace.stages[0]?.error).toBe('invalid_response');
  expect(failure?.trace.stages[0]?.attempts).toEqual([
    expect.objectContaining({ attempt: 1, error: 'invalid_response', response: { model: 'typesafe-ai/jev', answers: null } }),
  ]);
  expect(failure?.trace.stages[0]?.response).toEqual({ model: 'typesafe-ai/jev', answers: null });
  expect(failure?.trace.selection).toBeUndefined();
  expect(api).toHaveBeenCalledTimes(1);
  expect(state).toEqual(before);
});

it('retries only the failed final API stage with the identical prepared request and preserves every attempt', async () => {
  let finalCalls = 0;
  const finalInputs: EvaluateJevOptions[] = [];
  const snapshots: any[] = [];
  const wait = vi.fn(async () => {});
  const searchOnce = vi.fn(search);
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    if (input.questions.move) {
      finalInputs.push(input);
      if (finalCalls++ === 0) {
        input.onResponse?.({ status: 503, error: 'temporary upstream failure' });
        throw new JevError('http_error', 'Unavailable', 503);
      }
    }
    return response(input);
  });

  const result = await chooseParallelJevMove({ ...options(api), search: searchOnce,
    apiRetry: { wait }, onTrace: trace => snapshots.push(trace) });
  const finalStage = result.trace.stages.find(stage => stage.phase === 'final')!;

  expect(result.trace.stages.map(stage => stage.phase)).toEqual(['proposals', 'final']);
  expect(searchOnce).toHaveBeenCalledTimes(1);
  expect(finalInputs).toHaveLength(2);
  expect(finalInputs[1]!.state).toBe(finalInputs[0]!.state);
  expect(finalInputs[1]!.questions).toBe(finalInputs[0]!.questions);
  expect(finalInputs[1]!.deadlineMs).toBe(finalInputs[0]!.deadlineMs);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledWith(1_000, undefined);
  expect(finalStage.attempts).toHaveLength(2);
  expect(finalStage.attempts[0]).toMatchObject({ attempt: 1, error: 'http_error', httpStatus: 503,
    response: { status: 503, error: 'temporary upstream failure' } });
  expect(finalStage.attempts[1]).toMatchObject({ attempt: 2, result: { cost: 0 } });
  expect(finalStage.attempts.filter(attempt => attempt.result)).toHaveLength(1);
  expect(finalStage.error).toBeUndefined();
  expect(finalStage.httpStatus).toBeUndefined();
  expect(finalStage.response).toEqual(finalStage.attempts[1]!.response);
  expect(snapshots.some(trace => trace.stages.at(-1)?.phase === 'final'
    && trace.stages.at(-1)?.error === 'http_error'
    && trace.stages.at(-1)?.attempts.at(-1)?.httpStatus === 503)).toBe(true);
  expect(result.trace.selection?.source).toBe('jev-final');
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


it('retains a forcing guard follow-up while leaving the final choice to JEV', async () => {
  const record = JSON.parse(readFileSync(new URL('./fixtures/jev-forcing-sequence.json', import.meta.url), 'utf8')) as { moves: Move[] };
  let position = initialState(DEFAULT_CONFIG);
  for (const move of record.moves) position = applyMove(position, move);
  const kingChoice = 'm_5_2_4_2';
  const api = vi.fn(async (input: EvaluateJevOptions) => {
    const output = response(input);
    for (const [id, answer] of Object.entries(output.answers)) {
      if (answer.type !== 'choice') continue;
      const question = input.questions[id]!;
      if (question.type !== 'choice') continue;
      answer.choice = kingChoice;
      answer.probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === kingChoice)]));
    }
    return output;
  });
  const result = await chooseParallelJevMove({
    ...options(api), state: position, facts: analyzeJevFacts,
    rollouts: (state, config, moves, opts) => analyzeJevReplyRollouts(state, config, moves, {
      ...opts, choose: (next, rules, searchOptions) => {
        searchOptions.onSearchComplete?.({ nodes: 0, completedDepth: 0, elapsedMs: 0, aborted: false });
        return legalMoves(next, rules)[0] ?? null;
      },
    }),
  });
  expect(result.trace.pressureSuggestion).toMatchObject({
    source: 'guard-pressure', stats: { complete: true, selected: { id: 'p_5_4', forwardSafeKingEscapes: 1 } },
  });
  expect(result.trace.coverage).toContainEqual(expect.objectContaining({ id: 'p_5_4', category: 'forcing-guard' }));
  const finalQuestion = api.mock.calls.at(-1)![0].questions.move!;
  expect(finalQuestion.type === 'choice' && Object.keys(finalQuestion.criteria)).toContain('p_5_4');
  expect(jevMoveId(result.move)).toBe(kingChoice);
  expect(result.trace.selection?.source).toBe('jev-final');
});
