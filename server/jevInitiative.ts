import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import type { JevPressureExample } from './jevPressure';
import { jevMoveId } from './jevPolicy';

export type JevInitiativeStopReason = 'complete' | 'deadline' | 'node-budget' | 'aborted';
export type JevInitiativeSafeResponse = JevPressureExample['safeResponses'][number];

export interface JevInitiativeCandidate {
  id: string;
  complete: boolean;
  /** Null means bounded analysis stopped before this direct fact was established. */
  directCaptureThreat: boolean | null;
  /** This analyzer deliberately makes no claim about attacks beyond the immediate counter. */
  laterInitiative: 'unknown';
  /** Legal SELF king captures on a hypothetical SELF turn if OPP does not answer. */
  captureThreatsIfUnanswered: Move[];
  /** Number of canonical OPP responses classified from the start of legalMoves order. */
  checkedResponses: number;
  totalResponses: number;
  responsesComplete: boolean;
  /** OPP responses that avoid every immediate SELF win, or win immediately for OPP. */
  safeResponses: JevInitiativeSafeResponse[];
}

export interface JevInitiativeAnalysis {
  version: 'jev-initiative-v1';
  scope: 'direct-offensive-capture-threat-and-opponent-immediate-safety';
  complete: boolean;
  stopReason: JevInitiativeStopReason;
  nodes: number;
  candidates: JevInitiativeCandidate[];
}

export interface JevInitiativeOptions {
  deadlineMs: number;
  maxNodes: number;
  signal?: AbortSignal;
}

const HALT = Symbol('jev-initiative-halt');

/**
 * Reports bounded, direct offensive facts only. A hypothetical SELF turn is used
 * to express "if OPP does not answer"; it is not a legal pass or an extra turn.
 * This function never filters, scores, or selects a root move.
 */
export function analyzeJevInitiative(
  state: GameState,
  config: RuleConfig,
  moves: Move[],
  options: JevInitiativeOptions,
): JevInitiativeAnalysis {
  if (!Number.isFinite(options.deadlineMs)) {
    throw new Error('JEV initiative requires a finite deadlineMs');
  }
  if (!Number.isInteger(options.maxNodes) || options.maxNodes < 0) {
    throw new Error('JEV initiative maxNodes must be a non-negative integer');
  }
  if (getResult(state, config)) throw new Error('JEV initiative cannot analyze a terminal state');
  if (moves.length === 0) throw new Error('JEV initiative requires at least one root move');

  const canonicalById = new Map(legalMoves(state, config).map((move) => [jevMoveId(move), move]));
  const ids = moves.map(jevMoveId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('JEV initiative requires unique root moves');
  }
  for (const id of ids) {
    if (!canonicalById.has(id)) throw new Error(`JEV initiative received an illegal root move: ${id}`);
  }

  const analysis: JevInitiativeAnalysis = {
    version: 'jev-initiative-v1',
    scope: 'direct-offensive-capture-threat-and-opponent-immediate-safety',
    complete: false,
    stopReason: 'complete',
    nodes: 0,
    candidates: ids.map((id) => ({
      id,
      complete: false,
      directCaptureThreat: null,
      laterInitiative: 'unknown',
      captureThreatsIfUnanswered: [],
      checkedResponses: 0,
      totalResponses: 0,
      responsesComplete: false,
      safeResponses: [],
    })),
  };

  const checkInterruption = () => {
    if (options.signal?.aborted) analysis.stopReason = 'aborted';
    else if (Date.now() >= options.deadlineMs) analysis.stopReason = 'deadline';
    else return;
    throw HALT;
  };
  const check = () => {
    checkInterruption();
    if (analysis.nodes < options.maxNodes) return;
    analysis.stopReason = 'node-budget';
    throw HALT;
  };
  const apply = (position: GameState, move: Move) => {
    check();
    analysis.nodes += 1;
    return applyMove(position, move);
  };

  const self = state.turn;
  const enemy = opponent(self);

  try {
    for (let index = 0; index < ids.length; index += 1) {
      const entry = analysis.candidates[index]!;
      const rootMove = canonicalById.get(entry.id)!;
      const after = apply(state, rootMove);
      const rootResult = getResult(after, config);
      if (rootResult) {
        entry.directCaptureThreat = false;
        entry.responsesComplete = true;
        entry.complete = true;
        continue;
      }

      checkInterruption();
      const enemyKing = findKing(after, enemy)!;
      const hypotheticalSelfTurn: GameState = { ...after, turn: self };
      const captures = legalMoves(hypotheticalSelfTurn, config).filter((move) => (
        move.kind === 'MOVE'
        && move.to.r === enemyKing.r
        && move.to.c === enemyKing.c
      ));
      entry.captureThreatsIfUnanswered = captures;
      entry.directCaptureThreat = captures.length > 0;

      if (captures.length === 0) {
        entry.responsesComplete = true;
        entry.complete = true;
        continue;
      }

      const responses = legalMoves(after, config);
      entry.totalResponses = responses.length;
      for (const response of responses) {
        const responded = apply(after, response);
        const responseResult = getResult(responded, config);
        let safe = responseResult?.winner === enemy;

        if (!responseResult) {
          safe = true;
          for (const counter of legalMoves(responded, config)) {
            const counterResult = getResult(apply(responded, counter), config);
            if (counterResult?.winner === self) {
              safe = false;
              break;
            }
          }
        }

        entry.checkedResponses += 1;
        if (safe) {
          const isKing = response.kind === 'MOVE'
            && after.board[response.from.r]?.[response.from.c]?.type === 'KING';
          entry.safeResponses.push({
            move: response,
            action: isKing ? 'king' : 'guard',
            advancesRow: isKing && response.kind === 'MOVE'
              && (enemy === 'BLACK' ? response.to.r < response.from.r : response.to.r > response.from.r),
            immediateWin: responseResult?.winner === enemy,
          });
        }
      }
      entry.responsesComplete = true;
      entry.complete = true;
    }
    analysis.complete = true;
  } catch (error) {
    if (error !== HALT) throw error;
  }

  return analysis;
}
