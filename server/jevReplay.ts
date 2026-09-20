import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { initialState, legalMoves } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import type { ParallelTurnTrace } from './jevParallel';
import { JEV_PARALLEL_POLICY, jevMoveId, jevStateHash } from './jevPolicy';

export type JevTraceVerificationErrorCode =
  | 'invalid-trace'
  | 'invalid-config'
  | 'invalid-history'
  | 'root-mismatch'
  | 'invalid-selection'
  | 'after-hash-mismatch'
  | 'invalid-search-pv'
  | 'invalid-extension-pv'
  | 'final-answer-mismatch';

export class JevTraceVerificationError extends Error {
  constructor(readonly code: JevTraceVerificationErrorCode) {
    super(`JEV trace verification failed: ${code}`);
    this.name = 'JevTraceVerificationError';
  }
}

export interface JevTraceVerificationResult {
  turnId: string;
  gameId: string;
  ply: number;
  stateHash: string;
  status: ParallelTurnTrace['status'];
  selectionId: string | null;
  applied: boolean;
  searches: number;
  candidateVariations: number;
  extensionVariations: number;
}

function fail(code: JevTraceVerificationErrorCode): never {
  throw new JevTraceVerificationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoord(value: unknown): value is { r: number; c: number } {
  return isRecord(value)
    && Number.isSafeInteger(value.r)
    && Number.isSafeInteger(value.c);
}

function isMove(value: unknown): value is Move {
  if (!isRecord(value) || !isCoord(value.to)) return false;
  return value.kind === 'PLACE'
    ? !Object.hasOwn(value, 'from')
    : value.kind === 'MOVE' && isCoord(value.from);
}

function isConfig(value: unknown): value is RuleConfig {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.boardSize)
    && (value.boardSize as number) >= 3
    && (value.boardSize as number) <= 25
    && Number.isSafeInteger(value.guardCount)
    && (value.guardCount as number) >= 0
    && (value.guardCount as number) <= 625
    && ['full-row', 'center-3', 'center-1'].includes(value.goalCells as string)
    && ['adjacent', 'own-half'].includes(value.placement as string)
    && ['step', 'slide'].includes(value.guardMove as string)
    && typeof value.kingSurroundLoss === 'boolean'
    && typeof value.noGuardOnGoal === 'boolean'
    && typeof value.kingCapture === 'boolean';
}

function canonicalMove(state: GameState, config: RuleConfig, value: unknown): Move | null {
  if (!isMove(value)) return null;
  const id = jevMoveId(value);
  return legalMoves(state, config).find((move) => jevMoveId(move) === id) ?? null;
}

function replayVariation(
  root: GameState,
  config: RuleConfig,
  candidate: unknown,
  variation: unknown,
  code: 'invalid-search-pv' | 'invalid-extension-pv',
): void {
  if (!isMove(candidate) || !Array.isArray(variation) || variation.length === 0
      || variation.length > JEV_PARALLEL_POLICY.maxPlies) fail(code);
  if (!isMove(variation[0]) || jevMoveId(variation[0]) !== jevMoveId(candidate)) fail(code);

  let state = root;
  for (const savedMove of variation) {
    if (getResult(state, config)) fail(code);
    const move = canonicalMove(state, config, savedMove);
    if (!move) fail(code);
    state = applyMove(state, move);
  }
}

function snapshotHash(snapshot: unknown): string {
  if (!isRecord(snapshot)) fail('root-mismatch');
  try {
    return jevStateHash(snapshot as unknown as GameState);
  } catch {
    return fail('root-mismatch');
  }
}

function finalResponseChoice(trace: ParallelTurnTrace): string | null {
  const finalStages = trace.stages.filter((stage) => stage.phase === 'final');
  if (finalStages.length !== 1) return null;
  const response = finalStages[0]!.response;
  if (!isRecord(response) || !isRecord(response.answers) || !isRecord(response.answers.move)) return null;
  return typeof response.answers.move.choice === 'string' ? response.answers.move.choice : null;
}

/** Replays all decision-bearing moves from canonical rules and rejects altered traces. */
export function verifyJevTrace(trace: ParallelTurnTrace): JevTraceVerificationResult {
  if (!isRecord(trace) || !isConfig(trace.config) || !isRecord(trace.snapshot)) {
    fail(!isRecord(trace) ? 'invalid-trace' : 'invalid-config');
  }
  if (!Array.isArray(trace.snapshot.history)
      || trace.snapshot.history.length > JEV_PARALLEL_POLICY.maxPlies
      || !Number.isSafeInteger(trace.ply)
      || trace.ply !== trace.snapshot.history.length) fail('invalid-history');
  if (!['running', 'selected', 'applied', 'error', 'cancelled'].includes(trace.status)) fail('invalid-trace');
  if (!Array.isArray(trace.searches) || !Array.isArray(trace.stages)) fail('invalid-trace');
  if (!isRecord(trace.policy)
      || trace.policy.version !== JEV_PARALLEL_POLICY.version
      || trace.policy.rulesVersion !== JEV_PARALLEL_POLICY.rulesVersion
      || trace.policy.protocolVersion !== JEV_PARALLEL_POLICY.protocolVersion) fail('invalid-trace');

  let root = initialState(trace.config);
  for (const savedMove of trace.snapshot.history) {
    if (getResult(root, trace.config)) fail('invalid-history');
    const move = canonicalMove(root, trace.config, savedMove);
    if (!move) fail('invalid-history');
    root = applyMove(root, move);
  }

  const rootHash = jevStateHash(root);
  if (typeof trace.stateHash !== 'string'
      || trace.stateHash !== rootHash
      || snapshotHash(trace.snapshot) !== rootHash) fail('root-mismatch');

  let selectionId: string | null = null;
  let expectedAfterHash: string | null = null;
  if (trace.selection !== undefined) {
    if (!isRecord(trace.selection)
        || typeof trace.selection.id !== 'string'
        || !['engine-immediate-win', 'engine-single-candidate', 'jev-final'].includes(trace.selection.source as string)) {
      fail('invalid-selection');
    }
    if (getResult(root, trace.config)) fail('invalid-selection');
    const selected = legalMoves(root, trace.config).find((move) => jevMoveId(move) === trace.selection!.id);
    if (!selected) fail('invalid-selection');
    selectionId = trace.selection.id;
    expectedAfterHash = jevStateHash(applyMove(root, selected));
    if (typeof trace.expectedAfterHash !== 'string' || trace.expectedAfterHash !== expectedAfterHash) {
      fail('after-hash-mismatch');
    }
    if (trace.selection.source === 'jev-final' && finalResponseChoice(trace) !== trace.selection.id) {
      fail('final-answer-mismatch');
    }
  } else if (trace.expectedAfterHash !== undefined
      || trace.appliedStateHash !== undefined
      || trace.status === 'selected'
      || trace.status === 'applied') {
    fail('invalid-selection');
  }

  if (trace.appliedStateHash !== undefined
      && (typeof trace.appliedStateHash !== 'string' || trace.appliedStateHash !== expectedAfterHash)) {
    fail('after-hash-mismatch');
  }
  if (trace.status === 'applied' && trace.appliedStateHash !== expectedAfterHash) fail('after-hash-mismatch');

  let candidateVariations = 0;
  let extensionVariations = 0;
  for (const search of trace.searches) {
    if (!isRecord(search) || !Array.isArray(search.candidates)) fail('invalid-trace');
    for (const candidate of search.candidates) {
      if (!isRecord(candidate)) fail('invalid-search-pv');
      replayVariation(root, trace.config, candidate.move, candidate.principalVariation, 'invalid-search-pv');
      candidateVariations += 1;
      if (candidate.extension !== null && candidate.extension !== undefined) {
        if (!isRecord(candidate.extension)) fail('invalid-extension-pv');
        replayVariation(root, trace.config, candidate.move, candidate.extension.principalVariation, 'invalid-extension-pv');
        extensionVariations += 1;
      }
    }
  }

  return {
    turnId: trace.turnId,
    gameId: trace.gameId,
    ply: trace.ply,
    stateHash: rootHash,
    status: trace.status,
    selectionId,
    applied: trace.status === 'applied',
    searches: trace.searches.length,
    candidateVariations,
    extensionVariations,
  };
}
