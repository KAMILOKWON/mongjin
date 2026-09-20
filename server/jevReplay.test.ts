import { beforeAll, describe, expect, it } from 'vitest';
import { applyMove } from '../src/core/apply';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import type { Move } from '../src/core/types';
import { chooseParallelJevMove, type ParallelTurnTrace } from './jevParallel';
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
