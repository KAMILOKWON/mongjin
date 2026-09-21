import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import type { JevFactsAnalysis } from './jevAnalysis';
import { jevMoveId } from './jevPolicy';

function sameCell(left: { r: number; c: number }, right: { r: number; c: number }): boolean {
  return left.r === right.r && left.c === right.c;
}

function isKingMove(move: Move, king: { r: number; c: number }): move is Extract<Move, { kind: 'MOVE' }> {
  return move.kind === 'MOVE' && sameCell(move.from, king);
}

/**
 * Returns proposal-coverage IDs only. It never recommends, scores, selects, or
 * overrides a move. The virtual enemy turn is a conditional threat probe, not
 * a legal pass or an assertion that the opponent receives an extra turn.
 */
export function getJevThreatEscapeIds(
  state: GameState,
  config: RuleConfig,
  facts: JevFactsAnalysis,
): string[] {
  if (getResult(state, config) || facts.rootPlayer !== state.turn) return [];

  const self = state.turn;
  const selfKing = findKing(state, self);
  if (!selfKing) return [];

  const enemy = opponent(self);
  const virtualEnemyTurn: GameState = { ...state, turn: enemy };
  const hasCanonicalCaptureThreat = legalMoves(virtualEnemyTurn, config).some((move) => {
    if (move.kind !== 'MOVE' || !sameCell(move.to, selfKing)) return false;
    const result = getResult(applyMove(virtualEnemyTurn, move), config);
    return result?.winner === enemy && result.reason === 'capture';
  });
  if (!hasCanonicalCaptureThreat) return [];

  const factsById = new Map(facts.candidates.map((candidate) => [jevMoveId(candidate.move), candidate]));
  return legalMoves(state, config)
    .filter((move) => isKingMove(move, selfKing))
    .map(jevMoveId)
    .filter((id) => {
      const candidate = factsById.get(id);
      if (!candidate) return false;
      return candidate.repliesComplete === true
        && candidate.immediateLoss === false
        && candidate.opponentWinningReplies.length === 0;
    })
    .sort();
}
