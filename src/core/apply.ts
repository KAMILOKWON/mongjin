import type { GameState, Move } from './types';
import { opponent } from './rules';

/** 합법 수라고 가정하고 적용한다. 검증은 legalMoves 쪽 책임. */
export function applyMove(state: GameState, move: Move): GameState {
  const board = state.board.map((row) => row.slice());
  const guardsInHand = { ...state.guardsInHand };

  if (move.kind === 'PLACE') {
    board[move.to.r][move.to.c] = { player: state.turn, type: 'GUARD' };
    guardsInHand[state.turn] -= 1;
  } else {
    const piece = board[move.from.r][move.from.c]!;
    board[move.from.r][move.from.c] = null;
    board[move.to.r][move.to.c] = piece; // 상대 호위가 있으면 대체 잡기
  }

  return {
    board,
    turn: opponent(state.turn),
    guardsInHand,
    history: [...state.history, move],
  };
}
