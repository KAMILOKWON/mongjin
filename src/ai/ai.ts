import type { GameState, Move, Player } from '../core/types';
import type { RuleConfig } from '../core/config';
import type { BotHints } from '../bot/brain';
import {
  captureSwing,
  findWinningMove,
  pickObviousMove,
} from './tactics';
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
  positionKey,
} from '../core/rules';

const WIN = 10000;
const BLOCKED_DIST = 30;
const HISTORY_MAX = 10_000;
const QUIESCENCE_MAX = 5;
const MAX_KILLER_DEPTH = 32;
const LMR_MIN_DEPTH = 3;
const LMR_QUIET_THRESHOLD = 4;

/** 브라우저·GitHub Pages에서 쓰는 기본 AI 강도 */
export const DEFAULT_AI_OPTIONS: AiOptions = {
  maxMs: 2400,
  maxDepth: 24,
};

export interface AiOptions {
  maxMs?: number;
  maxDepth?: number;
  hints?: BotHints;
  botSide?: Player;
}

type TTFlag = 'exact' | 'lower' | 'upper';

interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  move: Move | null;
}

interface SearchCtx {
  config: RuleConfig;
  deadline: number;
  nodes: number;
  aborted: boolean;
  tt: Map<string, TTEntry>;
  history: Map<string, number>;
  killers: (Move | null)[][];
  repCounts: Map<string, number>;  // 실제 게임 positionCounts + 탐색 경로 누적
}

function moveSig(m: Move): string {
  if (m.kind === 'PLACE') return `P:${m.to.r},${m.to.c}`;
  return `M:${m.from.r},${m.from.c}>${m.to.r},${m.to.c}`;
}

function movesEqual(a: Move, b: Move): boolean {
  return moveSig(a) === moveSig(b);
}

function createSearchCtx(config: RuleConfig, deadline: number, rootState: GameState): SearchCtx {
  const killers: (Move | null)[][] = [];
  for (let i = 0; i < MAX_KILLER_DEPTH; i++) killers.push([null, null]);
  const repCounts = new Map<string, number>(Object.entries(rootState.positionCounts));
  return {
    config,
    deadline,
    nodes: 0,
    aborted: false,
    tt: new Map(),
    history: new Map(),
    killers,
    repCounts,
  };
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

function isCapture(state: GameState, move: Move): boolean {
  return move.kind === 'MOVE' && state.board[move.to.r][move.to.c] !== null;
}

function isCaptureOrGoal(state: GameState, move: Move, config: RuleConfig): boolean {
  if (move.kind !== 'MOVE') return false;
  const target = state.board[move.to.r][move.to.c];
  if (target) return true;
  const piece = state.board[move.from.r][move.from.c]!;
  return piece.type === 'KING' && isGoalCell(state.turn, move.to, config);
}

function recordKiller(ctx: SearchCtx, depth: number, move: Move) {
  if (depth <= 0 || depth >= MAX_KILLER_DEPTH) return;
  const row = ctx.killers[depth]!;
  if (row[0] && movesEqual(row[0], move)) return;
  if (row[1] && movesEqual(row[1], move)) return;
  row[0] = row[1];
  row[1] = move;
}

function recordHistory(ctx: SearchCtx, move: Move, depth: number) {
  const key = moveSig(move);
  const bonus = depth * depth;
  ctx.history.set(key, Math.min(HISTORY_MAX, (ctx.history.get(key) ?? 0) + bonus));
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

function evaluate(state: GameState, config: RuleConfig, hints?: BotHints, botSide?: Player): number {
  const me = state.turn;
  const opp = opponent(me);
  const myD = bfsKingDist(state, me, config);
  const oppD = bfsKingDist(state, opp, config);

  const myTotal = guardTotal(state, me);
  const oppTotal = guardTotal(state, opp);
  let score = 7 * (myTotal - oppTotal);

  // 손에 든 호위에 유연성 보너스: 배치 행위 자체의 턴 비용 반영
  score += 2 * (state.guardsInHand[me] - state.guardsInHand[opp]);

  // 과전개 패널티: 상대보다 보드 호위 2개 이상 더 배치 시 감점 (낭비 템포)
  const myOnBoard = myTotal - state.guardsInHand[me];
  const oppOnBoard = oppTotal - state.guardsInHand[opp];
  const excessDeploy = Math.max(0, myOnBoard - oppOnBoard - 2);
  score -= 5 * excessDeploy;

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

  if (hints && botSide && me === botSide) {
    score += hints.evalBonus(state);
  }
  return score;
}

function orderMoves(
  state: GameState,
  moves: Move[],
  config: RuleConfig,
  ctx: SearchCtx,
  depth: number,
  hints?: BotHints,
  botSide?: Player,
  ttMove?: Move | null,
): Move[] {
  const me = state.turn;
  const opp = opponent(me);
  const n = state.board.length;
  const goalR = goalRow(me, n);
  const oppKing = findKing(state, opp);
  const myKing = findKing(state, me);
  const myEsc = escortCount(state, me);
  const near = (r: number, c: number) =>
    oppKing ? 8 - Math.max(Math.abs(r - oppKing.r), Math.abs(c - oppKing.c)) : 0;

  const killers = depth > 0 && depth < MAX_KILLER_DEPTH ? ctx.killers[depth] : null;

  const scored = moves.map((m) => {
    let s = 0;

    if (ttMove && movesEqual(m, ttMove)) s += 2_000_000;
    if (killers) {
      if (killers[0] && movesEqual(m, killers[0])) s += 900_000;
      else if (killers[1] && movesEqual(m, killers[1])) s += 800_000;
    }
    // 히스토리는 490으로 상한 → 호위병 포착(500)이 항상 우선
    s += Math.min(ctx.history.get(moveSig(m)) ?? 0, 490);

    if (m.kind === 'MOVE') {
      const target = state.board[m.to.r][m.to.c];
      if (target) s += target.type === 'KING' ? 10000 : 500;
      const piece = state.board[m.from.r][m.from.c]!;
      if (piece.type === 'KING') {
        // 왕 전진을 강하게 평가: 목표행 접근 시 30점/칸 (기존 20에서 강화)
        const stepsCloser = Math.abs(m.from.r - goalR) - Math.abs(m.to.r - goalR);
        s += stepsCloser > 0 ? stepsCloser * 30 : stepsCloser * 5;
        if (isGoalCell(me, m.to, config)) s += 10000;
      } else {
        s += near(m.to.r, m.to.c);
      }
    } else {
      // PLACE: 전략적 가치 기반 차등 평가
      const delay = placementDelay(state, m, config);
      // 체크성 위협: 상대 왕 인접(체비쇼프 ≤ 1)
      const adjOppKing = oppKing !== null &&
        Math.max(Math.abs(m.to.r - oppKing.r), Math.abs(m.to.c - oppKing.c)) <= 1;
      // 왕 호위 보강: 내 왕 인접 + 아직 호위 2개 미만
      const adjMyKing = myKing !== null &&
        Math.max(Math.abs(m.to.r - myKing.r), Math.abs(m.to.c - myKing.c)) <= 1;
      const useful = delay >= 1 || adjOppKing || (adjMyKing && myEsc < 2);

      s += near(m.to.r, m.to.c);
      if (delay > 0) s += delay * 40;
      // 유용한 배치는 +5, 무의미한 배치는 -25 패널티
      s += useful ? 5 : -25;
    }
    if (hints && botSide && state.turn === botSide) {
      s += hints.moveBonus(state, m);
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

function ttProbe(
  ctx: SearchCtx,
  key: string,
  depth: number,
  alpha: number,
  beta: number,
): { cutoff: number | null; move: Move | null } {
  const entry = ctx.tt.get(key);
  if (!entry) return { cutoff: null, move: null };

  let cutoff: number | null = null;
  if (entry.depth >= depth) {
    if (entry.flag === 'exact') cutoff = entry.score;
    else if (entry.flag === 'lower' && entry.score >= beta) cutoff = entry.score;
    else if (entry.flag === 'upper' && entry.score <= alpha) cutoff = entry.score;
  }
  return { cutoff, move: entry.move };
}

function ttStore(
  ctx: SearchCtx,
  key: string,
  depth: number,
  score: number,
  flag: TTFlag,
  move: Move | null,
) {
  const prev = ctx.tt.get(key);
  if (prev && prev.depth > depth) return;
  ctx.tt.set(key, { depth, score, flag, move });
}

function quiescence(
  state: GameState,
  ctx: SearchCtx,
  alpha: number,
  beta: number,
  qDepth: number,
  hints?: BotHints,
  botSide?: Player,
): number {
  if (tick(ctx)) return evaluate(state, ctx.config, hints, botSide);

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN : -WIN;

  const standPat = evaluate(state, ctx.config, hints, botSide);
  if (standPat >= beta) return beta;
  if (alpha < standPat) alpha = standPat;
  if (qDepth <= 0) return alpha;

  const tactical = legalMoves(state, ctx.config).filter((m) =>
    isCaptureOrGoal(state, m, ctx.config),
  );
  if (!tactical.length) return alpha;

  const ordered = orderMoves(state, tactical, ctx.config, ctx, 0, hints, botSide, null);
  for (const m of ordered) {
    const v = -quiescence(child(state, m), ctx, -beta, -alpha, qDepth - 1, hints, botSide);
    if (ctx.aborted) break;
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/** 네거맥스 + 알파-베타 가지치기 + 전치 테이블 + killer/history + quiescence */
function negamax(
  state: GameState,
  ctx: SearchCtx,
  depth: number,
  alpha: number,
  beta: number,
  hints?: BotHints,
  botSide?: Player,
): number {
  if (tick(ctx)) return evaluate(state, ctx.config, hints, botSide);

  const key = positionKey(state);

  // 동형 3회 반복: 이 국면을 만든 직전 이동자가 패배 → 현재 플레이어 승리
  const repCount = ctx.repCounts.get(key) ?? 0;
  if (repCount >= 3) return WIN + depth;

  const tt = ttProbe(ctx, key, depth, alpha, beta);
  // repCount > 0인 경로에선 TT 스코어가 경로 의존적이므로 컷오프는 무시
  if (repCount === 0 && tt.cutoff !== null) return tt.cutoff;

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN + depth : -(WIN + depth);
  if (depth <= 0) return quiescence(state, ctx, alpha, beta, QUIESCENCE_MAX, hints, botSide);

  const moves = orderMoves(
    state,
    legalMoves(state, ctx.config),
    ctx.config,
    ctx,
    depth,
    hints,
    botSide,
    tt.move,
  );
  if (!moves.length) return -(WIN + depth);

  let best = -Infinity;
  let bestMove: Move | null = null;
  let flag: TTFlag = 'upper';
  const killerRow = depth > 0 && depth < MAX_KILLER_DEPTH ? ctx.killers[depth] : null;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]!;
    const capture = isCapture(state, m);
    const isKillerMove =
      !!killerRow &&
      ((!!killerRow[0] && movesEqual(m, killerRow[0])) ||
        (!!killerRow[1] && movesEqual(m, killerRow[1])));

    // LMR: 조용한 이동(PLACE 제외)에서만 깊이 축약
    let reduction = 0;
    if (
      depth >= LMR_MIN_DEPTH &&
      i >= LMR_QUIET_THRESHOLD &&
      !capture &&
      !isKillerMove &&
      m.kind !== 'PLACE'
    ) {
      reduction = 1;
    }

    // 자식 상태 미리 계산 (PVS 재탐색과 repCounts 공유)
    const childState = child(state, m);
    const childKey = positionKey(childState);
    const prevRep = ctx.repCounts.get(childKey) ?? 0;
    ctx.repCounts.set(childKey, prevRep + 1);

    let v: number;
    if (i === 0) {
      v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
    } else {
      v = -negamax(childState, ctx, depth - 1 - reduction, -alpha - 1, -alpha, hints, botSide);
      if (!ctx.aborted && v > alpha) {
        v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
      }
    }

    ctx.repCounts.set(childKey, prevRep);

    if (ctx.aborted) break;
    if (v > best) {
      best = v;
      bestMove = m;
    }
    if (v > alpha) {
      alpha = v;
      flag = 'exact';
    }
    if (alpha >= beta) {
      if (!capture) recordKiller(ctx, depth, m);
      recordHistory(ctx, m, depth);
      flag = 'lower';
      break;
    }
  }

  if (!ctx.aborted && repCount === 0) {
    ttStore(ctx, key, depth, best, flag, bestMove);
  }
  return best;
}

function instantWinMove(state: GameState, moves: Move[], config: RuleConfig): Move | null {
  return findWinningMove(state, moves, config);
}

function findBestNetCapture(state: GameState, moves: Move[], config: RuleConfig): Move | null {
  let best: Move | null = null;
  let bestSwing = 2;
  for (const m of moves) {
    const swing = captureSwing(state, m, config);
    if (swing > bestSwing) {
      bestSwing = swing;
      best = m;
    }
  }
  return best;
}

/** 상대에게 바로 끝내는 수를 내주는 후보는, 피할 수 있는 한 루트 탐색에서 제외한다. */
function allowsImmediateReplyWin(state: GameState, move: Move, config: RuleConfig): boolean {
  const next = child(state, move);
  const replies = legalMoves(next, config);
  return findWinningMove(next, replies, config) !== null;
}

export function chooseMove(
  state: GameState,
  config: RuleConfig,
  opts: AiOptions = {},
): Move | null {
  const maxMs = opts.maxMs ?? DEFAULT_AI_OPTIONS.maxMs!;
  const maxDepth = opts.maxDepth ?? DEFAULT_AI_OPTIONS.maxDepth!;
  const hints = opts.hints;
  const botSide = opts.botSide;
  const ctx = createSearchCtx(config, performance.now() + maxMs, state);
  let moves = orderMoves(
    state,
    legalMoves(state, config),
    config,
    ctx,
    maxDepth,
    hints,
    botSide,
    null,
  );
  if (!moves.length) return null;

  const immediate = instantWinMove(state, moves, config);
  if (immediate) return immediate;

  // 시간 제한으로 1수 탐색만 끝난 경우에도 즉시 패배하는 블런더는 두지 않는다.
  const safeMoves = moves.filter((move) => !allowsImmediateReplyWin(state, move, config));
  const safetyRestricted = safeMoves.length > 0 && safeMoves.length < moves.length;
  if (safetyRestricted) moves = safeMoves;

  let lastCompleted: Move[] = [moves[0]];
  let completedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (performance.now() > ctx.deadline) break;

    const rootKey = positionKey(state);
    const rootTT = ctx.tt.get(rootKey);

    let best = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    const iterBest: Move[] = [];
    let depthComplete = true;

    moves = orderMoves(state, moves, config, ctx, depth, hints, botSide, rootTT?.move ?? null);

    for (const m of moves) {
      const childState = child(state, m);
      const childKey = positionKey(childState);
      const prevRep = ctx.repCounts.get(childKey) ?? 0;
      ctx.repCounts.set(childKey, prevRep + 1);
      const v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
      ctx.repCounts.set(childKey, prevRep);
      if (ctx.aborted) {
        depthComplete = false;
        break;
      }
      if (v > best) {
        best = v;
        iterBest.length = 0;
        iterBest.push(m);
        if (v > alpha) alpha = v;
      } else if (v === best) {
        iterBest.push(m);
      }
    }
    if (!depthComplete && depth > 1) break;
    if (iterBest.length) {
      lastCompleted = iterBest.slice();
      completedDepth = depth;
      const bestMove = iterBest[0]!;
      moves = [bestMove, ...moves.filter((m) => !movesEqual(m, bestMove))];
      ttStore(ctx, rootKey, depth, best, 'exact', bestMove);
    }
    if (best >= WIN) break;
  }

  const safeMoveKeys = safetyRestricted ? new Set(moves.map(moveSig)) : null;
  const allLegal = legalMoves(state, config).filter(
    (move) => safeMoveKeys === null || safeMoveKeys.has(moveSig(move)),
  );
  const finalWin = findWinningMove(state, allLegal, config);
  if (finalWin) return finalWin;

  let chosen = lastCompleted[0]!;
  const netCapture = findBestNetCapture(state, allLegal, config);
  if (
    netCapture &&
    !isCapture(state, chosen) &&
    captureSwing(state, netCapture, config) >= 3
  ) {
    chosen = netCapture;
  }

  if (completedDepth <= 1) {
    const fallback = pickObviousMove(state, allLegal, config);
    if (fallback) return fallback;
  }

  return chosen;
}
