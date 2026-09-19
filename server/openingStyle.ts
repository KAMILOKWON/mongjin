import type { RuleConfig } from '../src/core/config';
import { findKing, goalRow, opponent } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';

export type OpeningStyle = 'runner' | 'guardian' | 'tactician' | 'wanderer';

/** Preference only: the shared search still decides which moves are safe and near-best. */
export function openingMovePreference(
  state: GameState,
  move: Move,
  config: RuleConfig,
  side: Player,
  style: OpeningStyle,
  lane: -1 | 1,
): number {
  if (state.turn !== side || state.history.length >= 12) return 0;
  const king = findKing(state, side);
  const enemy = findKing(state, opponent(side));
  if (!king || !enemy) return 0;
  const direction = side === 'BLACK' ? -1 : 1;
  const isKing = move.kind === 'MOVE' && state.board[move.from.r]?.[move.from.c]?.type === 'KING';
  const forward = (move.to.r - king.r) * direction;
  const center = Math.floor(config.boardSize / 2);
  const distance = (a: { r: number; c: number }, b: { r: number; c: number }) =>
    Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
  const clamp = (value: number) => Math.max(0, Math.min(1, value));

  switch (style) {
    case 'runner':
      // A direct king route, while retaining tactical guard moves when required.
      return isKing ? clamp((forward > 0 ? 0.75 : 0) + (move.to.c === center ? 0.25 : 0)) : 0;
    case 'guardian': {
      // Build an escort next to the king; an already present escort anchors the route.
      if (!isKing) return clamp((distance(move.to, king) <= 1 ? 0.7 : 0.2) + (forward > 0 ? 0.3 : 0));
      let escorts = 0;
      for (let r = Math.max(0, move.to.r - 1); r <= Math.min(config.boardSize - 1, move.to.r + 1); r++) {
        for (let c = Math.max(0, move.to.c - 1); c <= Math.min(config.boardSize - 1, move.to.c + 1); c++) {
          const piece = state.board[r]?.[c];
          if (piece?.player === side && piece.type === 'GUARD') escorts++;
        }
      }
      return clamp(escorts * 0.3 + (move.to.c === center ? 0.15 : 0));
    }
    case 'wanderer': {
      // Keep a chosen flank through the opening instead of independently zigzagging.
      const targetColumn = Math.max(1, Math.min(config.boardSize - 2, center + lane * 2));
      const towardLane = Math.abs(king.c - targetColumn) - Math.abs(move.to.c - targetColumn);
      return isKing
        ? clamp((forward > 0 ? 0.25 : 0) + (towardLane > 0 ? 0.75 : towardLane === 0 ? 0.35 : 0))
        : clamp((Math.abs(move.to.c - targetColumn) <= 1 ? 0.5 : 0) + (forward > 0 ? 0.25 : 0));
    }
    case 'tactician': {
      // Prefer a guard in the opponent's route; otherwise approach that route diagonally.
      const enemyDirection = -direction;
      const aheadOfEnemy = (move.to.r - enemy.r) * enemyDirection > 0;
      const routeColumn = Math.abs(move.to.c - enemy.c);
      if (!isKing) return clamp((aheadOfEnemy ? 0.45 : 0) + (routeColumn <= 1 ? 0.35 : 0) +
        (Math.abs(enemy.r - goalRow(opponent(side), config.boardSize)) <= 3 ? 0.2 : 0));
      return clamp((forward > 0 ? 0.3 : 0) + (move.to.c === enemy.c + lane ? 0.45 : 0));
    }
  }
}
