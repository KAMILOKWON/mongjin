import type { AiOptions, AiSearchStats } from '../src/ai/ai';
import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import { jevMoveId } from './jevPolicy';

export const JEV_GUARD_PRESSURE_POLICY_VERSION = 'jev-guard-pressure-v2' as const;
export const JEV_GUARD_PRESSURE_SCOPE =
  'bounded-guard-pressure-suggestion-not-final-selection' as const;
export const JEV_GUARD_PRESSURE_RESPONSE_SCOPE =
  'one-enemy-reply-terminal-and-next-king-capture-only' as const;

export const JEV_GUARD_PRESSURE_LIMITS = {
  maxNodes: 4_096,
  maxMsPerDecision: 30,
  fallbackMaxMs: 30,
  fallbackMaxDepth: 3,
  fallbackMaxNodes: 128,
} as const;

export type JevGuardPressureSource =
  | 'immediate-win'
  | 'guard-pressure'
  | 'fallback'
  | 'interrupted';

export type JevGuardPressureStopReason =
  | 'complete'
  | 'deadline'
  | 'node-budget'
  | 'aborted';

export type JevGuardPressureFallback = (
  state: GameState,
  config: RuleConfig,
  options: AiOptions,
) => Move | null;

export interface JevGuardPressureCandidateStats {
  id: string;
  canonicalIndex: number;
  guardAction: boolean;
  /** Kept for compatibility with the v1 field; identical to directThreat. */
  actionCreatesCaptureThreat: boolean;
  directThreat: boolean;
  /** Null until the complete before/after comparison is available. May coexist with directThreat. */
  proactiveBlocking: boolean | null;
  forwardEscapeReduction: number | null;
  complete: boolean;
  checkedResponses: number;
  totalResponses: number;
  safeResponses: number;
  forwardSafeKingEscapes: number;
  immediateWinningResponses: number;
  safeCounterCaptures: number;
  preservesBoardAnchors: boolean;
  eligible: boolean;
}

export interface JevGuardPressureDecisionStats {
  version: typeof JEV_GUARD_PRESSURE_POLICY_VERSION;
  scope: typeof JEV_GUARD_PRESSURE_SCOPE;
  responseScope: typeof JEV_GUARD_PRESSURE_RESPONSE_SCOPE;
  complete: boolean;
  stopReason: JevGuardPressureStopReason;
  /** Canonical applyMove transitions, including the hypothetical baseline; excludes logged fallback search. */
  nodes: number;
  elapsedMs: number;
  limits: {
    requestedDeadlineMs: number;
    deadlineMs: number;
    maxNodes: number;
    maxMsPerDecision: typeof JEV_GUARD_PRESSURE_LIMITS.maxMsPerDecision;
    fallbackMaxMs: typeof JEV_GUARD_PRESSURE_LIMITS.fallbackMaxMs;
    fallbackMaxDepth: typeof JEV_GUARD_PRESSURE_LIMITS.fallbackMaxDepth;
  };
  legalMoves: number;
  evaluatedAfterstates: number;
  immediateWins: string[];
  immediateTerminalLosses: string[];
  enemyForwardBaseline: {
    scope: 'before-action-enemy-to-move-counterfactual-not-a-legal-pass';
    player: Player;
    complete: boolean;
    checkedMoves: number;
    totalMoves: number;
    safeForwardKingMoves: number | null;
  };
  pressureCandidates: JevGuardPressureCandidateStats[];
  selected: JevGuardPressureCandidateStats | null;
  fallback: {
    called: boolean;
    maxMs: number | null;
    maxNodes: number | null;
    search: AiSearchStats | null;
  };
}

export interface JevGuardPressureDecision {
  move: Move | null;
  source: JevGuardPressureSource;
  stats: JevGuardPressureDecisionStats;
}

export interface JevGuardPressureOptions {
  /** Absolute Date.now() deadline shared by analysis and fallback; additionally capped at 30 ms. */
  deadlineMs: number;
  /** Shared transition budget. The fallback receives only the unspent amount. */
  maxNodes: number;
  fallback: JevGuardPressureFallback;
  signal?: AbortSignal;
}

const HALT = Symbol('jev-guard-pressure-halt');

function isGuardAction(state: GameState, move: Move): boolean {
  return move.kind === 'PLACE'
    || state.board[move.from.r]?.[move.from.c]?.type === 'GUARD';
}

function isForwardKingMove(state: GameState, player: Player, move: Move): boolean {
  if (move.kind !== 'MOVE') return false;
  if (state.board[move.from.r]?.[move.from.c]?.type !== 'KING') return false;
  return player === 'BLACK' ? move.to.r < move.from.r : move.to.r > move.from.r;
}

function moveCapturesPressureGuard(after: GameState, root: Move, response: Move): boolean {
  if (response.kind !== 'MOVE') return false;
  if (response.to.r !== root.to.r || response.to.c !== root.to.c) return false;
  return after.board[response.from.r]?.[response.from.c]?.type === 'GUARD'
    && after.board[root.to.r]?.[root.to.c]?.type === 'GUARD';
}

function captureThreatFromAction(
  state: GameState,
  config: RuleConfig,
  self: Player,
  move: Move,
): boolean {
  const enemyKing = findKing(state, opponent(self));
  if (!enemyKing) return false;
  return legalMoves({ ...state, turn: self }, config).some((candidate) => (
    candidate.kind === 'MOVE'
    && candidate.from.r === move.to.r
    && candidate.from.c === move.to.c
    && candidate.to.r === enemyKing.r
    && candidate.to.c === enemyKing.c
  ));
}

function hasImmediateKingCapture(
  state: GameState,
  config: RuleConfig,
  attacker: Player,
): boolean {
  const king = findKing(state, opponent(attacker));
  if (!king) return true;
  return legalMoves({ ...state, turn: attacker }, config).some((candidate) => (
    candidate.kind === 'MOVE'
    && candidate.to.r === king.r
    && candidate.to.c === king.c
  ));
}

function selectedByPressureOrder(
  left: JevGuardPressureCandidateStats,
  right: JevGuardPressureCandidateStats,
): number {
  // Only completed, eligible candidates enter this order. No speculative
  // center/file bonus: the actual removed forward destinations supply relevance.
  return left.forwardSafeKingEscapes - right.forwardSafeKingEscapes
    || left.safeResponses - right.safeResponses
    || Number(right.preservesBoardAnchors) - Number(left.preservesBoardAnchors)
    || left.canonicalIndex - right.canonicalIndex;
}

function validateOptions(options: JevGuardPressureOptions): void {
  if (!Number.isFinite(options.deadlineMs)) {
    throw new Error('JEV guard-pressure policy requires a finite deadlineMs');
  }
  if (!Number.isSafeInteger(options.maxNodes)
    || options.maxNodes < 1
    || options.maxNodes > JEV_GUARD_PRESSURE_LIMITS.maxNodes) {
    throw new Error(
      `JEV guard-pressure maxNodes must be an integer from 1 to ${JEV_GUARD_PRESSURE_LIMITS.maxNodes}`,
    );
  }
  if (typeof options.fallback !== 'function') {
    throw new Error('JEV guard-pressure policy requires a fallback chooser');
  }
}

/**
 * Produces one bounded guard-pressure suggestion for a hypothetical opponent
 * scenario or supplemental candidate coverage. It never filters JEV candidates
 * or overrides the final model choice.
 * "Safe" response counts exclude immediate terminals against the enemy and
 * next-move king captures only. They do not exclude later goal/surround threats.
 * No guard is preferred unless it directly threatens capture or removes at least
 * one capture-safe forward king move from the before-action baseline.
 */
export function chooseJevGuardPressureMove(
  state: GameState,
  config: RuleConfig,
  options: JevGuardPressureOptions,
): JevGuardPressureDecision {
  validateOptions(options);
  const startedAt = Date.now();
  const deadlineMs = Math.min(
    options.deadlineMs, startedAt + JEV_GUARD_PRESSURE_LIMITS.maxMsPerDecision,
  );
  if (getResult(state, config)) {
    throw new Error('JEV guard-pressure policy cannot choose from a terminal state');
  }

  const moves = legalMoves(state, config);
  if (moves.length === 0) {
    throw new Error('JEV guard-pressure policy requires at least one legal move');
  }
  const self = state.turn;
  let nodes = 0;
  let evaluatedAfterstates = 0;
  let stopReason: JevGuardPressureStopReason = 'complete';
  const afterById = new Map<string, GameState>();
  const immediateWins: string[] = [];
  const immediateTerminalLosses: string[] = [];
  const pressureCandidates: JevGuardPressureCandidateStats[] = [];
  const enemyForwardBaseline: JevGuardPressureDecisionStats['enemyForwardBaseline'] = {
    scope: 'before-action-enemy-to-move-counterfactual-not-a-legal-pass',
    player: opponent(self),
    complete: false,
    checkedMoves: 0,
    totalMoves: 0,
    safeForwardKingMoves: null,
  };
  let fallbackSearch: AiSearchStats | null = null;

  const stats = (): JevGuardPressureDecisionStats => ({
    version: JEV_GUARD_PRESSURE_POLICY_VERSION,
    scope: JEV_GUARD_PRESSURE_SCOPE,
    responseScope: JEV_GUARD_PRESSURE_RESPONSE_SCOPE,
    complete: stopReason === 'complete',
    stopReason,
    nodes,
    elapsedMs: Date.now() - startedAt,
    limits: {
      requestedDeadlineMs: options.deadlineMs,
      deadlineMs,
      maxNodes: options.maxNodes,
      maxMsPerDecision: JEV_GUARD_PRESSURE_LIMITS.maxMsPerDecision,
      fallbackMaxMs: JEV_GUARD_PRESSURE_LIMITS.fallbackMaxMs,
      fallbackMaxDepth: JEV_GUARD_PRESSURE_LIMITS.fallbackMaxDepth,
    },
    legalMoves: moves.length,
    evaluatedAfterstates,
    immediateWins,
    immediateTerminalLosses,
    enemyForwardBaseline,
    pressureCandidates,
    selected: null,
    fallback: { called: false, maxMs: null, maxNodes: null, search: fallbackSearch },
  });

  const checkTime = () => {
    if (options.signal?.aborted) stopReason = 'aborted';
    else if (Date.now() >= deadlineMs) stopReason = 'deadline';
    else return;
    throw HALT;
  };
  const apply = (position: GameState, move: Move) => {
    checkTime();
    if (nodes >= options.maxNodes) {
      stopReason = 'node-budget';
      throw HALT;
    }
    nodes += 1;
    return applyMove(position, move);
  };

  try {
    for (const move of moves) {
      const after = apply(state, move);
      evaluatedAfterstates += 1;
      const id = jevMoveId(move);
      afterById.set(id, after);
      const terminal = getResult(after, config);
      if (terminal?.winner === self) immediateWins.push(id);
      else if (terminal?.winner === opponent(self)) immediateTerminalLosses.push(id);
    }
    checkTime();
  } catch (error) {
    if (error !== HALT) throw error;
    return { move: null, source: 'interrupted', stats: stats() };
  }

  if (immediateWins.length > 0) {
    const id = immediateWins[0]!;
    const move = moves.find((candidate) => jevMoveId(candidate) === id)!;
    return { move, source: 'immediate-win', stats: stats() };
  }

  try {
    // Hold the board fixed and hypothetically let the enemy act before SELF's
    // candidate. This supplies a control count, not a playable pass or PV move.
    const baseline = { ...state, turn: opponent(self) };
    checkTime();
    const baselineMoves = legalMoves(baseline, config).filter((move) => (
      isForwardKingMove(baseline, opponent(self), move)
    ));
    enemyForwardBaseline.totalMoves = baselineMoves.length;
    let baselineSafeCount = 0;
    for (const move of baselineMoves) {
      const responded = apply(baseline, move);
      const terminal = getResult(responded, config);
      const safe = terminal?.winner === opponent(self)
        || (!terminal && !hasImmediateKingCapture(responded, config, self));
      checkTime();
      enemyForwardBaseline.checkedMoves += 1;
      if (safe) baselineSafeCount += 1;
    }
    enemyForwardBaseline.safeForwardKingMoves = baselineSafeCount;
    enemyForwardBaseline.complete = true;

    for (let index = 0; index < moves.length; index += 1) {
      checkTime();
      const move = moves[index]!;
      if (!isGuardAction(state, move)) continue;
      const id = jevMoveId(move);
      const after = afterById.get(id)!;
      const immediateLoss = immediateTerminalLosses.includes(id);
      const actionCreatesCaptureThreat = !immediateLoss
        && captureThreatFromAction(after, config, self, move);
      const candidate: JevGuardPressureCandidateStats = {
        id,
        canonicalIndex: index,
        guardAction: true,
        actionCreatesCaptureThreat,
        directThreat: actionCreatesCaptureThreat,
        proactiveBlocking: null,
        forwardEscapeReduction: null,
        complete: false,
        checkedResponses: 0,
        totalResponses: 0,
        safeResponses: 0,
        forwardSafeKingEscapes: 0,
        immediateWinningResponses: 0,
        safeCounterCaptures: 0,
        preservesBoardAnchors: move.kind === 'PLACE',
        eligible: false,
      };
      pressureCandidates.push(candidate);
      if (immediateLoss) {
        candidate.complete = true;
        continue;
      }

      const responses = legalMoves(after, config);
      candidate.totalResponses = responses.length;
      for (const response of responses) {
        const responded = apply(after, response);
        candidate.checkedResponses += 1;
        const terminal = getResult(responded, config);
        checkTime();
        if (terminal?.winner === opponent(self)) {
          candidate.immediateWinningResponses += 1;
          candidate.safeResponses += 1;
          if (isForwardKingMove(after, opponent(self), response)) {
            candidate.forwardSafeKingEscapes += 1;
          }
          continue;
        }
        if (terminal?.winner === self) continue;
        if (hasImmediateKingCapture(responded, config, self)) continue;
        candidate.safeResponses += 1;
        if (isForwardKingMove(after, opponent(self), response)) {
          candidate.forwardSafeKingEscapes += 1;
        }
        if (moveCapturesPressureGuard(after, move, response)) {
          candidate.safeCounterCaptures += 1;
        }
      }
      checkTime();
      candidate.complete = true;
      candidate.forwardEscapeReduction = baselineSafeCount - candidate.forwardSafeKingEscapes;
      candidate.proactiveBlocking = candidate.forwardEscapeReduction > 0;
      candidate.eligible = (candidate.directThreat || candidate.proactiveBlocking)
        && candidate.immediateWinningResponses === 0
        && candidate.safeCounterCaptures === 0;
    }
    checkTime();
  } catch (error) {
    if (error !== HALT) throw error;
    return { move: null, source: 'interrupted', stats: stats() };
  }

  const selected = pressureCandidates.filter((candidate) => candidate.eligible)
    .sort(selectedByPressureOrder)[0];
  if (selected) {
    const move = moves[selected.canonicalIndex]!;
    const output = stats();
    output.selected = selected;
    return { move, source: 'guard-pressure', stats: output };
  }

  const remainingAfterAnalysis = options.maxNodes - nodes;
  const remainingMs = deadlineMs - Date.now();
  if (options.signal?.aborted || remainingAfterAnalysis <= 0 || remainingMs <= 0) {
    stopReason = options.signal?.aborted
      ? 'aborted'
      : remainingAfterAnalysis <= 0 ? 'node-budget' : 'deadline';
    return { move: null, source: 'interrupted', stats: stats() };
  }
  const fallbackMaxMs = Math.max(
    1,
    Math.min(JEV_GUARD_PRESSURE_LIMITS.fallbackMaxMs, remainingMs),
  );
  const fallbackMaxNodes = Math.min(
    JEV_GUARD_PRESSURE_LIMITS.fallbackMaxNodes, remainingAfterAnalysis,
  );
  const fallbackMove = options.fallback(state, config, {
    maxMs: fallbackMaxMs,
    maxDepth: JEV_GUARD_PRESSURE_LIMITS.fallbackMaxDepth,
    maxNodes: fallbackMaxNodes,
    choiceWindow: 0,
    rng: undefined,
    botSide: state.turn,
    onSearchComplete: (search) => { fallbackSearch = search; },
  });
  if (options.signal?.aborted || Date.now() >= deadlineMs) {
    stopReason = options.signal?.aborted ? 'aborted' : 'deadline';
    const output = stats();
    output.fallback = {
      called: true,
      maxMs: fallbackMaxMs,
      maxNodes: fallbackMaxNodes,
      search: fallbackSearch,
    };
    return { move: null, source: 'interrupted', stats: output };
  }
  const canonical = fallbackMove
    ? moves.find((move) => jevMoveId(move) === jevMoveId(fallbackMove))
    : undefined;
  if (!canonical) throw new Error('JEV guard-pressure fallback returned no canonical legal move');
  const output = stats();
  output.fallback = {
    called: true,
    maxMs: fallbackMaxMs,
    maxNodes: fallbackMaxNodes,
    search: fallbackSearch,
  };
  return { move: canonical, source: 'fallback', stats: output };
}
