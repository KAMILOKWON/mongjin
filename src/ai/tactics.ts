import { applyMove } from '../core/apply';
import type { RuleConfig } from '../core/config';
import { getResult } from '../core/result';
import { findKing, legalMoves, opponent } from '../core/rules';
import type { GameState, Move, Player } from '../core/types';

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

function kingThreatened(state: GameState, p: Player): boolean {
  const k = findKing(state, p);
  if (!k) return false;
  const n = state.board.length;
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const r = k.r + dr;
    const c = k.c + dc;
    if (r < 0 || r >= n || c < 0 || c >= n) continue;
    const piece = state.board[r][c];
    if (piece && piece.player !== p && piece.type === 'GUARD') return true;
  }
  return false;
}

function escortCount(state: GameState, p: Player): number {
  const k = findKing(state, p);
  if (!k) return 0;
  const n = state.board.length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = k.r + dr;
      const c = k.c + dc;
      if (r < 0 || r >= n || c < 0 || c >= n) continue;
      const piece = state.board[r][c];
      if (piece?.player === p && piece.type === 'GUARD') count++;
    }
  }
  return count;
}

/**
 * 탐색이 얕게 끊겼을 때 쓰는 전술 폴백.
 * 즉시 승리 → 순이득 캡처 → 동가 캡처 → 알몸 왕 위협
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
  if (captures.length) {
    captures.sort((a, b) => captureSwing(state, b, config) - captureSwing(state, a, config));
    const best = captures[0]!;
    const swing = captureSwing(state, best, config);
    if (swing >= WIN - 100) return best;
    if (swing >= 3) return best;
    if (swing >= 0) return best;
  }

  if (!config.kingCapture) return null;

  const opp = opponent(state.turn);
  let bestThreat: Move | null = null;
  let bestThreatScore = -Infinity;

  for (const m of moves) {
    if (m.kind !== 'MOVE' || state.board[m.to.r][m.to.c]) continue;
    const after = applyMove(state, m);
    if (!kingThreatened(after, opp)) continue;
    if (escortCount(after, opp) > 1) continue;
    const score = 5000 - Math.abs(m.from.r - m.to.r) - Math.abs(m.from.c - m.to.c);
    if (score > bestThreatScore) {
      bestThreatScore = score;
      bestThreat = m;
    }
  }
  return bestThreat;
}

export function isQuiescenceMove(state: GameState, move: Move, config: RuleConfig): boolean {
  if (move.kind === 'MOVE') {
    if (state.board[move.to.r][move.to.c]) return true;
    const piece = state.board[move.from.r][move.from.c]!;
    if (piece.type === 'KING') return true;
    const after = applyMove(state, move);
    if (config.kingCapture && kingThreatened(after, opponent(state.turn))) return true;
  }
  return false;
}
