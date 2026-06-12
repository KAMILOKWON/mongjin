import type { GameState, Move, Player } from '../core/types';
import type { RuleConfig } from '../core/config';
import { ORTHO, findKing, goalCellsFor, inBoard, legalMoves, opponent } from '../core/rules';
import { getResult } from '../core/result';

const WIN = 10000;

/** 탐색용 경량 자식 상태 — history/positionCounts 누적을 생략해 복사 비용을 줄인다 */
function child(state: GameState, move: Move): GameState {
  const board = state.board.map((row) => row.slice());
  const guardsInHand = { ...state.guardsInHand };
  if (move.kind === 'PLACE') {
    board[move.to.r][move.to.c] = { player: state.turn, type: 'GUARD' };
    guardsInHand[state.turn] -= 1;
  } else {
    const piece = board[move.from.r][move.from.c]!;
    board[move.from.r][move.from.c] = null;
    board[move.to.r][move.to.c] = piece;
  }
  return {
    board,
    turn: opponent(state.turn),
    guardsInHand,
    history: [],
    positionCounts: {},
  };
}

/** 왕 → 가장 가까운 목적지 칸까지의 체비셰프 거리 (장애물 무시 근사) */
function kingDist(state: GameState, p: Player, config: RuleConfig): number {
  const k = findKing(state, p);
  if (!k) return 99;
  let best = 99;
  for (const g of goalCellsFor(p, config)) {
    best = Math.min(best, Math.max(Math.abs(g.r - k.r), Math.abs(g.c - k.c)));
  }
  return best;
}

function guardTotal(state: GameState, p: Player): number {
  let n = state.guardsInHand[p];
  for (const row of state.board) {
    for (const piece of row) {
      if (piece && piece.player === p && piece.type === 'GUARD') n++;
    }
  }
  return n;
}

/** p의 왕이 상대 호위의 한 수 잡기 사정거리(상하좌우)에 있는가 */
function kingThreatened(state: GameState, p: Player): boolean {
  const k = findKing(state, p);
  if (!k) return false;
  const n = state.board.length;
  for (const [dr, dc] of ORTHO) {
    const r = k.r + dr;
    const c = k.c + dc;
    if (!inBoard(n, r, c)) continue;
    const piece = state.board[r][c];
    if (piece && piece.player !== p && piece.type === 'GUARD') return true;
  }
  return false;
}

/** state.turn(둘 차례인 쪽) 관점의 평가값 */
function evaluate(state: GameState, config: RuleConfig): number {
  const me = state.turn;
  const opp = opponent(me);
  let score = 12 * (kingDist(state, opp, config) - kingDist(state, me, config));
  score += 2 * (guardTotal(state, me) - guardTotal(state, opp));
  if (config.kingCapture) {
    // 내 차례에 상대 왕이 사정거리 안 = 사실상 승리. 내 왕이 위협받는 건 큰 감점
    if (kingThreatened(state, opp)) score += 5000;
    if (kingThreatened(state, me)) score -= 40;
  }
  return score;
}

/** 가지치기 효율을 위한 수 정렬: 잡기 > 왕 전진 > 나머지 */
function orderMoves(state: GameState, config: RuleConfig, moves: Move[]): Move[] {
  const me = state.turn;
  const goals = goalCellsFor(me, config);
  const goalR = goals[0].r;
  const scored = moves.map((m) => {
    let s = 0;
    if (m.kind === 'MOVE') {
      const target = state.board[m.to.r][m.to.c];
      if (target) s += 100; // 잡기 우선
      const piece = state.board[m.from.r][m.from.c]!;
      if (piece.type === 'KING') {
        s += 10 * (Math.abs(m.from.r - goalR) - Math.abs(m.to.r - goalR)); // 왕 전진
      }
    }
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.m);
}

function negamax(
  state: GameState,
  config: RuleConfig,
  depth: number,
  alpha: number,
  beta: number,
): number {
  const result = getResult(state, config);
  if (result) {
    return result.winner === state.turn ? WIN + depth : -(WIN + depth);
  }
  if (depth === 0) return evaluate(state, config);

  let best = -Infinity;
  for (const m of orderMoves(state, config, legalMoves(state, config))) {
    const v = -negamax(child(state, m), config, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/** 둘 차례인 쪽의 최선 수를 고른다. 동점 수 중에서는 무작위 선택. */
export function chooseMove(state: GameState, config: RuleConfig, depth = 3): Move | null {
  const moves = orderMoves(state, config, legalMoves(state, config));
  if (!moves.length) return null;

  let best = -Infinity;
  let bestMoves: Move[] = [];
  let alpha = -Infinity;
  for (const m of moves) {
    const v = -negamax(child(state, m), config, depth - 1, -Infinity, -alpha);
    if (v > best) {
      best = v;
      bestMoves = [m];
      if (v > alpha) alpha = v;
    } else if (v === best) {
      bestMoves.push(m);
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}
