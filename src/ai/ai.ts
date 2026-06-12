import type { GameState, Move, Player } from '../core/types';
import type { RuleConfig } from '../core/config';
import {
  ALL8,
  ORTHO,
  findKing,
  goalCellsFor,
  goalRow,
  inBoard,
  isGoalCell,
  legalMoves,
  opponent,
} from '../core/rules';

const WIN = 10000;
const BLOCKED_DIST = 30; // 왕의 골 경로가 완전히 막혔을 때의 거리 패널티

export interface AiOptions {
  /** 수읽기 시간 한도(ms). 기본 500 */
  maxMs?: number;
  /** 최대 탐색 깊이. 기본 9 */
  maxDepth?: number;
}

interface SearchCtx {
  config: RuleConfig;
  deadline: number;
  nodes: number;
  aborted: boolean;
}

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

/** 탐색용 종국 판정 — 반복/수없음은 탐색 구조가 처리하므로 잡힘/골/포위만 본다 */
function getTerminalWinner(state: GameState, config: RuleConfig): Player | null {
  const n = state.board.length;
  for (const p of ['BLACK', 'WHITE'] as Player[]) {
    const king = findKing(state, p);
    if (!king) return opponent(p);
    if (isGoalCell(p, king, config)) return p;
    if (config.kingSurroundLoss) {
      const surrounded = ORTHO.every(([dr, dc]) => {
        const r = king.r + dr;
        const c = king.c + dc;
        if (!inBoard(n, r, c)) return true;
        const piece = state.board[r][c];
        return piece !== null && piece.player !== p;
      });
      if (surrounded) return opponent(p);
    }
  }
  return null;
}

/**
 * 왕이 목적지까지 실제로 걸어가는 BFS 최단 거리.
 * - 말이 있는 칸은 통과 불가 (체비셰프 직선거리와 달리 호위벽을 인식)
 * - kingCapture 규칙에선 상대 호위의 사정거리(상하좌우) 칸도 통과 불가 —
 *   밟으면 다음 수에 왕이 잡히는 위험 지대. 단 목적지 칸은 밟는 즉시 승리라 안전.
 * 이 위험 지대 덕분에 "호위로 길목 지키기"가 평가에 제대로 잡힌다.
 */
function bfsKingDist(state: GameState, p: Player, config: RuleConfig): number {
  const n = state.board.length;
  const k = findKing(state, p);
  if (!k) return BLOCKED_DIST + 15;
  if (isGoalCell(p, k, config)) return 0;
  const goalSet = new Set(goalCellsFor(p, config).map((g) => g.r * n + g.c));

  const danger = new Uint8Array(n * n);
  if (config.kingCapture) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const piece = state.board[r][c];
        if (!piece || piece.player === p || piece.type !== 'GUARD') continue;
        for (const [dr, dc] of ORTHO) {
          const nr = r + dr;
          const nc = c + dc;
          if (inBoard(n, nr, nc)) danger[nr * n + nc] = 1;
        }
      }
    }
  }

  const dist = new Int16Array(n * n).fill(-1);
  const queue: number[] = [k.r * n + k.c];
  dist[queue[0]] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const r = Math.floor(cur / n);
    const c = cur % n;
    const d = dist[cur];
    for (const [dr, dc] of ALL8) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBoard(n, nr, nc)) continue;
      const idx = nr * n + nc;
      if (dist[idx] !== -1 || state.board[nr][nc]) continue;
      if (goalSet.has(idx)) return d + 1;
      if (danger[idx]) continue;
      dist[idx] = d + 1;
      queue.push(idx);
    }
  }
  return BLOCKED_DIST;
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

/** 왕 주변 8칸의 아군 호위 수 (호위 행렬 보너스) */
function escortCount(state: GameState, p: Player): number {
  const k = findKing(state, p);
  if (!k) return 0;
  const n = state.board.length;
  let count = 0;
  for (const [dr, dc] of ALL8) {
    const r = k.r + dr;
    const c = k.c + dc;
    if (!inBoard(n, r, c)) continue;
    const piece = state.board[r][c];
    if (piece && piece.player === p && piece.type === 'GUARD') count++;
  }
  return count;
}

/**
 * 수비수(defender)의 왕이 침입 왕(invader)의 길목 선점 지점에서 얼마나 떨어져 있는가.
 * 선점 지점 = 침입 왕보다 골 방향으로 2칸 앞, 같은 열 (침입 왕과 골 사이로 클램프)
 */
function interceptGap(state: GameState, defender: Player, invader: Player): number {
  const dK = findKing(state, defender);
  const iK = findKing(state, invader);
  if (!dK || !iK) return 0;
  const n = state.board.length;
  const gR = goalRow(invader, n);
  const step = Math.sign(gR - iK.r);
  const tr = Math.min(Math.max(iK.r + 2 * step, Math.min(iK.r, gR)), Math.max(iK.r, gR));
  return Math.max(Math.abs(dK.r - tr), Math.abs(dK.c - iK.c));
}

/**
 * state.turn(둘 차례인 쪽) 관점의 평가값.
 *
 * 레이스는 선형이 아니라 승/패다: 방해가 없다면 내가 myD수(2·myD−1플라이),
 * 상대가 oppD수(2·oppD플라이) 만에 도착한다. 한 발이라도 늦으면 그 레이스는 진 것 —
 * "약간 나쁨"으로 평가하면 이미 진 레이스를 계속 달리는 수가 수비 준비보다 높게 평가된다.
 * 그래서 도착 순서로 모드를 가른다:
 * - 우위: 달린다 (내 거리 단축이 최우선)
 * - 열세: 내 전진은 거의 무가치. 상대 경로를 늦추는 것(착수 차단)과
 *   침입 왕의 길목(골 쪽 2칸 앞)을 왕으로 선점하는 것만이 가치를 갖는다
 */
function evaluate(state: GameState, config: RuleConfig): number {
  const me = state.turn;
  const opp = opponent(me);
  const myD = bfsKingDist(state, me, config);
  const oppD = bfsKingDist(state, opp, config);

  let score = 3 * (guardTotal(state, me) - guardTotal(state, opp));
  if (config.kingCapture) {
    if (kingThreatened(state, opp)) score += 5000; // 내 차례에 상대 왕이 사정거리 안 = 사실상 승리
    if (kingThreatened(state, me)) score -= 60;
    score += 5 * (Math.min(escortCount(state, me), 3) - Math.min(escortCount(state, opp), 3));
  }

  const meArrive = 2 * myD - 1; // 내가 둘 차례이므로 반수 빠르다
  const oppArrive = 2 * oppD;
  if (meArrive < oppArrive) {
    score += 300 + 12 * Math.min(oppArrive - meArrive, 10) - 6 * myD;
  } else {
    score += -300 + 25 * Math.min(oppD, 12) - 3 * myD;
    if (config.kingCapture) score -= 8 * interceptGap(state, me, opp);
  }
  return score;
}

/** 가지치기 효율을 위한 수 정렬: 왕 잡기 > 호위 잡기 > 왕 전진 > 상대 왕 근처 행마 */
function orderMoves(state: GameState, moves: Move[]): Move[] {
  const me = state.turn;
  const n = state.board.length;
  const goalR = goalRow(me, n);
  const oppKing = findKing(state, opponent(me));
  const near = (r: number, c: number) =>
    oppKing ? 8 - Math.max(Math.abs(r - oppKing.r), Math.abs(c - oppKing.c)) : 0;

  const scored = moves.map((m) => {
    let s = 0;
    if (m.kind === 'MOVE') {
      const target = state.board[m.to.r][m.to.c];
      if (target) s += target.type === 'KING' ? 10000 : 500;
      const piece = state.board[m.from.r][m.from.c]!;
      if (piece.type === 'KING') {
        s += 20 * (Math.abs(m.from.r - goalR) - Math.abs(m.to.r - goalR));
      } else {
        s += near(m.to.r, m.to.c);
      }
    } else {
      s += 3 + near(m.to.r, m.to.c);
    }
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.m);
}

function negamax(
  state: GameState,
  ctx: SearchCtx,
  depth: number,
  alpha: number,
  beta: number,
): number {
  if ((++ctx.nodes & 127) === 0 && performance.now() > ctx.deadline) ctx.aborted = true;
  if (ctx.aborted) return 0;

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN + depth : -(WIN + depth);
  if (depth <= 0) return evaluate(state, ctx.config);

  const moves = orderMoves(state, legalMoves(state, ctx.config));
  if (!moves.length) return -(WIN + depth); // 둘 수 없으면 패배

  let best = -Infinity;
  for (const m of moves) {
    const v = -negamax(child(state, m), ctx, depth - 1, -beta, -alpha);
    if (ctx.aborted) return 0;
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * 반복 심화(iterative deepening): 시간 한도 안에서 깊이 1부터 점점 깊게 탐색하고,
 * 마지막으로 완료된 깊이의 최선 수를 쓴다. 동점 수 중에서는 무작위 선택.
 */
export function chooseMove(
  state: GameState,
  config: RuleConfig,
  opts: AiOptions = {},
): Move | null {
  const maxMs = opts.maxMs ?? 500;
  const maxDepth = opts.maxDepth ?? 9;
  let moves = orderMoves(state, legalMoves(state, config));
  if (!moves.length) return null;

  const ctx: SearchCtx = {
    config,
    deadline: performance.now() + maxMs,
    nodes: 0,
    aborted: false,
  };
  let lastCompleted: Move[] = [moves[0]];

  for (let depth = 1; depth <= maxDepth && !ctx.aborted; depth++) {
    let best = -Infinity;
    let alpha = -Infinity;
    const iterBest: Move[] = [];
    for (const m of moves) {
      const v = -negamax(child(state, m), ctx, depth - 1, -Infinity, -alpha);
      if (ctx.aborted) break;
      if (v > best) {
        best = v;
        iterBest.length = 0;
        iterBest.push(m);
        if (v > alpha) alpha = v;
      } else if (v === best) {
        iterBest.push(m);
      }
    }
    if (ctx.aborted && depth > 1) break; // 미완료 반복의 결과는 버린다
    if (iterBest.length) {
      lastCompleted = iterBest.slice();
      // 다음 반복은 직전 최선 수부터 — 알파베타 가지치기 효율을 높인다
      moves = [iterBest[0], ...moves.filter((m) => m !== iterBest[0])];
    }
    if (best >= WIN) break; // 승리 확정이면 더 깊이 볼 필요 없음
  }

  return lastCompleted[Math.floor(Math.random() * lastCompleted.length)];
}
