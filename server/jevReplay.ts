import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, initialState, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import type { ParallelTurnTrace } from './jevParallel';
import { analyzeJevInitiative } from './jevInitiative';
import { verifyJevRolloutEvidence } from './jevRolloutReplay';
import { JEV_PARALLEL_POLICY, jevMoveId, jevStateHash } from './jevPolicy';
import { briefJevSearchProposal, verifyJevSearchProposal } from './jevSearchProposal';
import { proveJevTerminalLosses } from './jevTerminalProof';
import { isDeepStrictEqual } from 'node:util';
import { JevError } from './jev';
import { isTransientJevApiError, JEV_API_RETRY_POLICY } from './jevApiRetry';

// v8 was a local experiment; retain its evidence audit after restoring the v7 briefing.
const MAX_RECORDED_INITIATIVE_NODES = 10_000;

export type JevTraceVerificationErrorCode =
  | 'invalid-trace'
  | 'invalid-config'
  | 'invalid-history'
  | 'root-mismatch'
  | 'invalid-selection'
  | 'after-hash-mismatch'
  | 'invalid-search-pv'
  | 'invalid-extension-pv'
  | 'invalid-retained-proof'
  | 'invalid-search-proposal'
  | 'invalid-pressure'
  | 'invalid-initiative'
  | 'invalid-rollouts'
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
  code: 'invalid-search-pv' | 'invalid-extension-pv' | 'invalid-retained-proof',
): GameState {
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
  return state;
}

function sameVariation(left: Move[], right: Move[]): boolean {
  return left.length === right.length
    && left.every((move, index) => jevMoveId(move) === jevMoveId(right[index]!));
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

function verifyApiAttempts(trace: ParallelTurnTrace): void {
  for (const stage of trace.stages) {
    if (!isRecord(stage)) fail('invalid-trace');
    if (stage.attempts === undefined && (trace.policy as { version: string }).version !== 'parallel-v19') continue;
    if (!Array.isArray(stage.attempts) || stage.attempts.length > JEV_API_RETRY_POLICY.delaysMs.length + 1) fail('invalid-trace');
    for (const [index, attempt] of stage.attempts.entries()) {
      if (!isRecord(attempt) || attempt.attempt !== index + 1
        || typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt))
        || !Number.isFinite(attempt.deadlineMs) || attempt.deadlineMs > trace.deadlineMs
        || Date.parse(attempt.startedAt) >= attempt.deadlineMs
        || (attempt.elapsedMs !== undefined && (!Number.isFinite(attempt.elapsedMs) || attempt.elapsedMs < 0))) fail('invalid-trace');
      if (index > 0 && attempt.deadlineMs !== stage.attempts[0]!.deadlineMs) fail('invalid-trace');
      if (index < stage.attempts.length - 1 && (attempt.result !== undefined
        || !isTransientJevApiError(new JevError(attempt.error!, 'recorded failure', attempt.httpStatus)))) fail('invalid-trace');
    }
    if (stage.result !== undefined) {
      const successful = stage.attempts.at(-1);
      const interruptedAfterResponse = ['error', 'cancelled'].includes(trace.status)
        && (stage.error === 'timeout' || stage.error === 'aborted');
      if (!successful || successful.error !== undefined || (stage.error !== undefined && !interruptedAfterResponse)
        || !isDeepStrictEqual(stage.response, successful.response)
        || !isDeepStrictEqual(stage.result, successful.result)) fail('invalid-trace');
    }
  }
}

function verifyPressure(trace: ParallelTurnTrace, root: GameState): void {
  if (trace.pressure === undefined) return;
  const pressure: unknown = trace.pressure;
  if (!isRecord(pressure)
      || pressure.scope !== 'opponent-capture-threats-and-next-reply-safety'
      || typeof pressure.complete !== 'boolean'
      || !['complete', 'deadline', 'node-budget', 'aborted'].includes(pressure.stopReason as string)
      || !Number.isSafeInteger(pressure.nodes) || (pressure.nodes as number) < 0
      || (pressure.nodes as number) > JEV_PARALLEL_POLICY.pressureMaxNodes
      || !Array.isArray(pressure.candidates)
      || pressure.candidates.length > legalMoves(root, trace.config).length
      || pressure.complete !== (pressure.stopReason === 'complete')) fail('invalid-pressure');

  const self = root.turn;
  const enemy = opponent(self);
  const rootMoves = new Map(legalMoves(root, trace.config).map((move) => [jevMoveId(move), move]));
  const seenCandidates = new Set<string>();
  for (const savedCandidate of pressure.candidates) {
    if (!isRecord(savedCandidate)
        || typeof savedCandidate.id !== 'string'
        || seenCandidates.has(savedCandidate.id)
        || typeof savedCandidate.complete !== 'boolean'
        || !Number.isSafeInteger(savedCandidate.checkedOpponentReplies)
        || !Number.isSafeInteger(savedCandidate.totalOpponentReplies)
        || !Number.isSafeInteger(savedCandidate.threatsFound)
        || (savedCandidate.checkedOpponentReplies as number) < 0
        || (savedCandidate.totalOpponentReplies as number) < 0
        || (savedCandidate.threatsFound as number) < 0
        || !Array.isArray(savedCandidate.examples)
        || savedCandidate.examples.length > 3) fail('invalid-pressure');
    seenCandidates.add(savedCandidate.id);

    const candidate = rootMoves.get(savedCandidate.id);
    if (!candidate) fail('invalid-pressure');
    const after = applyMove(root, candidate);
    const terminal = getResult(after, trace.config);
    const replies = terminal ? [] : legalMoves(after, trace.config);
    const checkedReplies = savedCandidate.checkedOpponentReplies as number;
    const totalReplies = savedCandidate.totalOpponentReplies as number;
    const threatsFound = savedCandidate.threatsFound as number;
    // A halted analysis can record the candidate before its first apply, leaving
    // all counters at zero. Once any detail is present, the legal reply total is known.
    const untouchedIncomplete = !savedCandidate.complete && checkedReplies === 0
      && totalReplies === 0 && threatsFound === 0 && savedCandidate.examples.length === 0;
    if ((!untouchedIncomplete && totalReplies !== replies.length)
        || checkedReplies > totalReplies
        || threatsFound > totalReplies
        || threatsFound < savedCandidate.examples.length
        || (savedCandidate.complete && checkedReplies !== totalReplies)
        || (pressure.complete && !savedCandidate.complete)
        || (terminal && (checkedReplies !== 0 || totalReplies !== 0
          || threatsFound !== 0 || savedCandidate.examples.length !== 0))) fail('invalid-pressure');

    if (savedCandidate.complete) {
      let actualThreats = 0;
      for (const reply of replies) {
        const threatened = applyMove(after, reply);
        if (getResult(threatened, trace.config)) continue;
        const king = findKing(threatened, self);
        if (!king) fail('invalid-pressure');
        const virtualEnemyTurn = { ...threatened, turn: enemy };
        if (legalMoves(virtualEnemyTurn, trace.config).some((move) =>
          move.kind === 'MOVE' && move.to.r === king.r && move.to.c === king.c)) actualThreats++;
      }
      if (threatsFound !== actualThreats) fail('invalid-pressure');
    }

    const seenExamples = new Set<string>();
    for (const savedExample of savedCandidate.examples) {
      if (!isRecord(savedExample)
          || !Array.isArray(savedExample.captureThreatsIfUnanswered)
          || !Array.isArray(savedExample.safeResponses)
          || typeof savedExample.responsesComplete !== 'boolean'
          || !Number.isSafeInteger(savedExample.checkedResponses)
          || !Number.isSafeInteger(savedExample.totalResponses)
          || (savedExample.checkedResponses as number) < 0
          || (savedExample.totalResponses as number) < 0) fail('invalid-pressure');

      const reply = canonicalMove(after, trace.config, savedExample.opponentReply);
      if (!reply) fail('invalid-pressure');
      const replyId = jevMoveId(reply);
      const replyIndex = replies.findIndex((item) => jevMoveId(item) === replyId);
      if (seenExamples.has(replyId) || replyIndex < 0
          || replyIndex > checkedReplies
          || (replyIndex === checkedReplies && savedCandidate.complete)) fail('invalid-pressure');
      seenExamples.add(replyId);

      const threatened = applyMove(after, reply);
      if (getResult(threatened, trace.config)) fail('invalid-pressure');
      const king = findKing(threatened, self);
      if (!king) fail('invalid-pressure');

      // This turn substitution mirrors the analyzer's conditional question:
      // could ENEMY capture the king if SELF failed to answer? It is not a legal
      // pass. Current canonical legality/results ignore history and positionCounts.
      const virtualEnemyTurn = { ...threatened, turn: enemy };
      const captures = legalMoves(virtualEnemyTurn, trace.config).filter((move) =>
        move.kind === 'MOVE' && move.to.r === king.r && move.to.c === king.c);
      if (captures.length === 0 || savedExample.captureThreatsIfUnanswered.length !== captures.length) {
        fail('invalid-pressure');
      }
      for (let i = 0; i < captures.length; i++) {
        const savedCapture = canonicalMove(virtualEnemyTurn, trace.config,
          savedExample.captureThreatsIfUnanswered[i]);
        if (!savedCapture || jevMoveId(savedCapture) !== jevMoveId(captures[i]!)
            || getResult(applyMove(virtualEnemyTurn, savedCapture), trace.config)?.winner !== enemy) {
          fail('invalid-pressure');
        }
      }

      const responses = legalMoves(threatened, trace.config);
      const checkedResponses = savedExample.checkedResponses as number;
      const totalResponses = savedExample.totalResponses as number;
      if (totalResponses !== responses.length || checkedResponses > totalResponses
          || savedExample.responsesComplete !== (checkedResponses === totalResponses)) fail('invalid-pressure');

      const expectedSafe: Array<{ move: Move; action: 'king' | 'guard'; advancesRow: boolean; immediateWin: boolean }> = [];
      for (const response of responses.slice(0, checkedResponses)) {
        const escaped = applyMove(threatened, response);
        const result = getResult(escaped, trace.config);
        let safe = result?.winner === self;
        if (!result) {
          safe = legalMoves(escaped, trace.config).every((counter) =>
            getResult(applyMove(escaped, counter), trace.config)?.winner !== enemy);
        }
        if (!safe) continue;
        const isKing = response.kind === 'MOVE'
          && threatened.board[response.from.r]?.[response.from.c]?.type === 'KING';
        expectedSafe.push({
          move: response,
          action: isKing ? 'king' : 'guard',
          advancesRow: isKing && response.kind === 'MOVE'
            && (self === 'BLACK' ? response.to.r < response.from.r : response.to.r > response.from.r),
          immediateWin: result?.winner === self,
        });
      }
      if (savedExample.safeResponses.length !== expectedSafe.length) fail('invalid-pressure');
      for (let i = 0; i < expectedSafe.length; i++) {
        const saved = savedExample.safeResponses[i];
        const expected = expectedSafe[i]!;
        if (!isRecord(saved)
            || !isMove(saved.move)
            || jevMoveId(saved.move) !== jevMoveId(expected.move)
            || saved.action !== expected.action
            || saved.advancesRow !== expected.advancesRow
            || saved.immediateWin !== expected.immediateWin) fail('invalid-pressure');
      }
    }
  }
  // Deliberately bounded: this authenticates the recorded (at most three)
  // examples and every checked response's next reply. It does not prove that
  // omitted examples cover all strategy or that a response stays safe later.
}

function verifyInitiative(trace: ParallelTurnTrace, root: GameState): void {
  const requiresCoverage = (trace.policy as { version: string }).version === 'parallel-v8'
    && ['selected', 'applied'].includes(trace.status) && trace.selection?.source === 'jev-final';
  if (requiresCoverage) {
    const finalIds = Array.isArray(trace.gates) ? trace.gates.at(-1)?.candidates : undefined;
    const ids = trace.initiative?.candidates?.map((entry) => entry.id);
    if (!Array.isArray(finalIds) || !ids || ids.length !== finalIds.length
        || ids.some((id, index) => id !== finalIds[index])) fail('invalid-initiative');
  }
  if (trace.initiative === undefined) return;
  const saved = trace.initiative;
  if (!isRecord(saved) || saved.version !== 'jev-initiative-v1'
      || saved.scope !== 'direct-offensive-capture-threat-and-opponent-immediate-safety'
      || typeof saved.complete !== 'boolean'
      || !['complete', 'deadline', 'node-budget', 'aborted'].includes(saved.stopReason)
      || saved.complete !== (saved.stopReason === 'complete')
      || !Number.isSafeInteger(saved.nodes) || saved.nodes < 0 || saved.nodes > MAX_RECORDED_INITIATIVE_NODES
      || !Array.isArray(saved.candidates) || !saved.candidates.length) fail('invalid-initiative');
  const canonical = new Map(legalMoves(root, trace.config).map((move) => [jevMoveId(move), move]));
  if (saved.candidates.length > canonical.size) fail('invalid-initiative');
  const seen = new Set<string>();
  for (const entry of saved.candidates) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || seen.has(entry.id) || !canonical.has(entry.id)
        || typeof entry.complete !== 'boolean' || typeof entry.responsesComplete !== 'boolean'
        || ![null, true, false].includes(entry.directCaptureThreat) || entry.laterInitiative !== 'unknown'
        || !Number.isSafeInteger(entry.checkedResponses) || entry.checkedResponses < 0
        || !Number.isSafeInteger(entry.totalResponses) || entry.totalResponses < entry.checkedResponses
        || !Array.isArray(entry.captureThreatsIfUnanswered) || !Array.isArray(entry.safeResponses)
        || entry.complete !== entry.responsesComplete || (saved.complete && !entry.complete)) fail('invalid-initiative');
    seen.add(entry.id);
    if (entry.directCaptureThreat === null) {
      if (entry.complete || entry.checkedResponses || entry.totalResponses
          || entry.captureThreatsIfUnanswered.length || entry.safeResponses.length) fail('invalid-initiative');
      continue;
    }
    // Recheck the concrete bounded facts, not a claimed long-term strategy.
    // A single candidate has at least the node allowance it had in the shared turn budget.
    const move = canonical.get(entry.id)!;
    const expected = analyzeJevInitiative(root, trace.config, [move], {
      deadlineMs: Date.now() + 5_000, maxNodes: MAX_RECORDED_INITIATIVE_NODES,
    }).candidates[0]!;
    if (expected.directCaptureThreat !== entry.directCaptureThreat
        || entry.totalResponses !== expected.totalResponses || entry.checkedResponses > expected.checkedResponses
        || (entry.complete && (!expected.complete || entry.checkedResponses !== expected.checkedResponses))
        || (!entry.directCaptureThreat && !entry.complete)
        || entry.captureThreatsIfUnanswered.length !== expected.captureThreatsIfUnanswered.length
        || entry.captureThreatsIfUnanswered.some((capture, index) => !isMove(capture)
          || jevMoveId(capture) !== jevMoveId(expected.captureThreatsIfUnanswered[index]!))) fail('invalid-initiative');
    const after = applyMove(root, move);
    const checkedIds = new Set(legalMoves(after, trace.config).slice(0, entry.checkedResponses).map(jevMoveId));
    const expectedSafe = expected.safeResponses.filter((response) => checkedIds.has(jevMoveId(response.move)));
    if (entry.safeResponses.length !== expectedSafe.length) fail('invalid-initiative');
    for (let index = 0; index < expectedSafe.length; index++) {
      const response = entry.safeResponses[index];
      const actual = expectedSafe[index]!;
      if (!isRecord(response) || !isMove(response.move) || jevMoveId(response.move) !== jevMoveId(actual.move)
          || response.action !== actual.action || response.advancesRow !== actual.advancesRow
          || response.immediateWin !== actual.immediateWin) fail('invalid-initiative');
    }
  }
  if (saved.complete !== saved.candidates.every((entry) => entry.complete)) fail('invalid-initiative');
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
      || !['parallel-v4', 'parallel-v5', 'parallel-v6', 'parallel-v7', 'parallel-v8', 'parallel-v9', 'parallel-v10', 'parallel-v11', 'parallel-v12', 'parallel-v13', 'parallel-v14', 'parallel-v15', 'parallel-v16', 'parallel-v17', 'parallel-v18', JEV_PARALLEL_POLICY.version].includes(trace.policy.version)
      || trace.policy.rulesVersion !== JEV_PARALLEL_POLICY.rulesVersion
      || trace.policy.protocolVersion !== JEV_PARALLEL_POLICY.protocolVersion) fail('invalid-trace');
  verifyApiAttempts(trace);

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
    const terminalCandidates = search.candidates.filter(
      (candidate) => candidate.extension?.method === 'terminal-only-loss-proof',
    );
    for (const candidate of search.candidates) {
      if (!isRecord(candidate)) fail('invalid-search-pv');
      replayVariation(root, trace.config, candidate.move, candidate.principalVariation, 'invalid-search-pv');
      candidateVariations += 1;
      if (candidate.extension !== null && candidate.extension !== undefined) {
        if (!isRecord(candidate.extension)) fail('invalid-extension-pv');
        const extensionEnd = replayVariation(root, trace.config, candidate.move, candidate.extension.principalVariation, 'invalid-extension-pv');
        if (candidate.extension.method === 'terminal-only-loss-proof') {
          const extension = candidate.extension;
          if (!['parallel-v17', 'parallel-v18', 'parallel-v19'].includes((trace.policy as { version: string }).version)
              || search.extension?.policyVersion !== 'jev-extension-2'
              || extension.requestedDepth !== 8 || extension.score !== null
              || ![0, 2, 4, 6, 8].includes(extension.searchedDepth)
              || !Number.isSafeInteger(extension.nodes) || extension.nodes < 0
              || typeof extension.completed !== 'boolean'
              || !['complete', 'deadline', 'node-budget', 'aborted'].includes(extension.stopReason)
              || !['loss', 'unknown'].includes(extension.proven)) fail('invalid-extension-pv');
          if (extension.proven === 'loss') {
            const terminal = getResult(extensionEnd, trace.config);
            if (!extension.completed || extension.stopReason !== 'complete' || !terminal || terminal.winner === root.turn
                || extension.proof?.winner !== terminal.winner || extension.proof?.reason !== terminal.reason
                || extension.proof?.plies !== extension.principalVariation.length
                || extension.searchedDepth < extension.principalVariation.length
                || candidate.proven !== 'loss'
                || candidate.proofSearchedDepth !== extension.searchedDepth
                || !isDeepStrictEqual(candidate.proof, extension.proof)
                || !sameVariation(candidate.principalVariation, extension.principalVariation)
                || !isDeepStrictEqual(candidate.horizonFacts, extension.horizonFacts)
                || !isDeepStrictEqual(extension.horizonFacts?.terminal, terminal)) fail('invalid-extension-pv');
          } else if (extension.proof !== null || extension.principalVariation.length !== 1
              || extension.completed !== (extension.searchedDepth === 8)
              || (extension.completed ? extension.stopReason !== 'complete' : extension.stopReason === 'complete')
              || candidate.proven !== 'unknown' || candidate.proof !== null
              || !isDeepStrictEqual(extension.horizonFacts, candidate.afterFacts)) fail('invalid-extension-pv');
        }
        extensionVariations += 1;
      }
    }
    if (terminalCandidates.length) {
      const summary = search.extension;
      const terminalNodes = terminalCandidates.reduce((sum, candidate) => sum + candidate.extension!.nodes, 0);
      const attempted = terminalCandidates.filter((candidate) => candidate.extension!.nodes > 0).length;
      const completed = terminalCandidates.filter((candidate) => candidate.extension!.completed).length;
      if (!isRecord(summary) || summary.policyVersion !== 'jev-extension-2'
          || summary.maxDepth !== 8 || summary.scope !== 'unresolved-candidates-terminal-loss-only'
          || !Number.isSafeInteger(summary.nodes) || summary.nodes < 0
          || summary.nodes > JEV_PARALLEL_POLICY.maxNodes || summary.nodes !== terminalNodes
          || summary.attemptedCandidates !== attempted || summary.completedCandidates !== completed
          || !['complete', 'deadline', 'node-budget', 'aborted'].includes(summary.stopReason)
          || (summary.stopReason === 'complete') !== terminalCandidates.every(candidate => candidate.extension!.completed)
          || !Number.isSafeInteger(search.nodes) || search.nodes < summary.nodes
          || search.nodes > JEV_PARALLEL_POLICY.maxNodes) fail('invalid-extension-pv');

      if (terminalCandidates.some((candidate) => candidate.extension!.proven === 'loss')) {
        let reproduced: ReturnType<typeof proveJevTerminalLosses>;
        try {
          reproduced = proveJevTerminalLosses(root, trace.config, terminalCandidates.map(candidate => candidate.move), {
            deadlineMs: Date.now() + 10_000,
            maxNodes: summary.nodes,
            maxDepth: 8,
          });
        } catch {
          return fail('invalid-extension-pv');
        }
        for (let index = 0; index < terminalCandidates.length; index += 1) {
          const saved = terminalCandidates[index]!.extension!;
          if (saved.proven !== 'loss') continue;
          const actual = reproduced.candidates[index]!;
          // Unknown and interrupted records are not replayed as safety claims.
          // A positive forced-loss claim must reproduce before the audit deadline.
          if (actual.proven !== 'loss'
              || actual.searchedDepth !== saved.searchedDepth
              || !isDeepStrictEqual(actual.proof, saved.proof)
              || !sameVariation(actual.principalVariation, saved.principalVariation)) {
            fail('invalid-extension-pv');
          }
        }
      }
    }
  }
  if (trace.retainedProofs !== undefined) {
    if (!Array.isArray(trace.retainedProofs)) fail('invalid-retained-proof');
    const seen = new Set<string>();
    for (const retained of trace.retainedProofs) {
      if (!isRecord(retained) || typeof retained.id !== 'string' || seen.has(retained.id)
          || !Number.isSafeInteger(retained.sourceSearch) || retained.sourceSearch < 0
          || !['win', 'loss'].includes(retained.proven)) fail('invalid-retained-proof');
      seen.add(retained.id);
      const source = trace.searches[retained.sourceSearch]?.candidates
        .find((candidate) => jevMoveId(candidate.move) === retained.id);
      if (!source || source.proven !== retained.proven
          || retained.searchedDepth !== (source.proofSearchedDepth ?? (source.extension?.proven === source.proven
            ? source.extension.searchedDepth : source.searchedDepth))
          || !Array.isArray(retained.principalVariation)
          || retained.principalVariation.length !== source.principalVariation.length
          || retained.principalVariation.some((move, i) => !isMove(move)
            || jevMoveId(move) !== jevMoveId(source.principalVariation[i]!))) fail('invalid-retained-proof');
      for (const field of ['winner', 'reason', 'plies'] as const) {
        if (retained.proof?.[field] !== source.proof?.[field]) fail('invalid-retained-proof');
      }
      const terminalState = replayVariation(
        root, trace.config, source.move, retained.principalVariation, 'invalid-retained-proof',
      );
      const terminal = getResult(terminalState, trace.config);
      // This validates the recorded proof line only. It does not re-expand sibling
      // branches or independently prove that the result is forced over the full tree.
      if (!isRecord(retained.proof)
          || !terminal
          || retained.proof.winner !== terminal.winner
          || retained.proof.reason !== terminal.reason
          || retained.proof.plies !== retained.principalVariation.length
          || (retained.proven === 'win') !== (terminal.winner === root.turn)) {
        fail('invalid-retained-proof');
      }
    }
  }

  const hasTerminalExtensions = trace.searches.some(search => search.candidates.some(
    candidate => candidate.extension?.method === 'terminal-only-loss-proof',
  ));
  if (hasTerminalExtensions) {
    const latest = trace.searches.at(-1);
    if (!latest || !Array.isArray(trace.retainedProofs)) {
      fail('invalid-extension-pv');
    }
    for (let searchIndex = 0; searchIndex < trace.searches.length; searchIndex += 1) {
      for (const candidate of trace.searches[searchIndex]!.candidates) {
        if (candidate.extension?.method !== 'terminal-only-loss-proof'
            || candidate.extension.proven !== 'loss') continue;
        const retained = trace.retainedProofs.find(proof => proof.id === jevMoveId(candidate.move));
        if (!retained || retained.proven !== 'loss' || retained.sourceSearch > searchIndex) {
          fail('invalid-retained-proof');
        }
      }
    }
    const eligible = latest.candidates.map(candidate => jevMoveId(candidate.move));
    if (new Set(eligible).size !== eligible.length) fail('invalid-extension-pv');
    const retained = new Map(trace.retainedProofs.map(proof => [proof.id, proof.proven]));
    // Retained proofs, including proofs from an earlier verification pass, are
    // the source of truth used by the runtime gate when a later pass is shallow.
    const wins = eligible.filter(id => retained.get(id) === 'win');
    const unresolved = eligible.filter(id => retained.get(id) !== 'loss');
    const expected = wins.length ? wins : unresolved.length ? unresolved : eligible;
    const expectedReason = wins.length ? 'proven-win'
      : unresolved.length ? 'avoid-proven-loss' : 'candidate-loss-global-scope-recorded';
    const finalReasons = new Set(['proven-win', 'avoid-proven-loss', 'candidate-loss-global-scope-recorded']);
    const gate = [...trace.gates].reverse().find(candidate => finalReasons.has(candidate.reason));
    if (!gate) {
      if (trace.status === 'selected' || trace.status === 'applied') fail('invalid-extension-pv');
    } else if (gate !== trace.gates.at(-1) || gate.reason !== expectedReason
        || !isDeepStrictEqual(gate.candidates, expected)
        || !isDeepStrictEqual(gate.excluded, eligible.filter(id => !expected.includes(id)))) {
      fail('invalid-extension-pv');
    }
  }

  verifyPressure(trace, root);
  verifyInitiative(trace, root);
  if (trace.searchProposal) {
    try { verifyJevSearchProposal(root, trace.config, trace.searchProposal); }
    catch { fail('invalid-search-proposal'); }
  }
  const requiresSearchProposal = ['parallel-v16', 'parallel-v17', 'parallel-v18', 'parallel-v19'].includes((trace.policy as { version: string }).version)
    && ['selected', 'applied'].includes(trace.status) && trace.selection?.source !== 'engine-immediate-win';
  if (requiresSearchProposal) {
    if (!Object.hasOwn(trace, 'searchProposal')
      || !Number.isFinite(trace.searchProposalStartedAt) || !Number.isFinite(trace.searchProposalDeadlineMs)
      || !Number.isFinite(trace.timings.searchProposalMs) || trace.timings.searchProposalMs! < 0
      || trace.searchProposalStartedAt! < Date.parse(trace.startedAt)
      || trace.searchProposalDeadlineMs! > trace.deadlineMs) fail('invalid-search-proposal');
    if (trace.searchProposal) {
      if (trace.searchProposalOmission !== undefined
        || trace.searchProposal.limits.maxMs > trace.searchProposalDeadlineMs! - trace.searchProposalStartedAt!) fail('invalid-search-proposal');
    } else {
      if (!['budget-unavailable', 'injected-unavailable'].includes(trace.searchProposalOmission ?? '')) fail('invalid-search-proposal');
      if (trace.searchProposalOmission === 'budget-unavailable'
        && trace.searchProposalDeadlineMs! > trace.searchProposalStartedAt! + trace.timings.searchProposalMs!) fail('invalid-search-proposal');
    }
  }
  const requiresRollouts = ['parallel-v10', 'parallel-v11', 'parallel-v12', 'parallel-v13', 'parallel-v14', 'parallel-v15', 'parallel-v16', 'parallel-v17', 'parallel-v18', 'parallel-v19'].includes((trace.policy as { version: string }).version)
    && ['selected', 'applied'].includes(trace.status) && trace.selection?.source === 'jev-final';
  if (requiresRollouts && !trace.rollouts) fail('invalid-rollouts');
  const finalIds = trace.gates?.at(-1)?.candidates;
  if (requiresSearchProposal) {
    const included = !!trace.searchProposal && finalIds?.includes(trace.searchProposal.id);
    if (included && (!trace.coverage?.some(c => c.id === trace.searchProposal!.id
      && c.category === 'search-proposal' && c.role === 'classical-search' && c.probability === null)
      || !trace.proposals.find(p => p.id === trace.searchProposal!.id)?.roles.includes('coverage-classical-search'))) {
      fail('invalid-search-proposal');
    }
    if (trace.selection?.source === 'jev-final') {
      const input = trace.stages.filter(s => s.phase === 'final').at(-1)?.request.state;
      if (!isRecord(input) || !Object.hasOwn(input, 'searchProposal')
        || !isDeepStrictEqual(input.searchProposal, included ? briefJevSearchProposal(trace.searchProposal!) : null)) {
        fail('invalid-search-proposal');
      }
    }
  }
  if (requiresRollouts) {
    const finalStage = trace.stages.filter(stage => stage.phase === 'final').at(-1);
    const question = finalStage?.request.questions.move;
    if (!Array.isArray(finalIds) || !finalIds.length || new Set(finalIds).size !== finalIds.length
      || !finalIds.includes(selectionId!) || question?.type !== 'choice'
      || JSON.stringify(Object.keys(question.criteria).sort()) !== JSON.stringify([...finalIds].sort())
      || (['parallel-v14', 'parallel-v15', 'parallel-v16', 'parallel-v17', 'parallel-v18', 'parallel-v19'].includes((trace.policy as { version: string }).version)
        ? trace.rollouts!.version !== 'jev-rollouts-v4' || trace.rollouts!.limits.maxPlies !== 8 || trace.rollouts!.limits.maxNodesPerDecision !== 64
        : trace.rollouts!.limits.maxPlies !== 40 || trace.rollouts!.limits.maxNodesPerDecision !== 128)) fail('invalid-rollouts');
  }
  if (trace.rollouts) {
    try { verifyJevRolloutEvidence(root, trace.config, trace.rollouts,
      requiresRollouts ? finalIds : undefined); }
    catch { fail('invalid-rollouts'); }
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
