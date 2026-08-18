import type { GameState, Player } from './types';
import type { RuleConfig } from './config';
import { ORTHO, findKing, inBoard, isGoalCell, legalMoves, opponent } from './rules';

export type WinReason = 'goal' | 'capture' | 'surround' | 'no-moves';

export interface GameResult {
  winner: Player;
  reason: WinReason;
}

const PLAYERS: Player[] = ['BLACK', 'WHITE'];

export function getResult(state: GameState, config: RuleConfig): GameResult | null {
  const n = state.board.length;

  // 0. 왕이 잡혀 사라졌으면 잡은 쪽 승리 (kingCapture 규칙)
  for (const p of PLAYERS) {
    if (!findKing(state, p)) return { winner: opponent(p), reason: 'capture' };
  }

  // 1. 왕이 목적지에 도달하면 즉시 승리
  for (const p of PLAYERS) {
    const king = findKing(state, p);
    if (king && isGoalCell(p, king, config)) return { winner: p, reason: 'goal' };
  }

  // 2. 왕 포위 패배: 상하좌우가 모두 (보드 밖 또는 상대 말)이면 그 왕의 주인이 패배
  if (config.kingSurroundLoss) {
    for (const p of PLAYERS) {
      const king = findKing(state, p);
      if (!king) continue;
      const surrounded = ORTHO.every(([dr, dc]) => {
        const r = king.r + dr;
        const c = king.c + dc;
        if (!inBoard(n, r, c)) return true;
        const piece = state.board[r][c];
        return piece !== null && piece.player !== p;
      });
      if (surrounded) return { winner: opponent(p), reason: 'surround' };
    }
  }

  // 3. 둘 수 있는 합법 수가 없으면 패배
  if (legalMoves(state, config).length === 0) {
    return { winner: opponent(state.turn), reason: 'no-moves' };
  }

  return null;
}
