import { applyMove } from '../core/apply';
import type { RuleConfig } from '../core/config';
import { getResult } from '../core/result';
import { legalMoves } from '../core/rules';
import type { GameState, Move } from '../core/types';

const WIN = 10000;

export function moveWinsNow(state: GameState, move: Move, config: RuleConfig): boolean {
  const next = applyMove(state, move);
  const result = getResult(next, config);
  return result?.winner === state.turn;
}

/** 즉시 승리 수 (applyMove + getResult — 포위·잡기·목적지 모두 포함) */
export function findWinningMove(
  state: GameState,
  moves: Move[],
  config: RuleConfig,
): Move | null {
  for (const m of moves) {
    if (moveWinsNow(state, m, config)) return m;
  }
  return null;
}

function pieceValue(type: 'KING' | 'GUARD'): number {
  return type === 'KING' ? WIN : 3;
}

/** 1-ply 캡처 교환 평가: 양수면 이득, 0이면 동가, 음수면 손해 */
export function captureSwing(state: GameState, move: Move, config: RuleConfig): number {
  if (move.kind !== 'MOVE') return 0;
  const target = state.board[move.to.r][move.to.c];
  if (!target || target.player === state.turn) return 0;

  let gain = pieceValue(target.type);
  const after = applyMove(state, move);
  const result = getResult(after, config);
  if (result?.winner === state.turn) return WIN;

  for (const om of legalMoves(after, config)) {
    if (om.kind !== 'MOVE') continue;
    if (om.to.r !== move.to.r || om.to.c !== move.to.c) continue;
    const recaptured = after.board[move.to.r][move.to.c];
    if (!recaptured || recaptured.player !== state.turn) continue;
    gain -= pieceValue(recaptured.type);
  }
  return gain;
}

/**
 * 탐색이 얕게 끊겼을 때만 쓰는 전술 폴백 (completedDepth <= 1).
 * 즉시 승리 → 순이득 캡처만
 */
export function pickObviousMove(
  state: GameState,
  moves: Move[],
  config: RuleConfig,
): Move | null {
  const win = findWinningMove(state, moves, config);
  if (win) return win;

  const captures = moves.filter(
    (m) => m.kind === 'MOVE' && state.board[m.to.r][m.to.c] !== null,
  );
  if (!captures.length) return null;

  captures.sort((a, b) => captureSwing(state, b, config) - captureSwing(state, a, config));
  const best = captures[0]!;
  const swing = captureSwing(state, best, config);
  if (swing >= WIN - 100) return best;
  if (swing >= 3) return best;
  return null;
}
