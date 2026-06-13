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
const BLOCKED_DIST = 30;

/** 브라우저·GitHub Pages에서 쓰는 기본 AI 강도 */
export const DEFAULT_AI_OPTIONS: AiOptions = {
  maxMs: 1800,
  maxDepth: 11,
};

export interface AiOptions {
  maxMs?: number;
  maxDepth?: number;
}

interface SearchCtx {
  config: RuleConfig;
  deadline: number;
  nodes: number;
  aborted: boolean;
}

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

function buildDangerMask(state: GameState, p: Player, config: RuleConfig, n: number): Uint8Array {
  const danger = new Uint8Array(n * n);
  if (!config.kingCapture) return danger;
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
  return danger;
}

function bfsKingDist(state: GameState, p: Player, config: RuleConfig): number {
  const n = state.board.length;
  const k = findKing(state, p);
  if (!k) return BLOCKED_DIST + 15;
  if (isGoalCell(p, k, config)) return 0;
  const goalSet = new Set(goalCellsFor(p, config).map((g) => g.r * n + g.c));
  const danger = buildDangerMask(state, p, config, n);

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

function placementDelay(state: GameState, move: Move, config: RuleConfig): number {
  if (move.kind !== 'PLACE') return 0;
  const opp = opponent(state.turn);
  const before = bfsKingDist(state, opp, config);
  const after = bfsKingDist(child(state, move), opp, config);
  return after - before;
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

function evaluate(state: GameState, config: RuleConfig): number {
  const me = state.turn;
  const opp = opponent(me);
  const myD = bfsKingDist(state, me, config);
  const oppD = bfsKingDist(state, opp, config);

  let score = 3 * (guardTotal(state, me) - guardTotal(state, opp));
  if (config.kingCapture) {
    if (kingThreatened(state, opp)) score += 5000;
    if (kingThreatened(state, me)) score -= 60;
    score += 5 * (Math.min(escortCount(state, me), 3) - Math.min(escortCount(state, opp), 3));
  }

  const meArrive = 2 * myD - 1;
  const oppArrive = 2 * oppD;
  if (meArrive < oppArrive) {
    score += 300 + 12 * Math.min(oppArrive - meArrive, 10) - 6 * myD;
  } else {
    score += -300 + 25 * Math.min(oppD, 12) - 3 * myD;
    if (config.kingCapture) score -= 8 * interceptGap(state, me, opp);
  }
  return score;
}

function orderMoves(state: GameState, moves: Move[], config: RuleConfig): Move[] {
  const me = state.turn;
  const opp = opponent(me);
  const n = state.board.length;
  const goalR = goalRow(me, n);
  const oppKing = findKing(state, opp);
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
        if (isGoalCell(me, m.to, config)) s += 10000;
      } else {
        s += near(m.to.r, m.to.c);
      }
    } else {
      s += 3 + near(m.to.r, m.to.c);
      s += placementDelay(state, m, config) * 35;
    }
    return { m, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.m);
}

function tick(ctx: SearchCtx): boolean {
  if ((++ctx.nodes & 127) === 0 && performance.now() > ctx.deadline) {
    ctx.aborted = true;
    return true;
  }
  return false;
}

function negamax(
  state: GameState,
  ctx: SearchCtx,
  depth: number,
  alpha: number,
  beta: number,
): number {
  if (tick(ctx)) return evaluate(state, ctx.config);

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN + depth : -(WIN + depth);
  if (depth <= 0) return evaluate(state, ctx.config);

  const moves = orderMoves(state, legalMoves(state, ctx.config), ctx.config);
  if (!moves.length) return -(WIN + depth);

  let best = -Infinity;
  for (const m of moves) {
    const v = -negamax(child(state, m), ctx, depth - 1, -beta, -alpha);
    if (ctx.aborted) break;
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function instantWinMove(state: GameState, moves: Move[], config: RuleConfig): Move | null {
  for (const m of moves) {
    if (getTerminalWinner(child(state, m), config) === state.turn) return m;
  }
  return null;
}

export function chooseMove(
  state: GameState,
  config: RuleConfig,
  opts: AiOptions = {},
): Move | null {
  const maxMs = opts.maxMs ?? DEFAULT_AI_OPTIONS.maxMs!;
  const maxDepth = opts.maxDepth ?? DEFAULT_AI_OPTIONS.maxDepth!;
  let moves = orderMoves(state, legalMoves(state, config), config);
  if (!moves.length) return null;

  const immediate = instantWinMove(state, moves, config);
  if (immediate) return immediate;

  const ctx: SearchCtx = {
    config,
    deadline: performance.now() + maxMs,
    nodes: 0,
    aborted: false,
  };
  let lastCompleted: Move[] = [moves[0]];

  for (let depth = 1; depth <= maxDepth && !ctx.aborted; depth++) {
    ctx.aborted = false;
    let best = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    const iterBest: Move[] = [];
    for (const m of moves) {
      const v = -negamax(child(state, m), ctx, depth - 1, -beta, -alpha);
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
    if (ctx.aborted && depth > 1) break;
    if (iterBest.length) {
      lastCompleted = iterBest.slice();
      moves = [iterBest[0], ...moves.filter((m) => m !== iterBest[0])];
    }
    if (best >= WIN) break;
  }

  return lastCompleted[Math.floor(Math.random() * lastCompleted.length)];
}
