import type { Coord, GameState, Move, Player } from '../core/types';
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
const MAX_KILLER_DEPTH = 64;
const LMR_MIN_DEPTH = 3;
const LMR_QUIET_THRESHOLD = 4;

/** 브라우저·GitHub Pages에서 쓰는 기본 AI 강도 */
export const DEFAULT_AI_OPTIONS: AiOptions = {
  maxMs: 250,
  maxDepth: 5,
};

export interface AiOptions {
  maxMs?: number;
  maxDepth?: number;
  /** 재현 가능한 벤치용 노드 상한. 제품에서는 시간 상한을 사용한다. */
  maxNodes?: number;
  hints?: BotHints;
  botSide?: Player;
  /** 동점·근접 최선수 무작위 선택 (셀프플레이 다양성) */
  rng?: () => number;
  /** 루트 점수에 더하는 대칭 평가 오차 폭(난이도·셀프플레이용). */
  rootNoise?: number;
  /** 승리 계획(안전한 왕 전진·호위·마무리)의 루트 선택 반영 강도. */
  planStrength?: number;
  /** 선택적 보수적 LMR·반복 억제·포위 압력을 적용한다. */
  elite?: boolean;
  /** 진단·벤치용 탐색 통계 콜백. */
  onSearchComplete?: (stats: AiSearchStats) => void;
}

export interface AiSearchStats {
  nodes: number;
  completedDepth: number;
  elapsedMs: number;
  aborted: boolean;
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
  nodeLimit: number;
  nodes: number;
  aborted: boolean;
  tt: Map<string, TTEntry>;
  history: Map<string, number>;
  killers: (Move | null)[][];
  /** elite 모드: 보수적 LMR·반복 억제·포위 압력 */
  elite: boolean;
  /** 전술 퀴에센스 한계 */
  quiescenceMax: number;
}

function moveSig(m: Move): string {
  if (m.kind === 'PLACE') return `P:${m.to.r},${m.to.c}`;
  return `M:${m.from.r},${m.from.c}>${m.to.r},${m.to.c}`;
}

function movesEqual(a: Move, b: Move): boolean {
  return moveSig(a) === moveSig(b);
}

function createSearchCtx(
  config: RuleConfig,
  deadline: number,
  elite = false,
  nodeLimit = Number.POSITIVE_INFINITY,
): SearchCtx {
  const killers: (Move | null)[][] = [];
  for (let i = 0; i < MAX_KILLER_DEPTH; i++) killers.push([null, null]);
  return {
    config,
    deadline,
    nodeLimit,
    nodes: 0,
    aborted: false,
    tt: new Map(),
    history: new Map(),
    killers,
    elite,
    // 퀴에센스를 과도하게 늘리면 체크 분기가 폭발해 본 탐색이
    // 오히려 얕아진다. elite도 같은 전술 한계를 쓴다.
    quiescenceMax: QUIESCENCE_MAX,
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

const GOAL_MASKS = new Map<string, Uint8Array>();

function goalMaskFor(p: Player, config: RuleConfig, n: number): Uint8Array {
  const key = `${n}:${config.goalCells}:${p}`;
  const cached = GOAL_MASKS.get(key);
  if (cached) return cached;
  const mask = new Uint8Array(n * n);
  for (const g of goalCellsFor(p, config)) mask[g.r * n + g.c] = 1;
  GOAL_MASKS.set(key, mask);
  return mask;
}

function bfsKingDistPrepared(
  state: GameState,
  p: Player,
  config: RuleConfig,
  k: Coord | null,
  danger: Uint8Array,
): number {
  const n = state.board.length;
  if (!k) return BLOCKED_DIST + 15;
  const goalMask = goalMaskFor(p, config, n);
  if (goalMask[k.r * n + k.c]) return 0;

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
      if (goalMask[idx]) return d + 1;
      if (danger[idx]) continue;
      dist[idx] = d + 1;
      queue.push(idx);
    }
  }
  return BLOCKED_DIST;
}

function bfsKingDist(state: GameState, p: Player, config: RuleConfig): number {
  const n = state.board.length;
  const k = findKing(state, p);
  const danger = buildDangerMask(state, p, config, n);
  return bfsKingDistPrepared(state, p, config, k, danger);
}

function placementDelay(
  state: GameState,
  move: Move,
  config: RuleConfig,
  before: number,
): number {
  if (move.kind !== 'PLACE') return 0;
  const opp = opponent(state.turn);
  const after = bfsKingDist(child(state, move), opp, config);
  return after - before;
}

interface EvaluationScan {
  kings: Record<Player, Coord | null>;
  guardTotals: Record<Player, number>;
  dangers: Record<Player, Uint8Array>;
}

/** 정적 평가에 필요한 왕·호위·위험 정보를 보드 한 번의 순회로 모은다. */
function scanForEvaluation(state: GameState, config: RuleConfig): EvaluationScan {
  const n = state.board.length;
  const kings: Record<Player, Coord | null> = { BLACK: null, WHITE: null };
  const guardTotals: Record<Player, number> = {
    BLACK: state.guardsInHand.BLACK,
    WHITE: state.guardsInHand.WHITE,
  };
  const dangers: Record<Player, Uint8Array> = {
    BLACK: new Uint8Array(n * n),
    WHITE: new Uint8Array(n * n),
  };

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const piece = state.board[r][c];
      if (!piece) continue;
      if (piece.type === 'KING') {
        kings[piece.player] = { r, c };
        continue;
      }
      guardTotals[piece.player]++;
      if (!config.kingCapture) continue;
      const threatenedPlayer = opponent(piece.player);
      const danger = dangers[threatenedPlayer];
      for (const [dr, dc] of ORTHO) {
        const nr = r + dr;
        const nc = c + dc;
        if (inBoard(n, nr, nc)) danger[nr * n + nc] = 1;
      }
    }
  }

  return { kings, guardTotals, dangers };
}

function kingThreatenedAt(
  state: GameState,
  p: Player,
  k: Coord | null,
): boolean {
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

function kingThreatened(state: GameState, p: Player): boolean {
  return kingThreatenedAt(state, p, findKing(state, p));
}

function escortCountAt(state: GameState, p: Player, k: Coord | null): number {
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

function escortCount(state: GameState, p: Player): number {
  return escortCountAt(state, p, findKing(state, p));
}

function interceptGapAt(
  n: number,
  invader: Player,
  dK: Coord | null,
  iK: Coord | null,
): number {
  if (!dK || !iK) return 0;
  const gR = goalRow(invader, n);
  const step = Math.sign(gR - iK.r);
  const tr = Math.min(Math.max(iK.r + 2 * step, Math.min(iK.r, gR)), Math.max(iK.r, gR));
  return Math.max(Math.abs(dK.r - tr), Math.abs(dK.c - iK.c));
}

/** 시작 행에서 목표 행 쪽으로 실제 전진한 칸 수. */
function forwardProgress(p: Player, king: Coord | null, n: number): number {
  if (!king) return 0;
  return p === 'BLACK' ? n - 1 - king.r : king.r;
}

/** 왕의 직교 탈출 칸 수 (포위 패배 판정과 동일 기준, 0이면 이미 포위) */
function orthoEscapeCountAt(
  state: GameState,
  p: Player,
  k: Coord | null,
): number {
  if (!k) return 0;
  const n = state.board.length;
  let count = 0;
  for (const [dr, dc] of ORTHO) {
    const r = k.r + dr;
    const c = k.c + dc;
    if (!inBoard(n, r, c)) continue;
    const piece = state.board[r][c];
    if (!piece || piece.player === p) count++;
  }
  return count;
}

function evaluate(
  state: GameState,
  config: RuleConfig,
  hints?: BotHints,
  botSide?: Player,
  elite = false,
): number {
  const me = state.turn;
  const opp = opponent(me);
  const scan = scanForEvaluation(state, config);
  const myKing = scan.kings[me];
  const oppKing = scan.kings[opp];
  const myD = bfsKingDistPrepared(state, me, config, myKing, scan.dangers[me]);
  const oppD = bfsKingDistPrepared(state, opp, config, oppKing, scan.dangers[opp]);

  const myTotal = scan.guardTotals[me];
  const oppTotal = scan.guardTotals[opp];
  let score = 7 * (myTotal - oppTotal);

  // 손에 든 호위에 유연성 보너스: 배치 행위 자체의 턴 비용 반영
  score += 2 * (state.guardsInHand[me] - state.guardsInHand[opp]);

  // 과전개 패널티: 상대보다 보드 호위 2개 이상 더 배치 시 감점 (낭비 템포)
  const myOnBoard = myTotal - state.guardsInHand[me];
  const oppOnBoard = oppTotal - state.guardsInHand[opp];
  const excessDeploy = Math.max(0, myOnBoard - oppOnBoard - 2);
  score -= 5 * excessDeploy;

  if (config.kingCapture) {
    if (kingThreatenedAt(state, opp, oppKing)) score += 5000;
    if (kingThreatenedAt(state, me, myKing)) score -= 220;
    score += 5 * (
      Math.min(escortCountAt(state, me, myKing), 3) -
      Math.min(escortCountAt(state, opp, oppKing), 3)
    );
  }

  // 선택적 포위 압력: 교착에서 상대 왕의 탈출 칸을 좁히는 쪽으로 수렴시킨다
  if (elite && config.kingSurroundLoss) {
    score += 6 * (
      orthoEscapeCountAt(state, me, myKing) -
      orthoEscapeCountAt(state, opp, oppKing)
    );
  }

  // 승리 계획을 연속적인 점수로 평가한다. 예전의 앞섬/뒤처짐 이분법은
  // 뒤처졌을 때 상대만 막는 편이 유리해져 왕이 영원히 전진하지 않는
  // 교착을 만들었다. 이제 내 안전 경로 단축과 상대 경로 지연이 언제나
  // 함께 가치가 있고, 앞서면 왕 전진의 가치가 더 커진다.
  const routeCap = state.board.length + 3;
  const myRoute = Math.min(myD, routeCap);
  const oppRoute = Math.min(oppD, routeCap);
  const raceLead = oppRoute - myRoute;
  score += 52 * raceLead;
  score += 14 * (routeCap - myRoute);
  score -= 10 * (routeCap - oppRoute);

  // 안전 경로(BFS)만 보면 먼 미래의 차단을 피하려고 왕이 시작 행으로
  // 되돌아가는 국면이 생긴다. 실제 전진도를 별도로 보상해 계획의 최종
  // 목표가 언제나 상대 목적지 도달임을 고정한다.
  const myProgress = forwardProgress(me, myKing, state.board.length);
  const oppProgress = forwardProgress(opp, oppKing, state.board.length);
  score += 64 * (myProgress - oppProgress);

  if (raceLead >= 1) {
    // 앞설 때는 차단만 반복하지 않고 실제 목표행 도달로 전환한다.
    score += 18 * (routeCap - myRoute);
  } else if (config.kingCapture) {
    // 뒤처졌을 때는 상대의 진로를 가로막되, 이 항은 왕 전진 점수보다
    // 작아서 방어 후 반드시 자기 승리 계획으로 돌아온다.
    score -= 8 * interceptGapAt(state.board.length, opp, myKing, oppKing);
  }

  if (hints && botSide) {
    const botBonus = hints.evalBonus(state);
    score += me === botSide ? botBonus : -botBonus;
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
  // PLACE 수마다 같은 배치 전 거리를 재계산하지 않는다.
  const placementBaseDist = moves.some((m) => m.kind === 'PLACE')
    ? bfsKingDist(state, opp, config)
    : 0;
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
      const delay = placementDelay(state, m, config, placementBaseDist);
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
  ctx.nodes++;
  if (ctx.nodes >= ctx.nodeLimit || ((ctx.nodes & 127) === 0 && performance.now() > ctx.deadline)) {
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
  if (tick(ctx)) {
    return evaluate(
      state,
      ctx.config,
      hints,
      botSide,
      ctx.elite,
    );
  }

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN : -WIN;

  const standPat = evaluate(
    state,
    ctx.config,
    hints,
    botSide,
    ctx.elite,
  );
  const inCheck = kingThreatened(state, state.turn);
  if (qDepth <= 0) return standPat;

  // 왕이 다음 수에 잡히는 국면에서는 현재 평가로 멈출 수 없다.
  // 즉시 패배를 피하는 수가 있으면 그 수들을 모두 읽어 수평선 블런더를 막는다.
  if (!inCheck) {
    if (standPat >= beta) return beta;
    if (alpha < standPat) alpha = standPat;
  }

  const legal = legalMoves(state, ctx.config);
  let tactical: Move[];
  if (inCheck) {
    const evasions = legal.filter((m) => {
      const next = child(state, m);
      return findWinningMove(next, legalMoves(next, ctx.config), ctx.config) === null;
    });
    tactical = evasions.length > 0 ? evasions : legal;
  } else {
    tactical = legal.filter((m) => {
      if (isCaptureOrGoal(state, m, ctx.config)) return true;
      const next = child(state, m);
      // 상대 왕을 바로 잡을 수 있게 만드는 체크성 수도 전술 탐색에 포함한다.
      return kingThreatened(next, next.turn);
    });
  }
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
  if (tick(ctx)) {
    return evaluate(
      state,
      ctx.config,
      hints,
      botSide,
      ctx.elite,
    );
  }

  const key = positionKey(state);

  const tt = ttProbe(ctx, key, depth, alpha, beta);
  if (tt.cutoff !== null) return tt.cutoff;

  const winner = getTerminalWinner(state, ctx.config);
  if (winner) return winner === state.turn ? WIN + depth : -(WIN + depth);
  if (depth <= 0) return quiescence(state, ctx, alpha, beta, ctx.quiescenceMax, hints, botSide);

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

    // LMR: elite도 매우 늦은 조용한 수는 축약해 실제 완료 깊이를 확보한다.
    // 다만 일반 모드보다 깊고 늦게 적용해 전술 누락 가능성을 낮춘다.
    let reduction = 0;
    if (
      depth >= (ctx.elite ? LMR_MIN_DEPTH + 2 : LMR_MIN_DEPTH) &&
      i >= (ctx.elite ? LMR_QUIET_THRESHOLD + 4 : LMR_QUIET_THRESHOLD) &&
      !capture &&
      !isKillerMove &&
      m.kind !== 'PLACE'
    ) {
      reduction = 1;
    }

    const childState = child(state, m);

    let v: number;
    if (i === 0) {
      v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
    } else {
      v = -negamax(childState, ctx, depth - 1 - reduction, -alpha - 1, -alpha, hints, botSide);
      if (!ctx.aborted && v > alpha) {
        v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
      }
    }

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

  if (!ctx.aborted) {
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

interface RootPlanContext {
  strength: number;
  blocked: boolean;
}

function directGoalDistance(
  king: Coord | null,
  player: Player,
  config: RuleConfig,
): number {
  if (!king) return BLOCKED_DIST;
  return Math.min(
    ...goalCellsFor(player, config).map((goal) =>
      Math.max(Math.abs(goal.r - king.r), Math.abs(goal.c - king.c)),
    ),
  );
}

/** 안전 경로가 기하학적 최단거리보다 길면 왕의 진로가 막힌 상태다. */
function createRootPlanContext(
  state: GameState,
  config: RuleConfig,
  strength: number,
): RootPlanContext {
  const king = findKing(state, state.turn);
  const safeRoute = bfsKingDist(state, state.turn, config);
  const directRoute = directGoalDistance(king, state.turn, config);
  return {
    strength,
    blocked:
      kingThreatenedAt(state, state.turn, king) || safeRoute > directRoute + 1,
  };
}

/**
 * 검색 점수가 비슷할 때 승리로 수렴시키는 루트 계획 점수.
 *
 * 전술 탐색 결과에만 더하므로 실제 승패 점수(WIN)를 뒤집지 않으며,
 * 즉시 패배 수는 이 단계 전에 이미 후보에서 제거된다.
 */
function rootPlanBonus(
  state: GameState,
  move: Move,
  config: RuleConfig,
  plan: RootPlanContext,
): number {
  const { strength, blocked } = plan;
  if (strength <= 0) return 0;
  const me = state.turn;
  const opp = opponent(me);
  const myKing = findKing(state, me);
  const oppKing = findKing(state, opp);
  let score = 0;

  if (move.kind === 'MOVE') {
    const piece = state.board[move.from.r][move.from.c];
    if (piece?.type === 'KING') {
      const goalR = goalRow(me, state.board.length);
      const advance =
        Math.abs(move.from.r - goalR) - Math.abs(move.to.r - goalR);
      score += advance > 0 ? 90 * advance : advance < 0 ? 110 * advance : -8;
      if (blocked) {
        // 막혔을 때 후퇴·횡보를 반복하는 대신 호위로 진로를 정리한다.
        if (advance < 0) score += 180 * advance;
        else if (advance === 0) score -= 70;
      }
      if (isGoalCell(me, move.to, config)) score += WIN;
    } else if (piece?.type === 'GUARD') {
      const target = state.board[move.to.r][move.to.c];
      if (target) score += target.type === 'KING' ? WIN : 80;
      if (oppKing) {
        const before = Math.abs(move.from.r - oppKing.r) + Math.abs(move.from.c - oppKing.c);
        const after = Math.abs(move.to.r - oppKing.r) + Math.abs(move.to.c - oppKing.c);
        // 실제 한 수 위협을 만드는 추격만 계획에 포함한다.
        if (after === 1 && before > after) score += 70;
      }
      if (blocked && myKing) {
        const beforeSupport = Math.max(
          Math.abs(move.from.r - myKing.r),
          Math.abs(move.from.c - myKing.c),
        );
        const afterSupport = Math.max(
          Math.abs(move.to.r - myKing.r),
          Math.abs(move.to.c - myKing.c),
        );
        score += 70 + Math.max(0, beforeSupport - afterSupport) * 50;
      }
    }
  } else if (myKing) {
    const adjacent =
      Math.max(Math.abs(move.to.r - myKing.r), Math.abs(move.to.c - myKing.c)) <= 1;
    const escorts = escortCountAt(state, me, myKing);
    if (adjacent && escorts < 2) score += 45 * (2 - escorts);
    else score -= 8;
    if (blocked) score += adjacent ? 180 : 35;
  }

  return score * strength;
}

export function chooseMove(
  state: GameState,
  config: RuleConfig,
  opts: AiOptions = {},
): Move | null {
  const startedAt = performance.now();
  const maxMs = opts.maxMs ?? DEFAULT_AI_OPTIONS.maxMs!;
  const maxDepth = opts.maxDepth ?? DEFAULT_AI_OPTIONS.maxDepth!;
  const hints = opts.hints;
  const botSide = opts.botSide;
  const rng = opts.rng;
  const rootNoise = opts.rootNoise ?? 0;
  const planStrength = opts.planStrength ?? 1;
  const ctx = createSearchCtx(
    config,
    startedAt + maxMs,
    opts.elite ?? false,
    opts.maxNodes ?? Number.POSITIVE_INFINITY,
  );
  const finish = (move: Move | null, completedDepth: number): Move | null => {
    opts.onSearchComplete?.({
      nodes: ctx.nodes,
      completedDepth,
      elapsedMs: performance.now() - startedAt,
      aborted: ctx.aborted,
    });
    return move;
  };
  const legal = legalMoves(state, config);
  // elite(올마이트)는 2회 등장 위치도 회피해, 2회 반복 구간을 오가는 셔플 교착을 끊는다.
  const repetitionLimit = opts.elite ? 1 : 2;
  const repetitionSafe = legal.filter((move) => {
    const key = positionKey(child(state, move));
    return (state.positionCounts[key] ?? 0) < repetitionLimit;
  });
  // 가능한 경우 AI가 동일 국면의 반복 등장을 만드는 수를 두지 않는다.
  const candidates = repetitionSafe.length > 0 ? repetitionSafe : legal;
  let moves = orderMoves(
    state,
    candidates,
    config,
    ctx,
    maxDepth,
    hints,
    botSide,
    null,
  );
  if (!moves.length) return finish(null, 0);

  const immediate = instantWinMove(state, moves, config);
  if (immediate) return finish(immediate, 0);

  // 시간 제한으로 1수 탐색만 끝난 경우에도 즉시 패배하는 블런더는 두지 않는다.
  const safeMoves = moves.filter((move) => !allowsImmediateReplyWin(state, move, config));
  const safetyRestricted = safeMoves.length > 0 && safeMoves.length < moves.length;
  if (safetyRestricted) moves = safeMoves;

  const rootPlan = createRootPlanContext(state, config, planStrength);
  const planBonuses = new Map(
    moves.map((move) => [moveSig(move), rootPlanBonus(state, move, config, rootPlan)]),
  );

  let lastCompleted: Move[] = [moves[0]];
  let completedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (performance.now() > ctx.deadline) break;

    const rootKey = positionKey(state);
    const rootTT = ctx.tt.get(rootKey);

    let best = -Infinity;
    let bestSearchScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    const iterBest: Move[] = [];
    let depthComplete = true;

    moves = orderMoves(state, moves, config, ctx, depth, hints, botSide, rootTT?.move ?? null);

    for (const m of moves) {
      const childState = child(state, m);
      const v = -negamax(childState, ctx, depth - 1, -beta, -alpha, hints, botSide);
      if (ctx.aborted) {
        depthComplete = false;
        break;
      }
      const noise = rootNoise > 0 && rng ? (rng() * 2 - 1) * rootNoise : 0;
      const ranked = v + noise + (planBonuses.get(moveSig(m)) ?? 0);
      if (ranked > best) {
        best = ranked;
        bestSearchScore = v;
        iterBest.length = 0;
        iterBest.push(m);
        if (v > alpha) alpha = v;
      } else if (ranked === best) {
        iterBest.push(m);
      }
    }
    if (!depthComplete && depth > 1) break;
    if (iterBest.length) {
      lastCompleted = iterBest.slice();
      completedDepth = depth;
      const bestMove = iterBest[0]!;
      moves = [bestMove, ...moves.filter((m) => !movesEqual(m, bestMove))];
      // 루트 계획·난이도 오차는 수 선택에만 쓰고 전치표에는 순수 탐색
      // 점수를 저장한다. 반복 국면에서 계획 보너스가 전술 점수로 재사용되면
      // 탐색 창이 오염될 수 있다.
      ttStore(ctx, rootKey, depth, bestSearchScore, 'exact', bestMove);
    }
    if (bestSearchScore >= WIN) break;
  }

  const safeMoveKeys = safetyRestricted ? new Set(moves.map(moveSig)) : null;
  const allLegal = candidates.filter(
    (move) => safeMoveKeys === null || safeMoveKeys.has(moveSig(move)),
  );
  const finalWin = findWinningMove(state, allLegal, config);
  if (finalWin) return finish(finalWin, completedDepth);

  let chosen =
    rng && lastCompleted.length > 1
      ? lastCompleted[Math.floor(rng() * lastCompleted.length)]!
      : lastCompleted[0]!;
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
    if (fallback) return finish(fallback, completedDepth);
  }

  return finish(chosen, completedDepth);
}
