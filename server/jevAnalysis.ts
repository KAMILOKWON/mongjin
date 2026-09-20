import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult, type GameResult } from '../src/core/result';
import {
  ALL8,
  ORTHO,
  findKing,
  inBoard,
  isAnyGoalCell,
  isGoalCell,
  legalMoves,
  opponent,
  positionKey,
} from '../src/core/rules';
import type { Coord, GameState, Move, Player } from '../src/core/types';

export const JEV_ANALYSIS_VERSION = 'jev-analysis-1' as const;
export const JEV_SEARCH_VERSION = 'jev-search-1' as const;
export const JEV_EXTENSION_POLICY_VERSION = 'jev-extension-1' as const;

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_NODES = 100_000;
const MAX_DEPTH = 6;
const EXTENSION_MAX_MS = 1_000;
const TERMINAL_SCORE = 1_000_000;
const HEURISTIC_LIMIT = 100_000;

export type JevAnalysisStopReason = 'complete' | 'deadline' | 'node-budget' | 'aborted';
export type JevProof = 'win' | 'loss' | 'unknown';
export type JevExtensionReason = 'terminal-threat' | 'capture-sequence' | 'goal-race';

export interface JevAnalysisOptions {
  /** Absolute Date.now() deadline allocated by the whole-turn orchestrator. */
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface JevSearchOptions extends JevAnalysisOptions {
  /** Includes the supplied root move. Defaults to four plies. */
  maxDepth?: number;
  /** Shared by common search and selective extension. */
  maxNodes?: number;
}

export interface JevMaterialFacts {
  own: number;
  opponent: number;
}

export interface JevKingRoute {
  status: 'reachable' | 'unreachable' | 'incomplete' | 'not-applicable';
  distance: number | null;
  /** Representative shortest-path first steps, not an exhaustive set. */
  firstSteps: Coord[];
  firstStepsAreExamples: true;
  exploredNodes: number;
  reason: 'goal' | 'blocked' | 'king-missing' | 'deadline' | 'aborted' | 'terminal' | null;
  frozenBoard: true;
  excludesAttackedSquares: true;
}

export interface JevRoutePair {
  own: JevKingRoute;
  opponent: JevKingRoute;
}

export interface JevStateFacts {
  terminal: GameResult | null;
  material: JevMaterialFacts;
  routes: JevRoutePair;
  complete: boolean;
}

export interface JevRootMoveFacts {
  move: Move;
  immediateWin: boolean | null;
  immediateLoss: boolean | null;
  opponentWinningReplies: Move[];
  checkedReplies: number;
  repliesComplete: boolean;
  material: JevMaterialFacts;
  routes: JevRoutePair;
}

export interface JevFactsAnalysis {
  version: typeof JEV_ANALYSIS_VERSION;
  rootPlayer: Player;
  legalMoveCount: number;
  initialRoute: JevRoutePair;
  complete: boolean;
  analyzedMoves: number;
  stopReason: JevAnalysisStopReason;
  candidates: JevRootMoveFacts[];
}

export interface JevProofDetail {
  winner: Player;
  reason: GameResult['reason'];
  plies: number;
}

export interface JevCandidateExtension {
  requestedDepth: number;
  searchedDepth: number;
  completed: boolean;
  nodes: number;
  stopReason: JevAnalysisStopReason;
  reasons: JevExtensionReason[];
  /** Separate extension score. The common candidate score remains unchanged. */
  score: number | null;
  proven: JevProof;
  proof: JevProofDetail | null;
  principalVariation: Move[];
  horizonFacts: JevStateFacts | null;
}

export interface JevAnalyzedCandidate {
  move: Move;
  /** Comparable only at completedDepth, never a win probability. */
  score: number;
  searchedDepth: number;
  proven: JevProof;
  /** Actual common/partial/extension depth that established an exact proof. */
  proofSearchedDepth?: number;
  proof: JevProofDetail | null;
  principalVariation: Move[];
  afterFacts: JevStateFacts;
  horizonFacts: JevStateFacts | null;
  extension: JevCandidateExtension | null;
}

export interface JevExtensionSummary {
  policyVersion: typeof JEV_EXTENSION_POLICY_VERSION;
  maxDepth: 6;
  attemptedCandidates: number;
  completedCandidates: number;
  nodes: number;
  stopReason: JevAnalysisStopReason;
  scope: 'unstable-candidates-only';
}

export interface JevCandidateAnalysis {
  version: typeof JEV_SEARCH_VERSION;
  completedDepth: number;
  nodes: number;
  stopReason: JevAnalysisStopReason;
  candidates: JevAnalyzedCandidate[];
  extension: JevExtensionSummary;
}

class AnalysisHalt extends Error {
  constructor(readonly reason: Exclude<JevAnalysisStopReason, 'complete'>) {
    super(reason);
  }
}

interface AnalysisControl {
  deadlineMs: number;
  signal?: AbortSignal;
  stopReason: Exclude<JevAnalysisStopReason, 'complete'> | null;
}

interface SearchControl extends AnalysisControl {
  maxNodes: number;
  nodes: number;
}

interface SearchValue {
  score: number;
  principalVariation: Move[];
  proven: JevProof;
  proof: JevProofDetail | null;
  horizonState: GameState;
  horizonFacts: JevStateFacts;
}

interface ExactProofRecord {
  value: SearchValue;
  searchedDepth: number;
}

interface InternalCandidate extends JevAnalyzedCandidate {
  horizonState: GameState | null;
}

type RouteCache = Map<string, JevKingRoute>;

interface PositionSummary {
  result: GameResult | null;
  moves?: Move[];
}

// Current canonical getResult/legalMoves depend only on the turn, reserves, and
// board encoded by positionKey; they ignore history and positionCounts. If a
// repetition rule starts reading either field, this cache key must include it.
interface AnalysisCaches {
  routes: RouteCache;
  positions: Map<string, PositionSummary>;
  facts: Map<string, JevStateFacts>;
  moveOrder: Map<string, Move>;
}

function createAnalysisCaches(): AnalysisCaches {
  return {
    routes: new Map(),
    positions: new Map(),
    facts: new Map(),
    moveOrder: new Map(),
  };
}

function check(control: AnalysisControl): void {
  if (control.signal?.aborted) {
    control.stopReason = 'aborted';
    throw new AnalysisHalt('aborted');
  }
  if (Date.now() >= control.deadlineMs) {
    control.stopReason = 'deadline';
    throw new AnalysisHalt('deadline');
  }
}

function visit(control: SearchControl): void {
  check(control);
  if (control.nodes >= control.maxNodes) {
    control.stopReason = 'node-budget';
    throw new AnalysisHalt('node-budget');
  }
  control.nodes += 1;
}

function moveKey(move: Move): string {
  return move.kind === 'PLACE'
    ? `P:${move.to.r}:${move.to.c}`
    : `M:${move.from.r}:${move.from.c}:${move.to.r}:${move.to.c}`;
}

function coordKey(coord: Coord): string {
  return `${coord.r}:${coord.c}`;
}

function sameMove(left: Move, right: Move): boolean {
  return moveKey(left) === moveKey(right);
}

function positionSummary(
  state: GameState,
  key: string,
  config: RuleConfig,
  cache: Map<string, PositionSummary>,
): PositionSummary {
  const cached = cache.get(key);
  if (cached) return cached;
  const summary = { result: getResult(state, config) };
  cache.set(key, summary);
  return summary;
}

function positionMoves(
  state: GameState,
  config: RuleConfig,
  summary: PositionSummary,
): Move[] {
  if (!summary.moves) summary.moves = summary.result ? [] : legalMoves(state, config);
  return summary.moves;
}

function orderedMoves(moves: Move[], preferredMove: Move | undefined): Move[] {
  if (!preferredMove) return moves;
  const preferredIndex = moves.findIndex((move) => sameMove(move, preferredMove));
  if (preferredIndex <= 0) return moves;
  return [moves[preferredIndex]!, ...moves.slice(0, preferredIndex), ...moves.slice(preferredIndex + 1)];
}

function countMaterial(state: GameState, rootPlayer: Player): JevMaterialFacts {
  const other = opponent(rootPlayer);
  let own = state.guardsInHand[rootPlayer];
  let opposing = state.guardsInHand[other];
  for (const row of state.board) {
    for (const piece of row) {
      if (piece?.type !== 'GUARD') continue;
      if (piece.player === rootPlayer) own += 1;
      else opposing += 1;
    }
  }
  return { own, opponent: opposing };
}

function incompleteRoute(reason: 'deadline' | 'aborted' | null, exploredNodes = 0): JevKingRoute {
  return {
    status: 'incomplete',
    distance: null,
    firstSteps: [],
    firstStepsAreExamples: true,
    exploredNodes,
    reason,
    frozenBoard: true,
    excludesAttackedSquares: true,
  };
}

function terminalRoute(state: GameState, side: Player, config: RuleConfig): JevKingRoute {
  const king = findKing(state, side);
  if (!king) {
    return {
      status: 'unreachable', distance: null, firstSteps: [], firstStepsAreExamples: true, exploredNodes: 0,
      reason: 'king-missing', frozenBoard: true, excludesAttackedSquares: true,
    };
  }
  if (isGoalCell(side, king, config)) {
    return {
      status: 'reachable', distance: 0, firstSteps: [], firstStepsAreExamples: true, exploredNodes: 0,
      reason: 'goal', frozenBoard: true, excludesAttackedSquares: true,
    };
  }
  return {
    status: 'not-applicable', distance: null, firstSteps: [], firstStepsAreExamples: true, exploredNodes: 0,
    reason: 'terminal', frozenBoard: true, excludesAttackedSquares: true,
  };
}

function routeCacheKey(state: GameState, side: Player, config: RuleConfig): string {
  const board = state.board.map((row) => row.map((piece) => {
    if (!piece) return '.';
    const symbol = piece.type === 'KING' ? 'k' : 'g';
    return piece.player === 'BLACK' ? symbol : symbol.toUpperCase();
  }).join('')).join('/');
  return [
    side,
    board,
    config.boardSize,
    config.goalCells,
    config.placement,
    config.guardMove,
    Number(config.kingSurroundLoss),
    Number(config.noGuardOnGoal),
    Number(config.kingCapture),
  ].join('|');
}

function frozenKingRoute(
  state: GameState,
  side: Player,
  config: RuleConfig,
  control: AnalysisControl,
  cache: RouteCache,
): JevKingRoute {
  const cacheKey = routeCacheKey(state, side, config);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let exploredNodes = 0;
  try {
    check(control);
    const king = findKing(state, side);
    if (!king) {
      const missing = terminalRoute(state, side, config);
      cache.set(cacheKey, missing);
      return missing;
    }
    if (isGoalCell(side, king, config)) {
      const goal = terminalRoute(state, side, config);
      cache.set(cacheKey, goal);
      return goal;
    }

    const frozenBoard = state.board.map((row) => row.slice());
    frozenBoard[king.r]![king.c] = null;
    const enemy = opponent(side);
    const threatState: GameState = { ...state, board: frozenBoard, turn: enemy };
    const attacked = new Set<string>();
    if (config.kingCapture) {
      for (const move of legalMoves(threatState, config)) {
        check(control);
        if (move.kind !== 'MOVE') continue;
        const moving = threatState.board[move.from.r]?.[move.from.c];
        if (moving?.player === enemy && moving.type === 'GUARD') attacked.add(coordKey(move.to));
      }
    }

    const specialAttack = new Map<string, boolean>();
    const isAttacked = (coord: Coord): boolean => {
      if (!config.kingCapture || isGoalCell(side, coord, config)) return false;
      const key = coordKey(coord);
      if (attacked.has(key)) return true;
      if (!isAnyGoalCell(coord, config)) return false;
      const saved = specialAttack.get(key);
      if (saved !== undefined) return saved;
      check(control);
      const board = frozenBoard.map((row) => row.slice());
      board[coord.r]![coord.c] = { player: side, type: 'KING' };
      const virtual: GameState = { ...state, board, turn: enemy };
      const value = legalMoves(virtual, config).some((move) => {
        if (move.kind !== 'MOVE' || move.to.r !== coord.r || move.to.c !== coord.c) return false;
        const moving = virtual.board[move.from.r]?.[move.from.c];
        return moving?.player === enemy && moving.type === 'GUARD';
      });
      check(control);
      specialAttack.set(key, value);
      return value;
    };

    interface QueueEntry { at: Coord; distance: number; first: Coord | null }
    const queue: QueueEntry[] = [{ at: king, distance: 0, first: null }];
    const seen = new Map<string, number>([[coordKey(king), 0]]);
    let goalDistance: number | null = null;
    const goalFirstSteps = new Map<string, Coord>();

    for (let head = 0; head < queue.length; head += 1) {
      check(control);
      const node = queue[head]!;
      exploredNodes += 1;
      if (goalDistance !== null && node.distance >= goalDistance) continue;

      for (const [dr, dc] of ALL8) {
        check(control);
        const next = { r: node.at.r + dr, c: node.at.c + dc };
        if (!inBoard(state.board.length, next.r, next.c)) continue;
        if (frozenBoard[next.r]?.[next.c]) continue;
        const first = node.first ?? next;
        const distance = node.distance + 1;

        if (isGoalCell(side, next, config)) {
          if (goalDistance === null || distance < goalDistance) {
            goalDistance = distance;
            goalFirstSteps.clear();
          }
          if (distance === goalDistance) goalFirstSteps.set(coordKey(first), first);
          continue;
        }
        const surrounded = config.kingSurroundLoss && ORTHO.every(([sr, sc]) => {
          const r = next.r + sr;
          const c = next.c + sc;
          if (!inBoard(state.board.length, r, c)) return true;
          const piece = frozenBoard[r]?.[c];
          return piece !== null && piece !== undefined && piece.player !== side;
        });
        if (surrounded || isAttacked(next)) continue;

        const seenKey = coordKey(next);
        const priorDistance = seen.get(seenKey);
        if (priorDistance !== undefined && priorDistance <= distance) continue;
        seen.set(seenKey, distance);
        queue.push({ at: next, distance, first });
      }
    }

    const route: JevKingRoute = goalDistance === null
      ? {
          status: 'unreachable', distance: null, firstSteps: [], firstStepsAreExamples: true, exploredNodes,
          reason: 'blocked', frozenBoard: true, excludesAttackedSquares: true,
        }
      : {
          status: 'reachable', distance: goalDistance,
          firstSteps: [...goalFirstSteps.values()].sort((a, b) => a.r - b.r || a.c - b.c),
          firstStepsAreExamples: true,
          exploredNodes, reason: 'goal', frozenBoard: true, excludesAttackedSquares: true,
        };
    cache.set(cacheKey, route);
    return route;
  } catch (error: unknown) {
    if (!(error instanceof AnalysisHalt)) throw error;
    return incompleteRoute(error.reason === 'aborted' ? 'aborted' : 'deadline', exploredNodes);
  }
}

function routesFor(
  state: GameState,
  rootPlayer: Player,
  config: RuleConfig,
  control: AnalysisControl,
  cache: RouteCache,
): JevRoutePair {
  return {
    own: frozenKingRoute(state, rootPlayer, config, control, cache),
    opponent: frozenKingRoute(state, opponent(rootPlayer), config, control, cache),
  };
}

function stateFacts(
  state: GameState,
  rootPlayer: Player,
  config: RuleConfig,
  control: AnalysisControl,
  caches: AnalysisCaches,
  key = positionKey(state),
  summary = positionSummary(state, key, config, caches.positions),
): JevStateFacts {
  const cached = caches.facts.get(key);
  if (cached) return cached;
  const terminal = summary.result;
  const routes = terminal
    ? { own: terminalRoute(state, rootPlayer, config), opponent: terminalRoute(state, opponent(rootPlayer), config) }
    : routesFor(state, rootPlayer, config, control, caches.routes);
  const facts = {
    terminal,
    material: countMaterial(state, rootPlayer),
    routes,
    complete: routes.own.status !== 'incomplete' && routes.opponent.status !== 'incomplete',
  };
  // A deadline/abort may leave either route incomplete; never reuse that as a fact.
  if (facts.complete) caches.facts.set(key, facts);
  return facts;
}

function terminalValue(
  state: GameState,
  result: GameResult,
  rootPlayer: Player,
  plies: number,
  config: RuleConfig,
  control: AnalysisControl,
  caches: AnalysisCaches,
  key: string,
  summary: PositionSummary,
): SearchValue {
  const won = result.winner === rootPlayer;
  return {
    score: won ? TERMINAL_SCORE - plies : -TERMINAL_SCORE + plies,
    principalVariation: [],
    proven: won ? 'win' : 'loss',
    proof: { winner: result.winner, reason: result.reason, plies },
    horizonState: state,
    horizonFacts: stateFacts(state, rootPlayer, config, control, caches, key, summary),
  };
}

function routeEvaluation(route: JevKingRoute): number | null {
  if (route.status === 'reachable') return route.distance;
  if (route.status === 'unreachable') return Number.POSITIVE_INFINITY;
  return null;
}

function heuristicValue(
  state: GameState,
  rootPlayer: Player,
  config: RuleConfig,
  control: AnalysisControl,
  caches: AnalysisCaches,
  key: string,
  summary: PositionSummary,
): SearchValue {
  const facts = stateFacts(state, rootPlayer, config, control, caches, key, summary);
  if (!facts.complete) {
    const reason = control.stopReason ?? (control.signal?.aborted ? 'aborted' : 'deadline');
    throw new AnalysisHalt(reason);
  }
  const ownRoute = routeEvaluation(facts.routes.own);
  const opposingRoute = routeEvaluation(facts.routes.opponent);
  if (ownRoute === null || opposingRoute === null) {
    throw new Error('JEV path evaluator produced an unusable complete route');
  }

  let routeScore = 0;
  if (Number.isFinite(ownRoute) && Number.isFinite(opposingRoute)) {
    routeScore = 320 * (opposingRoute - ownRoute);
  } else if (Number.isFinite(ownRoute)) {
    routeScore = 35_000;
  } else if (Number.isFinite(opposingRoute)) {
    routeScore = -35_000;
  }
  const raw = 180 * (facts.material.own - facts.material.opponent) + routeScore;
  return {
    score: Math.max(-HEURISTIC_LIMIT, Math.min(HEURISTIC_LIMIT, raw)),
    principalVariation: [],
    proven: 'unknown',
    proof: null,
    horizonState: state,
    horizonFacts: facts,
  };
}

function preferred(left: SearchValue, right: SearchValue, maximizing: boolean): boolean {
  return maximizing ? left.score > right.score : left.score < right.score;
}

function combinedProof(
  maximizing: boolean,
  children: SearchValue[],
  searchedAllChildren: boolean,
): JevProof {
  if (maximizing) {
    if (children.some((child) => child.proven === 'win')) return 'win';
    if (searchedAllChildren && children.every((child) => child.proven === 'loss')) return 'loss';
  } else {
    if (children.some((child) => child.proven === 'loss')) return 'loss';
    if (searchedAllChildren && children.every((child) => child.proven === 'win')) return 'win';
  }
  return 'unknown';
}

function proofDetail(proven: JevProof, best: SearchValue, children: SearchValue[]): JevProofDetail | null {
  if (proven === 'unknown') return null;
  if (best.proven === proven) return best.proof;
  return children.find((child) => child.proven === proven)?.proof ?? null;
}

function searchNode(
  state: GameState,
  depthRemaining: number,
  pliesFromRoot: number,
  alpha: number,
  beta: number,
  rootPlayer: Player,
  config: RuleConfig,
  control: SearchControl,
  caches: AnalysisCaches,
): SearchValue {
  visit(control);
  const key = positionKey(state);
  const summary = positionSummary(state, key, config, caches.positions);
  const result = summary.result;
  if (result) {
    return terminalValue(
      state, result, rootPlayer, pliesFromRoot, config, control, caches, key, summary,
    );
  }
  if (depthRemaining === 0) {
    return heuristicValue(state, rootPlayer, config, control, caches, key, summary);
  }

  const maximizing = state.turn === rootPlayer;
  const children: SearchValue[] = [];
  let best: SearchValue | null = null;
  let bestMove: Move | null = null;
  let searchedAllChildren = true;
  const moves = orderedMoves(positionMoves(state, config, summary), caches.moveOrder.get(key));

  for (const [index, move] of moves.entries()) {
    const child = searchNode(
      applyMove(state, move), depthRemaining - 1, pliesFromRoot + 1,
      alpha, beta, rootPlayer, config, control, caches,
    );
    const withMove = { ...child, principalVariation: [move, ...child.principalVariation] };
    children.push(withMove);
    if (!best || preferred(withMove, best, maximizing)) {
      best = withMove;
      bestMove = move;
    }
    if (maximizing) alpha = Math.max(alpha, best.score);
    else beta = Math.min(beta, best.score);
    if (alpha >= beta) {
      searchedAllChildren = index === moves.length - 1;
      break;
    }
  }

  if (!best) throw new Error('JEV search found no moves in a non-terminal state');
  caches.moveOrder.set(key, bestMove!);
  const proven = combinedProof(maximizing, children, searchedAllChildren);
  return {
    ...best,
    proven,
    proof: proofDetail(proven, best, children),
  };
}

function searchCandidate(
  afterState: GameState,
  move: Move,
  depth: number,
  rootPlayer: Player,
  config: RuleConfig,
  control: SearchControl,
  caches: AnalysisCaches,
): SearchValue {
  const value = searchNode(
    afterState, depth - 1, 1,
    Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY,
    rootPlayer, config, control, caches,
  );
  return { ...value, principalVariation: [move, ...value.principalVariation] };
}

function unsearchedCandidate(move: Move): InternalCandidate {
  return {
    move,
    score: 0,
    searchedDepth: 0,
    proven: 'unknown',
    proof: null,
    principalVariation: [move],
    afterFacts: {
      terminal: null,
      material: { own: 0, opponent: 0 },
      routes: { own: incompleteRoute(null), opponent: incompleteRoute(null) },
      complete: false,
    },
    horizonFacts: null,
    extension: null,
    horizonState: null,
  };
}

function isExactProof(value: SearchValue | null): value is SearchValue {
  return value?.proven === 'win' || value?.proven === 'loss';
}

function withExactProof(
  candidate: InternalCandidate,
  exact: ExactProofRecord | null,
): InternalCandidate {
  if (!exact) return candidate;
  return {
    ...candidate,
    proven: exact.value.proven,
    proofSearchedDepth: exact.searchedDepth,
    proof: exact.value.proof,
    principalVariation: exact.value.principalVariation,
    horizonFacts: exact.value.horizonFacts,
    horizonState: exact.value.horizonState,
  };
}

function extensionReasons(
  state: GameState,
  facts: JevStateFacts,
  config: RuleConfig,
  control: AnalysisControl,
  caches: AnalysisCaches,
): JevExtensionReason[] {
  if (facts.terminal) return [];
  check(control);
  const key = positionKey(state);
  const summary = positionSummary(state, key, config, caches.positions);
  const moves = positionMoves(state, config, summary);
  const reasons = new Set<JevExtensionReason>();
  for (const move of moves) {
    check(control);
    const after = applyMove(state, move);
    const afterKey = positionKey(after);
    if (positionSummary(after, afterKey, config, caches.positions).result) reasons.add('terminal-threat');
    if (move.kind === 'MOVE' && state.board[move.to.r]?.[move.to.c]) reasons.add('capture-sequence');
  }
  const own = facts.routes.own;
  const opposing = facts.routes.opponent;
  if (
    (own.status === 'reachable' && own.distance !== null && own.distance <= 2)
    || (opposing.status === 'reachable' && opposing.distance !== null && opposing.distance <= 2)
  ) reasons.add('goal-race');
  return [...reasons];
}

function validateSearchOptions(options: JevSearchOptions): { maxDepth: number; maxNodes: number } {
  if (!Number.isFinite(options.deadlineMs)) throw new Error('JEV analysis requires a finite deadlineMs');
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH) {
    throw new Error(`JEV search maxDepth must be an integer from 1 to ${MAX_DEPTH}`);
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 0) {
    throw new Error('JEV search maxNodes must be a non-negative integer');
  }
  return { maxDepth, maxNodes };
}

export function analyzeJevFacts(
  state: GameState,
  config: RuleConfig,
  options: JevAnalysisOptions,
): JevFactsAnalysis {
  if (!Number.isFinite(options.deadlineMs)) throw new Error('JEV analysis requires a finite deadlineMs');
  if (getResult(state, config)) throw new Error('JEV facts cannot analyze a terminal state');

  const rootPlayer = state.turn;
  const moves = legalMoves(state, config);
  const caches = createAnalysisCaches();
  const control: AnalysisControl = {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
    stopReason: null,
  };
  const afterStates = moves.map((move) => applyMove(state, move));
  const records: JevRootMoveFacts[] = moves.map((move, index) => ({
    move,
    immediateWin: null,
    immediateLoss: null,
    opponentWinningReplies: [],
    checkedReplies: 0,
    repliesComplete: false,
    material: countMaterial(afterStates[index]!, rootPlayer),
    routes: { own: incompleteRoute(null), opponent: incompleteRoute(null) },
  }));

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const after = afterStates[index]!;
    try {
      check(control);
      const result = getResult(after, config);
      record.immediateWin = result?.winner === rootPlayer;
      record.immediateLoss = result?.winner === opponent(rootPlayer);
      if (result) {
        record.repliesComplete = true;
        continue;
      }
      const replies = legalMoves(after, config);
      for (const reply of replies) {
        check(control);
        const replyResult = getResult(applyMove(after, reply), config);
        record.checkedReplies += 1;
        if (replyResult?.winner === opponent(rootPlayer)) record.opponentWinningReplies.push(reply);
      }
      record.repliesComplete = true;
    } catch (error: unknown) {
      if (!(error instanceof AnalysisHalt)) throw error;
      break;
    }
  }

  const initialRoute = routesFor(state, rootPlayer, config, control, caches.routes);
  for (let index = 0; index < records.length; index += 1) {
    records[index]!.routes = stateFacts(
      afterStates[index]!, rootPlayer, config, control, caches,
    ).routes;
  }
  const analyzedMoves = records.filter((record) => (
    record.immediateWin !== null && record.immediateLoss !== null && record.repliesComplete
  )).length;
  const complete = analyzedMoves === records.length
    && initialRoute.own.status !== 'incomplete'
    && initialRoute.opponent.status !== 'incomplete'
    && records.every((record) => (
      record.routes.own.status !== 'incomplete' && record.routes.opponent.status !== 'incomplete'
    ));
  return {
    version: JEV_ANALYSIS_VERSION,
    rootPlayer,
    legalMoveCount: moves.length,
    initialRoute,
    complete,
    analyzedMoves,
    stopReason: complete ? 'complete' : (control.stopReason ?? 'deadline'),
    candidates: records,
  };
}

export function analyzeJevCandidates(
  state: GameState,
  config: RuleConfig,
  moves: Move[],
  options: JevSearchOptions,
): JevCandidateAnalysis {
  const normalized = validateSearchOptions(options);
  if (getResult(state, config)) throw new Error('JEV search cannot analyze a terminal state');
  if (moves.length === 0) throw new Error('JEV search requires at least one root move');
  const canonicalMoves = legalMoves(state, config);
  for (const move of moves) {
    if (!canonicalMoves.some((candidate) => sameMove(candidate, move))) {
      throw new Error(`JEV search received an illegal root move: ${moveKey(move)}`);
    }
  }

  const rootPlayer = state.turn;
  const caches = createAnalysisCaches();
  const control: SearchControl = {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
    stopReason: null,
    maxNodes: normalized.maxNodes,
    nodes: 0,
  };
  const afterStates = moves.map((move) => applyMove(state, move));
  const exactProofs: Array<ExactProofRecord | null> = moves.map(() => null);
  let committed = moves.map(unsearchedCandidate);
  let completedDepth = 0;
  let commonStopReason: JevAnalysisStopReason = 'complete';

  for (let depth = 1; depth <= normalized.maxDepth; depth += 1) {
    const pending: InternalCandidate[] = [];
    try {
      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index]!;
        const value = searchCandidate(
          afterStates[index]!, move, depth, rootPlayer, config, control, caches,
        );
        if (isExactProof(value)) exactProofs[index] = { value, searchedDepth: depth };
        pending.push({
          move,
          score: value.score,
          searchedDepth: depth,
          proven: value.proven,
          proof: value.proof,
          principalVariation: value.principalVariation,
          afterFacts: committed[0]!.afterFacts,
          horizonFacts: value.horizonFacts,
          extension: null,
          horizonState: value.horizonState,
        });
      }
      committed = pending.map((candidate, index) => withExactProof(candidate, exactProofs[index]!));
      completedDepth = depth;
    } catch (error: unknown) {
      if (!(error instanceof AnalysisHalt)) throw error;
      committed = committed.map((candidate, index) => withExactProof(candidate, exactProofs[index]!));
      commonStopReason = error.reason;
      break;
    }
  }

  const factControl: AnalysisControl = {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
    stopReason: control.stopReason,
  };
  for (let index = 0; index < committed.length; index += 1) {
    committed[index]!.afterFacts = stateFacts(
      afterStates[index]!, rootPlayer, config, factControl, caches,
    );
  }

  const extensionStartNodes = control.nodes;
  let extensionStopReason: JevAnalysisStopReason = 'complete';
  let attemptedCandidates = 0;
  let completedCandidates = 0;
  const extensionTargetDepth = Math.min(MAX_DEPTH, normalized.maxDepth + 2);

  if (completedDepth === normalized.maxDepth && extensionTargetDepth > completedDepth) {
    control.deadlineMs = Math.min(options.deadlineMs, Date.now() + EXTENSION_MAX_MS);
    for (let index = 0; index < committed.length; index += 1) {
      const candidate = committed[index]!;
      if (!candidate.horizonState || !candidate.horizonFacts) continue;
      let reasons: JevExtensionReason[];
      try {
        reasons = extensionReasons(
          candidate.horizonState, candidate.horizonFacts, config, control, caches,
        );
      } catch (error: unknown) {
        if (!(error instanceof AnalysisHalt)) throw error;
        extensionStopReason = error.reason;
        break;
      }
      if (reasons.length === 0) continue;
      attemptedCandidates += 1;
      const candidateStartNodes = control.nodes;
      let extensionValue: SearchValue | null = null;
      let searchedDepth = completedDepth;
      let candidateStop: JevAnalysisStopReason = 'complete';
      for (let depth = completedDepth + 1; depth <= extensionTargetDepth; depth += 1) {
        try {
          extensionValue = searchCandidate(
            afterStates[index]!, candidate.move, depth,
            rootPlayer, config, control, caches,
          );
          searchedDepth = depth;
          if (extensionValue.proven !== 'unknown') break;
        } catch (error: unknown) {
          if (!(error instanceof AnalysisHalt)) throw error;
          candidateStop = error.reason;
          extensionStopReason = error.reason;
          break;
        }
      }
      const exact = extensionValue?.proven === 'win' || extensionValue?.proven === 'loss';
      const requestedDepth = exact ? searchedDepth : extensionTargetDepth;
      const completed = exact || searchedDepth === extensionTargetDepth;
      if (completed) completedCandidates += 1;
      candidate.extension = {
        requestedDepth,
        searchedDepth,
        completed,
        nodes: control.nodes - candidateStartNodes,
        stopReason: completed ? 'complete' : candidateStop,
        reasons,
        score: extensionValue?.score ?? null,
        proven: extensionValue?.proven ?? 'unknown',
        proof: extensionValue?.proof ?? null,
        principalVariation: extensionValue?.principalVariation ?? candidate.principalVariation,
        horizonFacts: extensionValue?.horizonFacts ?? candidate.horizonFacts,
      };
      if (exact && extensionValue) {
        candidate.proven = extensionValue.proven;
        candidate.proofSearchedDepth = searchedDepth;
        candidate.proof = extensionValue.proof;
        candidate.principalVariation = extensionValue.principalVariation;
        candidate.horizonFacts = extensionValue.horizonFacts;
        candidate.horizonState = extensionValue.horizonState;
      }
      if (!completed) break;
    }
  }

  const publicCandidates: JevAnalyzedCandidate[] = committed.map(({ horizonState: _state, ...candidate }) => candidate);
  return {
    version: JEV_SEARCH_VERSION,
    completedDepth,
    nodes: control.nodes,
    stopReason: completedDepth === normalized.maxDepth ? 'complete' : commonStopReason,
    candidates: publicCandidates,
    extension: {
      policyVersion: JEV_EXTENSION_POLICY_VERSION,
      maxDepth: 6,
      attemptedCandidates,
      completedCandidates,
      nodes: control.nodes - extensionStartNodes,
      stopReason: extensionStopReason,
      scope: 'unstable-candidates-only',
    },
  };
}
