import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import type { Move } from '../src/core/types';
import { chooseParallelJevMove, type ParallelTurnTrace } from './jevParallel';
import { analyzeJevPressure } from './jevPressure';
import { analyzeJevInitiative } from './jevInitiative';
import { JEV_PARALLEL_POLICY, jevMoveId, jevStateHash } from './jevPolicy';
import { JevTraceVerificationError, verifyJevTrace } from './jevReplay';
import { main, mockEvaluateJev } from './verifyJev';
import { analyzeJevSearchProposal, briefJevSearchProposal } from './jevSearchProposal';
import { analyzeJevCandidates } from './jevAnalysis';

const illegalMove: Move = {
  kind: 'MOVE',
  from: { r: 99, c: 99 },
  to: { r: 98, c: 98 },
};

function clone(trace: ParallelTurnTrace): ParallelTurnTrace {
  return structuredClone(trace);
}

const lossRecord = JSON.parse(readFileSync(
  new URL('./fixtures/jev-first-loss.json', import.meta.url), 'utf8',
)) as { moves: Move[] };

function recordedPressureTrace(base: ParallelTurnTrace): ParallelTurnTrace {
  let state = initialState(DEFAULT_CONFIG);
  for (const move of lossRecord.moves.slice(0, 6)) state = applyMove(state, move);
  const moves = legalMoves(state, DEFAULT_CONFIG)
    .filter((move) => ['m_5_4_4_3', 'p_4_4'].includes(jevMoveId(move)));
  const trace = clone(base);
  trace.ply = state.history.length;
  trace.snapshot = state;
  trace.stateHash = jevStateHash(state);
  trace.status = 'error';
  trace.error = 'pressure-replay-fixture';
  trace.stages = [];
  trace.searches = [];
  trace.retainedProofs = [];
  delete trace.selection;
  delete trace.expectedAfterHash;
  delete trace.appliedStateHash;
  delete trace.initiative;
  delete trace.rollouts;
  trace.pressure = analyzeJevPressure(state, DEFAULT_CONFIG, moves, {
    deadlineMs: Date.now() + 5_000,
    maxNodes: JEV_PARALLEL_POLICY.pressureMaxNodes,
  });
  return trace;
}

function move(from: [number, number], to: [number, number]): Move {
  return { kind: 'MOVE', from: { r: from[0], c: from[1] }, to: { r: to[0], c: to[1] } };
}

function place(to: [number, number]): Move {
  return { kind: 'PLACE', to: { r: to[0], c: to[1] } };
}

function v16Ply7State() {
  let state = initialState(DEFAULT_CONFIG);
  for (const candidate of [
    move([8, 4], [7, 4]), move([0, 4], [1, 4]), move([7, 4], [6, 4]),
    move([1, 4], [2, 3]), move([6, 4], [5, 4]), place([3, 3]), move([5, 4], [4, 5]),
  ]) {
    expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(candidate);
    state = applyMove(state, candidate);
  }
  return state;
}

function terminalProofTrace(base: ParallelTurnTrace): ParallelTurnTrace {
  const state = v16Ply7State();
  const ids = ['m_2_3_3_2', 'm_3_3_3_4', 'p_3_4', 'm_3_3_4_3', 'm_2_3_3_4'];
  const roots = ids.map(id => legalMoves(state, DEFAULT_CONFIG).find(move => jevMoveId(move) === id)!);
  const search = analyzeJevCandidates(state, DEFAULT_CONFIG, roots, {
    deadlineMs: Date.now() + 10_000,
    maxDepth: 4,
    maxNodes: 100_000,
    terminalProofDepth: 8,
  });
  const retainedProofs = search.candidates.flatMap(candidate => candidate.proven === 'unknown' ? [] : [{
    id: jevMoveId(candidate.move),
    proven: candidate.proven,
    proof: candidate.proof,
    searchedDepth: candidate.proofSearchedDepth!,
    sourceSearch: 0,
    principalVariation: candidate.principalVariation,
  }]);
  const retained = new Map(retainedProofs.map(proof => [proof.id, proof.proven]));
  const wins = ids.filter(id => retained.get(id) === 'win');
  const unresolved = ids.filter(id => retained.get(id) !== 'loss');
  const finalIds = wins.length ? wins : unresolved.length ? unresolved : ids;
  const trace = clone(base);
  trace.ply = state.history.length;
  trace.snapshot = state;
  trace.stateHash = jevStateHash(state);
  trace.status = 'error';
  trace.error = 'terminal-proof-replay-fixture';
  trace.stages = [];
  trace.searches = [search];
  trace.retainedProofs = retainedProofs;
  trace.gates = [{
    reason: wins.length ? 'proven-win' : unresolved.length ? 'avoid-proven-loss' : 'candidate-loss-global-scope-recorded',
    candidates: finalIds,
    excluded: ids.filter(id => !finalIds.includes(id)),
  }];
  trace.globalResult = 'unknown';
  trace.proposals = [];
  trace.coverage = [];
  delete trace.selection;
  delete trace.expectedAfterHash;
  delete trace.appliedStateHash;
  delete trace.facts;
  delete trace.pressure;
  delete trace.pressureSuggestion;
  delete trace.initiative;
  delete trace.rollouts;
  delete trace.searchProposal;
  delete trace.searchProposalOmission;
  return trace;
}

function stripV17TerminalProofs(trace: ParallelTurnTrace): void {
  for (const search of trace.searches) {
    let removed = false;
    for (const candidate of search.candidates) {
      if (candidate.extension?.method === 'terminal-only-loss-proof') {
        candidate.extension = null;
        removed = true;
      }
    }
    if (removed) {
      search.extension = {
        policyVersion: 'jev-extension-1',
        maxDepth: 6,
        attemptedCandidates: 0,
        completedCandidates: 0,
        nodes: 0,
        stopReason: 'complete',
        scope: 'unstable-candidates-only',
      };
    }
  }
}

describe('verifyJevTrace', () => {
  let valid: ParallelTurnTrace;
  let terminalValid: ParallelTurnTrace;

  beforeAll(async () => {
    const result = await chooseParallelJevMove({
      gameId: 'replay-test',
      state: initialState(DEFAULT_CONFIG),
      config: DEFAULT_CONFIG,
      apiKey: 'test-only-key',
      deadlineMs: Date.now() + JEV_PARALLEL_POLICY.turnLimitMs,
      evaluate: mockEvaluateJev,
      searchProposal: () => null,
    });
    valid = result.trace;
    terminalValid = terminalProofTrace(valid);
  }, 35_000);

  it('verifies an actual initial-state mock turn', () => {
    const result = verifyJevTrace(valid);
    expect(result).toMatchObject({
      gameId: 'replay-test',
      ply: 0,
      stateHash: jevStateHash(initialState(DEFAULT_CONFIG)),
      status: 'selected',
      applied: false,
    });
    expect(result.selectionId).toBe(valid.selection?.id);
    expect(result.candidateVariations).toBeGreaterThan(0);
  });

  it('rejects a terminal-only extension relabeled as scored, over-depth, or proven', () => {
    for (const mutate of [
      (extension: NonNullable<ParallelTurnTrace['searches'][number]['candidates'][number]['extension']>) => { extension.score = 100; },
      (extension: NonNullable<ParallelTurnTrace['searches'][number]['candidates'][number]['extension']>) => { extension.searchedDepth = 9; },
      (extension: NonNullable<ParallelTurnTrace['searches'][number]['candidates'][number]['extension']>) => {
        extension.proven = 'loss'; extension.proof = { winner: 'WHITE', reason: 'goal', plies: 1 };
      },
    ]) {
      const changed = clone(valid);
      const extension = changed.searches.flatMap(search => search.candidates)
        .find(candidate => candidate.extension?.method === 'terminal-only-loss-proof')?.extension;
      expect(extension).toBeDefined();
      mutate(extension!);
      expect(() => verifyJevTrace(changed)).toThrow('invalid-extension-pv');
    }
  });

  it('reproduces a valid directional terminal-loss proof before accepting the record', () => {
    expect(() => verifyJevTrace(terminalValid)).not.toThrow();
    const losses = terminalValid.searches[0]!.candidates.filter(candidate => (
      candidate.extension?.method === 'terminal-only-loss-proof' && candidate.extension.proven === 'loss'
    ));
    expect(losses.length).toBeGreaterThan(0);
  });

  it('audits current v18 proof, search-proposal, and rollout evidence while retaining v17 replay', () => {
    expect(valid.policy.version).toBe('parallel-v18');
    expect(valid.rollouts).toMatchObject({
      version: 'jev-rollouts-v4',
      limits: { maxPlies: 8, maxNodesPerDecision: 64 },
    });
    expect(Object.hasOwn(valid, 'searchProposal')).toBe(true);
    expect(() => verifyJevTrace(valid)).not.toThrow();
    expect(() => verifyJevTrace(terminalValid)).not.toThrow();

    const legacyV17 = clone(valid);
    (legacyV17.policy as { version: string }).version = 'parallel-v17';
    expect(() => verifyJevTrace(legacyV17)).not.toThrow();

    const missingProposal = clone(valid);
    delete missingProposal.searchProposal;
    expect(() => verifyJevTrace(missingProposal)).toThrowError('invalid-search-proposal');

    const missingRollouts = clone(valid);
    delete missingRollouts.rollouts;
    expect(() => verifyJevTrace(missingRollouts)).toThrowError('invalid-rollouts');

    const alteredV4Budget = clone(valid);
    alteredV4Budget.rollouts!.limits.maxPlies = 7;
    expect(() => verifyJevTrace(alteredV4Budget)).toThrowError('invalid-rollouts');

    const alteredProof = clone(terminalValid);
    const loss = alteredProof.searches[0]!.candidates.find(candidate => (
      candidate.extension?.method === 'terminal-only-loss-proof' && candidate.extension.proven === 'loss'
    ))!;
    loss.extension!.proof!.plies += 1;
    expect(() => verifyJevTrace(alteredProof)).toThrowError('invalid-extension-pv');
  });

  it('accepts an error checkpoint after verification but before a final gate is created', () => {
    const partial = clone(terminalValid);
    const eligible = partial.searches[0]!.candidates.map(candidate => jevMoveId(candidate.move));
    partial.gates = [{ reason: 'avoid-confirmed-next-reply-loss', candidates: eligible, excluded: [] }];

    expect(() => verifyJevTrace(partial)).not.toThrow();
  });

  it('uses retained proofs when the latest verification has no terminal-only extensions', () => {
    const changed = clone(terminalValid);
    const latest = structuredClone(changed.searches[0]!);
    for (const candidate of latest.candidates) {
      if (candidate.extension?.method === 'terminal-only-loss-proof') candidate.extension = null;
    }
    latest.extension = {
      policyVersion: 'jev-extension-1',
      maxDepth: 6,
      attemptedCandidates: 0,
      completedCandidates: 0,
      nodes: 0,
      stopReason: 'complete',
      scope: 'unstable-candidates-only',
    };
    changed.searches.push(latest);

    expect(() => verifyJevTrace(changed)).not.toThrow();
  });

  it('rejects deleting a terminal-loss retained proof and widening the final gate', () => {
    const changed = clone(terminalValid);
    const loss = changed.searches[0]!.candidates.find(candidate => (
      candidate.extension?.method === 'terminal-only-loss-proof' && candidate.extension.proven === 'loss'
    ))!;
    const lossId = jevMoveId(loss.move);
    changed.retainedProofs = changed.retainedProofs!.filter(proof => proof.id !== lossId);
    const eligible = changed.searches.at(-1)!.candidates.map(candidate => jevMoveId(candidate.move));
    const retained = new Map(changed.retainedProofs.map(proof => [proof.id, proof.proven]));
    const widened = eligible.filter(id => retained.get(id) !== 'loss');
    changed.gates.at(-1)!.candidates = widened;
    changed.gates.at(-1)!.excluded = eligible.filter(id => !widened.includes(id));

    expect(() => verifyJevTrace(changed)).toThrow('invalid-retained-proof');
  });

  it('rejects a legal adverse PV that does not prove every SELF defense loses', () => {
    const changed = clone(terminalValid);
    const candidate = changed.searches[0]!.candidates.find(item => jevMoveId(item.move) === 'p_3_4')!;
    expect(candidate.extension).toMatchObject({ method: 'terminal-only-loss-proof', proven: 'unknown' });
    const adverse = [
      place([3, 4]), move([4, 5], [3, 6]), move([2, 3], [3, 2]), move([3, 6], [2, 7]),
      move([3, 2], [4, 2]), move([2, 7], [1, 6]), move([4, 2], [5, 2]), move([1, 6], [0, 5]),
    ];
    let terminal = changed.snapshot;
    for (const move of adverse) {
      expect(legalMoves(terminal, changed.config)).toContainEqual(move);
      terminal = applyMove(terminal, move);
    }
    const proof = { ...getResult(terminal, changed.config)!, plies: adverse.length };
    expect(proof).toEqual({ winner: 'BLACK', reason: 'goal', plies: 8 });
    const fakeHorizon = structuredClone(candidate.afterFacts);
    fakeHorizon.terminal = { winner: proof.winner, reason: proof.reason };
    candidate.extension = {
      ...candidate.extension!,
      searchedDepth: 8,
      completed: true,
      stopReason: 'complete',
      proven: 'loss',
      proof,
      principalVariation: adverse,
      horizonFacts: fakeHorizon,
    };
    candidate.proven = 'loss';
    candidate.proof = proof;
    candidate.proofSearchedDepth = 8;
    candidate.principalVariation = adverse;
    candidate.horizonFacts = fakeHorizon;
    changed.retainedProofs!.push({
      id: 'p_3_4', proven: 'loss', proof, searchedDepth: 8, sourceSearch: 0,
      principalVariation: adverse,
    });
    const eligible = changed.searches[0]!.candidates.map(item => jevMoveId(item.move));
    const retained = new Map(changed.retainedProofs!.map(item => [item.id, item.proven]));
    const unresolved = eligible.filter(id => retained.get(id) !== 'loss');
    changed.gates.at(-1)!.candidates = unresolved;
    changed.gates.at(-1)!.excluded = eligible.filter(id => !unresolved.includes(id));

    expect(() => verifyJevTrace(changed)).toThrow('invalid-extension-pv');
  });

  it('rejects terminal-proof promotion, horizon, node-budget, and final-gate metadata tampering', () => {
    const edits: Array<(trace: ParallelTurnTrace) => void> = [
      trace => {
        const candidate = trace.searches[0]!.candidates.find(item => item.extension?.proven === 'loss')!;
        candidate.proofSearchedDepth = 6;
      },
      trace => {
        const candidate = trace.searches[0]!.candidates.find(item => item.extension?.proven === 'loss')!;
        candidate.horizonFacts = candidate.afterFacts;
      },
      trace => { trace.searches[0]!.extension.nodes = 100_001; },
      trace => {
        const ids = trace.searches.at(-1)!.candidates.map(candidate => jevMoveId(candidate.move));
        trace.gates.at(-1)!.candidates = ids;
        trace.gates.at(-1)!.excluded = [];
      },
    ];
    for (const edit of edits) {
      const changed = clone(terminalValid);
      edit(changed);
      expect(() => verifyJevTrace(changed)).toThrow();
    }
  });

  it.each(['parallel-v4', 'parallel-v5', 'parallel-v6', 'parallel-v7', 'parallel-v9', 'parallel-v14', 'parallel-v15', 'parallel-v16', 'parallel-v17'] as const)('still replays legacy %s traces after a policy upgrade', (version) => {
    const legacy = clone(valid);
    stripV17TerminalProofs(legacy);
    (legacy.policy as { version: string }).version = version;
    delete legacy.coverage;
    delete legacy.retainedProofs;
    expect(verifyJevTrace(legacy).selectionId).toBe(valid.selection?.id);
  });

  it('audits the classical record, candidate coverage and exact briefing seen by final JEV', () => {
    const trace = clone(valid);
    const move = legalMoves(trace.snapshot, trace.config).find(m => jevMoveId(m) === trace.selection!.id)!;
    const proposal = analyzeJevSearchProposal(trace.snapshot, trace.config, { deadlineMs: Date.now() + 100,
      choose: (_state, _rules, options) => {
        options?.onSearchComplete?.({ nodes: 1, completedDepth: 1, elapsedMs: 1, aborted: false });
        options?.onContinuation?.([move]); return move;
      } })!;
    trace.searchProposal = proposal;
    delete trace.searchProposalOmission;
    trace.searchProposalStartedAt = Date.parse(trace.startedAt) + 10;
    trace.searchProposalDeadlineMs = trace.searchProposalStartedAt + proposal.limits.maxMs;
    trace.timings.searchProposalMs = 1;
    trace.coverage!.push({ id: proposal.id, role: 'classical-search', probability: null, category: 'search-proposal' });
    trace.proposals.find(p => p.id === proposal.id)!.roles.push('coverage-classical-search');
    (trace.stages.find(s => s.phase === 'final')!.request.state as any).searchProposal = briefJevSearchProposal(proposal);
    expect(() => verifyJevTrace(trace)).not.toThrow();
    const edits: Array<(t: ParallelTurnTrace) => void> = [
      t => { delete t.searchProposal; },
      t => { t.searchProposal = null; },
      t => { delete (t.stages.find(s => s.phase === 'final')!.request.state as any).searchProposal; },
      t => { (t.stages.find(s => s.phase === 'final')!.request.state as any).searchProposal.id = 'p_99_99'; },
      t => { t.coverage = t.coverage!.filter(c => c.category !== 'search-proposal'); },
      t => { t.proposals.find(p => p.id === proposal.id)!.roles = ['general']; },
    ];
    for (const edit of edits) {
      const changed = clone(trace); edit(changed);
      expect(() => verifyJevTrace(changed)).toThrow('invalid-search-proposal');
    }
  });

  it('replays pressure examples, conditional captures, and every checked next reply', () => {
    const trace = recordedPressureTrace(valid);
    expect(trace.pressure?.complete).toBe(true);
    expect(trace.pressure?.candidates.some((candidate) => candidate.examples.length > 0)).toBe(true);
    expect(verifyJevTrace(trace)).toMatchObject({ ply: 6, status: 'error', selectionId: null });
  });

  it('rechecks offensive capture threats and rejects an altered opponent escape claim', () => {
    const trace = recordedPressureTrace(valid);
    const next = lossRecord.moves[6]!;
    trace.snapshot = applyMove(trace.snapshot, next);
    trace.ply++;
    trace.stateHash = jevStateHash(trace.snapshot);
    delete trace.pressure;
    const move = legalMoves(trace.snapshot, trace.config).find((m) => jevMoveId(m) === 'p_3_3')!;
    trace.initiative = analyzeJevInitiative(trace.snapshot, trace.config, [move], {
      deadlineMs: Date.now() + 2_000, maxNodes: 10_000,
    });
    expect(trace.initiative.candidates[0]?.directCaptureThreat).toBe(true);
    expect(() => verifyJevTrace(trace)).not.toThrow();
    trace.initiative.candidates[0]!.safeResponses[0]!.advancesRow = true;
    expect(() => verifyJevTrace(trace)).toThrowError('invalid-initiative');
  });

  it('requires offensive facts for every final v8 choice but permits incomplete error traces', () => {
    const historical = clone(valid);
    stripV17TerminalProofs(historical);
    (historical.policy as { version: string }).version = 'parallel-v8';
    const ids = historical.gates.at(-1)!.candidates;
    historical.initiative = analyzeJevInitiative(historical.snapshot, historical.config,
      legalMoves(historical.snapshot, historical.config).filter((m) => ids.includes(jevMoveId(m)))
        .sort((a, b) => ids.indexOf(jevMoveId(a)) - ids.indexOf(jevMoveId(b))),
      { deadlineMs: Date.now() + 2_000, maxNodes: 10_000 });
    expect(() => verifyJevTrace(historical)).not.toThrow();
    const absent = clone(historical);
    delete absent.initiative;
    expect(() => verifyJevTrace(absent)).toThrowError('invalid-initiative');
    absent.status = 'error';
    expect(() => verifyJevTrace(absent)).not.toThrow();
    const subset = clone(historical);
    subset.initiative!.candidates = subset.initiative!.candidates.slice(1);
    expect(() => verifyJevTrace(subset)).toThrowError('invalid-initiative');
  });

  it('rejects tampered pressure replies and conditional capture threats', () => {
    const replyTampered = recordedPressureTrace(valid);
    const replyExample = replyTampered.pressure!.candidates.flatMap((candidate) => candidate.examples)[0]!;
    replyExample.opponentReply = illegalMove;
    expect(() => verifyJevTrace(replyTampered)).toThrowError('invalid-pressure');

    const captureTampered = recordedPressureTrace(valid);
    const captureExample = captureTampered.pressure!.candidates.flatMap((candidate) => candidate.examples)[0]!;
    captureExample.captureThreatsIfUnanswered[0] = illegalMove;
    expect(() => verifyJevTrace(captureTampered)).toThrowError('invalid-pressure');
  });

  it('rejects a response falsely recorded safe despite an immediate winning counter', () => {
    const tampered = recordedPressureTrace(valid);
    const candidate = tampered.pressure!.candidates.find((entry) => entry.examples.length > 0)!;
    const example = candidate.examples[0]!;
    const root = tampered.snapshot;
    const candidateMove = legalMoves(root, tampered.config)
      .find((move) => jevMoveId(move) === candidate.id)!;
    const after = applyMove(root, candidateMove);
    const reply = legalMoves(after, tampered.config)
      .find((move) => jevMoveId(move) === jevMoveId(example.opponentReply))!;
    const threatened = applyMove(after, reply);
    const unsafe = legalMoves(threatened, tampered.config).find((response) => {
      const escaped = applyMove(threatened, response);
      return legalMoves(escaped, tampered.config).some((counter) =>
        getResult(applyMove(escaped, counter), tampered.config)?.winner === after.turn);
    })!;
    expect(unsafe).toBeDefined();
    example.safeResponses[0] = {
      move: unsafe,
      action: unsafe.kind === 'MOVE'
        && threatened.board[unsafe.from.r]?.[unsafe.from.c]?.type === 'KING' ? 'king' : 'guard',
      advancesRow: false,
      immediateWin: false,
    };
    expect(() => verifyJevTrace(tampered)).toThrowError('invalid-pressure');
  });

  it('rejects retained terminal evidence without a matching source search', () => {
    const tampered = clone(valid);
    const candidate = tampered.searches[0]!.candidates[0]!;
    tampered.retainedProofs = [{ id: jevMoveId(candidate.move), proven: 'loss',
      proof: { winner: 'WHITE', reason: 'goal', plies: 4 }, searchedDepth: 4,
      sourceSearch: 0, principalVariation: candidate.principalVariation }];
    expect(() => verifyJevTrace(tampered)).toThrowError('invalid-retained-proof');
  });

  it('rejects a jointly tampered source and retained proof whose legal PV is non-terminal', () => {
    const tampered = clone(valid);
    stripV17TerminalProofs(tampered);
    (tampered.policy as { version: string }).version = 'parallel-v16';
    const candidate = tampered.searches[0]!.candidates.find((item) => item.proven === 'unknown')!;
    const proof = { winner: 'WHITE' as const, reason: 'goal' as const,
      plies: candidate.principalVariation.length };
    candidate.proven = 'loss';
    candidate.proof = proof;
    candidate.proofSearchedDepth = candidate.searchedDepth;
    tampered.retainedProofs = [{ id: jevMoveId(candidate.move), proven: 'loss', proof,
      searchedDepth: candidate.searchedDepth, sourceSearch: 0,
      principalVariation: candidate.principalVariation }];

    expect(() => verifyJevTrace(tampered)).toThrowError('invalid-retained-proof');
  });

  it('rejects a tampered root hash or serialized snapshot position', () => {
    const hashTampered = clone(valid);
    hashTampered.stateHash = '0'.repeat(64);
    expect(() => verifyJevTrace(hashTampered)).toThrowError(JevTraceVerificationError);

    const snapshotTampered = clone(valid);
    snapshotTampered.snapshot.turn = 'WHITE';
    expect(() => verifyJevTrace(snapshotTampered)).toThrowError('root-mismatch');
  });

  it('rejects an illegal candidate PV and an illegal extension PV', () => {
    const candidateTampered = clone(valid);
    const candidate = candidateTampered.searches[0]!.candidates[0]!;
    candidate.principalVariation = [illegalMove];
    expect(() => verifyJevTrace(candidateTampered)).toThrowError('invalid-search-pv');

    const extensionTampered = clone(valid);
    const extended = extensionTampered.searches[0]!.candidates[0]!;
    extended.extension = {
      principalVariation: [illegalMove],
    } as NonNullable<typeof extended.extension>;
    expect(() => verifyJevTrace(extensionTampered)).toThrowError('invalid-extension-pv');
  });

  it('rejects a jev-final trace when the saved final API answer differs from the selection', () => {
    const tampered = clone(valid);
    expect(tampered.selection?.source).toBe('jev-final');
    const final = tampered.stages.find((stage) => stage.phase === 'final')!;
    const response = final.response as { answers: { move: { choice: string } } };
    response.answers.move.choice = 'different-saved-choice';
    expect(() => verifyJevTrace(tampered)).toThrowError('final-answer-mismatch');
  });

  it('accepts failed traces without a move and treats an error trace with a valid selection as unapplied', () => {
    const noMove = clone(valid);
    noMove.status = 'error';
    noMove.error = 'http_error';
    delete noMove.selection;
    delete noMove.expectedAfterHash;
    delete noMove.appliedStateHash;
    expect(verifyJevTrace(noMove)).toMatchObject({ selectionId: null, applied: false });

    const selectedError = clone(valid);
    selectedError.status = 'error';
    selectedError.error = 'recording_failed';
    delete selectedError.appliedStateHash;
    expect(verifyJevTrace(selectedError)).toMatchObject({
      selectionId: valid.selection?.id,
      applied: false,
    });
  });

  it('validates applied hashes but does not require one for a cancelled selection', () => {
    const applied = clone(valid);
    applied.status = 'applied';
    applied.appliedStateHash = applied.expectedAfterHash;
    expect(verifyJevTrace(applied).applied).toBe(true);

    applied.appliedStateHash = 'tampered';
    expect(() => verifyJevTrace(applied)).toThrowError('after-hash-mismatch');

    const cancelled = clone(valid);
    cancelled.status = 'cancelled';
    delete cancelled.appliedStateHash;
    expect(verifyJevTrace(cancelled).applied).toBe(false);
  });

  it('audits conditional rollout outcomes and requires every final candidate and policy budget', () => {
    expect(valid.rollouts?.candidates.length).toBe(valid.gates.at(-1)?.candidates.length);
    const missing = clone(valid); delete missing.rollouts;
    expect(() => verifyJevTrace(missing)).toThrowError('invalid-rollouts');
    const subset = clone(valid); subset.rollouts!.candidates.pop();
    expect(() => verifyJevTrace(subset)).toThrowError('invalid-rollouts');
    const noGate = clone(valid); noGate.gates = [];
    expect(() => verifyJevTrace(noGate)).toThrowError('invalid-extension-pv');
    const alteredBudget = clone(valid); alteredBudget.rollouts!.limits.maxNodesPerDecision = 1;
    expect(() => verifyJevTrace(alteredBudget)).toThrowError('invalid-rollouts');
    const alteredCriteria = clone(valid);
    const question = alteredCriteria.stages.find(stage => stage.phase === 'final')!.request.questions.move!;
    if (question.type === 'choice') delete question.criteria[Object.keys(question.criteria)[0]!];
    expect(() => verifyJevTrace(alteredCriteria)).toThrowError('invalid-rollouts');
    const altered = clone(valid);
    const terminal = altered.rollouts!.candidates[0]!.scenarios[0]!;
    terminal.terminal = { winner: 'BLACK', reason: 'goal' };
    terminal.status = 'terminal';
    expect(() => verifyJevTrace(altered)).toThrowError('invalid-rollouts');
    const illegal = clone(valid);
    illegal.rollouts!.candidates[0]!.scenarios[0]!.line[0] = illegalMove;
    expect(() => verifyJevTrace(illegal)).toThrowError('invalid-rollouts');
  });

  it('accepts storage reordering of choice-object keys without changing candidate membership', () => {
    const reordered = clone(valid);
    const question = reordered.stages.find(s => s.phase === 'final')!.request.questions.move!;
    if (question.type === 'choice') question.criteria = Object.fromEntries(Object.entries(question.criteria).reverse());
    expect(() => verifyJevTrace(reordered)).not.toThrow();
  });

  it('rejects unsupported policy metadata, invalid selection sources, and selected traces without a selection', () => {
    const versionTampered = clone(valid);
    (versionTampered.policy as { version: string }).version = 'parallel-unknown';
    expect(() => verifyJevTrace(versionTampered)).toThrowError('invalid-trace');

    const policyTampered = clone(valid);
    policyTampered.policy = {
      ...policyTampered.policy,
      protocolVersion: 999,
    } as unknown as typeof policyTampered.policy;
    expect(() => verifyJevTrace(policyTampered)).toThrowError('invalid-trace');

    const sourceTampered = clone(valid);
    sourceTampered.selection!.source = 'untrusted' as NonNullable<ParallelTurnTrace['selection']>['source'];
    expect(() => verifyJevTrace(sourceTampered)).toThrowError('invalid-selection');

    const selectedWithoutMove = clone(valid);
    delete selectedWithoutMove.selection;
    delete selectedWithoutMove.expectedAfterHash;
    expect(() => verifyJevTrace(selectedWithoutMove)).toThrowError('invalid-selection');
  });

  it('rejects a PV that continues after a canonical terminal move', () => {
    const turns: Move[] = [
      { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 5 } },
      { kind: 'MOVE', from: { r: 0, c: 4 }, to: { r: 0, c: 3 } },
      { kind: 'MOVE', from: { r: 7, c: 5 }, to: { r: 6, c: 5 } },
      { kind: 'MOVE', from: { r: 0, c: 3 }, to: { r: 0, c: 2 } },
      { kind: 'MOVE', from: { r: 6, c: 5 }, to: { r: 5, c: 5 } },
      { kind: 'MOVE', from: { r: 0, c: 2 }, to: { r: 0, c: 1 } },
      { kind: 'MOVE', from: { r: 5, c: 5 }, to: { r: 4, c: 5 } },
      { kind: 'MOVE', from: { r: 0, c: 1 }, to: { r: 1, c: 1 } },
      { kind: 'MOVE', from: { r: 4, c: 5 }, to: { r: 3, c: 5 } },
      { kind: 'MOVE', from: { r: 1, c: 1 }, to: { r: 1, c: 2 } },
      { kind: 'MOVE', from: { r: 3, c: 5 }, to: { r: 2, c: 5 } },
      { kind: 'MOVE', from: { r: 1, c: 2 }, to: { r: 0, c: 2 } },
      { kind: 'MOVE', from: { r: 2, c: 5 }, to: { r: 1, c: 5 } },
      { kind: 'MOVE', from: { r: 0, c: 2 }, to: { r: 0, c: 1 } },
    ];
    let root = initialState(DEFAULT_CONFIG);
    for (const move of turns) {
      expect(legalMoves(root, DEFAULT_CONFIG)).toContainEqual(move);
      root = applyMove(root, move);
    }
    const winningMove: Move = { kind: 'MOVE', from: { r: 1, c: 5 }, to: { r: 0, c: 5 } };
    const terminal = applyMove(root, winningMove);
    const afterTerminal = legalMoves(terminal, DEFAULT_CONFIG)[0]!;

    const tampered = clone(valid);
    tampered.ply = root.history.length;
    tampered.snapshot = root;
    tampered.stateHash = jevStateHash(root);
    tampered.status = 'error';
    delete tampered.selection;
    delete tampered.expectedAfterHash;
    const candidate = tampered.searches[0]!.candidates[0]!;
    candidate.move = winningMove;
    candidate.principalVariation = [winningMove, afterTerminal];
    tampered.searches = [{ ...tampered.searches[0]!, candidates: [candidate] }];
    expect(() => verifyJevTrace(tampered)).toThrowError('invalid-search-pv');

    const terminalSelection = clone(valid);
    terminalSelection.ply = terminal.history.length;
    terminalSelection.snapshot = terminal;
    terminalSelection.stateHash = jevStateHash(terminal);
    terminalSelection.status = 'selected';
    terminalSelection.selection = {
      id: jevMoveId(afterTerminal),
      source: 'engine-single-candidate',
      proposedBy: [],
    };
    terminalSelection.expectedAfterHash = jevStateHash(applyMove(terminal, afterTerminal));
    terminalSelection.searches = [];
    expect(() => verifyJevTrace(terminalSelection)).toThrowError('invalid-selection');
  });
});

it('CLI requires an explicit mock or live mode', async () => {
  await expect(main(['--out', '/tmp/unused-jev-trace.jsonl'])).rejects.toThrow(
    'Choose exactly one of --mock or --live',
  );
});
