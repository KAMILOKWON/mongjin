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
  trace.pressure = analyzeJevPressure(state, DEFAULT_CONFIG, moves, {
    deadlineMs: Date.now() + 5_000,
    maxNodes: JEV_PARALLEL_POLICY.pressureMaxNodes,
  });
  return trace;
}

describe('verifyJevTrace', () => {
  let valid: ParallelTurnTrace;

  beforeAll(async () => {
    const result = await chooseParallelJevMove({
      gameId: 'replay-test',
      state: initialState(DEFAULT_CONFIG),
      config: DEFAULT_CONFIG,
      apiKey: 'test-only-key',
      deadlineMs: Date.now() + JEV_PARALLEL_POLICY.turnLimitMs,
      evaluate: mockEvaluateJev,
    });
    valid = result.trace;
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

  it.each(['parallel-v4', 'parallel-v5', 'parallel-v6', 'parallel-v7'] as const)('still replays legacy %s traces after a policy upgrade', (version) => {
    const legacy = clone(valid);
    (legacy.policy as { version: string }).version = version;
    delete legacy.coverage;
    delete legacy.retainedProofs;
    expect(verifyJevTrace(legacy).selectionId).toBe(valid.selection?.id);
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
