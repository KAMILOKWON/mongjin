// Mandako model codec adapted from the local training project; rules remain in src/core.
/**
 * Mandako compact-state, STM feature, and action-id codec.
 *
 * Compact board is row-major length 81 with 0 empty, 1 black king, 2 black guard,
 * 3 white king, 4 white guard. Features are NCHW float[7*9*9] from the side to
 * move: own king/guard, opponent king/guard, own hand/8, opponent hand/8, and
 * BLACK-to-move. White-to-move positions rotate 180° (r,c -> 8-r,8-c).
 * Actions: 0..80 PLACE at a canonical cell; 81 + fromCell*8 + dirIndex MOVE
 * with directions [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)].
 *
 * Rules, legality, and results come only from src/core. Search states compress
 * history to [] and positionCounts to {}.
 */
import { applyMove } from '../src/core/apply.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { getResult, type GameResult } from '../src/core/result.js';
import { inBoard, legalMoves, opponent } from '../src/core/rules.js';
import type { Coord, GameState, Move, Piece, Player } from '../src/core/types.js';

export const BOARD_SIZE = 9;
export const PLACE_ACTION_COUNT = BOARD_SIZE * BOARD_SIZE;
export const DIRECTION_COUNT = 8;
export const ACTION_SIZE = PLACE_ACTION_COUNT + PLACE_ACTION_COUNT * DIRECTION_COUNT;
export const FEATURE_PLANES = 7;
export const FEATURE_SIZE = FEATURE_PLANES * PLACE_ACTION_COUNT;
export const GUARD_COUNT = DEFAULT_CONFIG.guardCount;

/** Canonical MOVE directions in STM coordinates. Index is part of the action id. */
export const MOVE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export const PIECE_EMPTY = 0;
export const PIECE_BLACK_KING = 1;
export const PIECE_BLACK_GUARD = 2;
export const PIECE_WHITE_KING = 3;
export const PIECE_WHITE_GUARD = 4;

export interface CompactState {
  board: number[];
  turn: Player;
  hands: [number, number];
}

export interface Snapshot {
  state: CompactState;
  features: number[];
  legalActions: number[];
  result: GameResult | null;
}

function isPlayer(value: unknown): value is Player {
  return value === 'BLACK' || value === 'WHITE';
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function cellIndex(r: number, c: number): number {
  return r * BOARD_SIZE + c;
}

function coordFromCell(index: number): Coord {
  return { r: Math.floor(index / BOARD_SIZE), c: index % BOARD_SIZE };
}

/** Physical board coord -> STM canonical coord. 180° rotation is an involution. */
export function toCanonicalCoord(coord: Coord, turn: Player): Coord {
  if (turn === 'BLACK') return { r: coord.r, c: coord.c };
  return { r: BOARD_SIZE - 1 - coord.r, c: BOARD_SIZE - 1 - coord.c };
}

function encodePiece(piece: Piece | null): number {
  if (!piece) return PIECE_EMPTY;
  if (piece.player === 'BLACK') return piece.type === 'KING' ? PIECE_BLACK_KING : PIECE_BLACK_GUARD;
  return piece.type === 'KING' ? PIECE_WHITE_KING : PIECE_WHITE_GUARD;
}

function decodePiece(value: number): Piece | null {
  switch (value) {
    case PIECE_EMPTY:
      return null;
    case PIECE_BLACK_KING:
      return { player: 'BLACK', type: 'KING' };
    case PIECE_BLACK_GUARD:
      return { player: 'BLACK', type: 'GUARD' };
    case PIECE_WHITE_KING:
      return { player: 'WHITE', type: 'KING' };
    case PIECE_WHITE_GUARD:
      return { player: 'WHITE', type: 'GUARD' };
    default:
      throw new Error(`piece value must be an integer in 0..4, got ${value}`);
  }
}

function countKings(board: number[], piece: number): number {
  let count = 0;
  for (const cell of board) {
    if (cell === piece) count += 1;
  }
  return count;
}

function assertBoardShape(board: (Piece | null)[][]): void {
  if (board.length !== BOARD_SIZE || board.some((row) => row.length !== BOARD_SIZE)) {
    throw new Error(`board must be ${BOARD_SIZE}x${BOARD_SIZE}`);
  }
}

function assertHands(black: unknown, white: unknown): asserts black is number {
  if (!isIntInRange(black, 0, GUARD_COUNT) || !isIntInRange(white, 0, GUARD_COUNT)) {
    throw new Error(`hands must be two integers in 0..${GUARD_COUNT}`);
  }
}

function assertAtMostOneKing(board: number[]): void {
  const blackKings = countKings(board, PIECE_BLACK_KING);
  const whiteKings = countKings(board, PIECE_WHITE_KING);
  if (blackKings > 1) throw new Error('expected at most one BLACK king');
  if (whiteKings > 1) throw new Error('expected at most one WHITE king');
}

export function encodeState(state: GameState): CompactState {
  assertBoardShape(state.board);
  if (!isPlayer(state.turn)) throw new Error('turn must be BLACK or WHITE');
  assertHands(state.guardsInHand.BLACK, state.guardsInHand.WHITE);

  const board: number[] = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      board.push(encodePiece(state.board[r]![c] ?? null));
    }
  }
  assertAtMostOneKing(board);

  return {
    board,
    turn: state.turn,
    hands: [state.guardsInHand.BLACK, state.guardsInHand.WHITE],
  };
}

export function decodeState(input: CompactState | unknown): GameState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('compact state must be an object');
  }
  const compact = input as { board?: unknown; turn?: unknown; hands?: unknown };
  const boardValues = compact.board;
  if (!Array.isArray(boardValues) || boardValues.length !== PLACE_ACTION_COUNT) {
    throw new Error(`board must contain ${PLACE_ACTION_COUNT} integers in 0..4`);
  }
  for (const value of boardValues) {
    if (!isIntInRange(value, PIECE_EMPTY, PIECE_WHITE_GUARD)) {
      throw new Error(`board must contain ${PLACE_ACTION_COUNT} integers in 0..4`);
    }
  }
  assertAtMostOneKing(boardValues);
  if (!isPlayer(compact.turn)) throw new Error('turn must be BLACK or WHITE');

  const hands = compact.hands;
  if (!Array.isArray(hands) || hands.length !== 2) {
    throw new Error(`hands must be two integers in 0..${GUARD_COUNT}`);
  }
  assertHands(hands[0], hands[1]);

  const board: (Piece | null)[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  );
  for (let index = 0; index < PLACE_ACTION_COUNT; index += 1) {
    const { r, c } = coordFromCell(index);
    board[r]![c] = decodePiece(boardValues[index]!);
  }

  return {
    board,
    turn: compact.turn,
    guardsInHand: { BLACK: hands[0], WHITE: hands[1] },
    history: [],
    positionCounts: {},
  };
}

export function encodeFeatures(state: GameState): number[] {
  assertBoardShape(state.board);
  if (!isPlayer(state.turn)) throw new Error('turn must be BLACK or WHITE');
  assertHands(state.guardsInHand.BLACK, state.guardsInHand.WHITE);

  const features = Array.from({ length: FEATURE_SIZE }, () => 0);
  const own = state.turn;
  const opp = opponent(own);

  const write = (plane: number, r: number, c: number, value: number): void => {
    const canonical = toCanonicalCoord({ r, c }, own);
    features[plane * PLACE_ACTION_COUNT + cellIndex(canonical.r, canonical.c)] = value;
  };

  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const piece = state.board[r]![c];
      if (!piece) continue;
      if (piece.player === own && piece.type === 'KING') write(0, r, c, 1);
      else if (piece.player === own && piece.type === 'GUARD') write(1, r, c, 1);
      else if (piece.player === opp && piece.type === 'KING') write(2, r, c, 1);
      else if (piece.player === opp && piece.type === 'GUARD') write(3, r, c, 1);
    }
  }

  const ownHand = state.guardsInHand[own] / GUARD_COUNT;
  const oppHand = state.guardsInHand[opp] / GUARD_COUNT;
  const blackToMove = own === 'BLACK' ? 1 : 0;
  for (let index = 0; index < PLACE_ACTION_COUNT; index += 1) {
    features[4 * PLACE_ACTION_COUNT + index] = ownHand;
    features[5 * PLACE_ACTION_COUNT + index] = oppHand;
    features[6 * PLACE_ACTION_COUNT + index] = blackToMove;
  }
  return features;
}

function directionIndex(dr: number, dc: number): number {
  for (let index = 0; index < MOVE_DIRECTIONS.length; index += 1) {
    const [expectedDr, expectedDc] = MOVE_DIRECTIONS[index]!;
    if (expectedDr === dr && expectedDc === dc) return index;
  }
  throw new Error('move is not a canonical one-step action');
}

export function actionId(state: GameState, move: Move): number {
  assertBoardShape(state.board);
  if (!isPlayer(state.turn)) throw new Error('turn must be BLACK or WHITE');
  if (move.kind === 'PLACE') {
    const to = toCanonicalCoord(move.to, state.turn);
    if (!inBoard(BOARD_SIZE, to.r, to.c)) throw new Error('action leaves the board');
    return cellIndex(to.r, to.c);
  }
  const from = toCanonicalCoord(move.from, state.turn);
  const to = toCanonicalCoord(move.to, state.turn);
  if (!inBoard(BOARD_SIZE, from.r, from.c) || !inBoard(BOARD_SIZE, to.r, to.c)) {
    throw new Error('action leaves the board');
  }
  const dir = directionIndex(to.r - from.r, to.c - from.c);
  return PLACE_ACTION_COUNT + cellIndex(from.r, from.c) * DIRECTION_COUNT + dir;
}

export function moveForAction(state: GameState, action: number): Move {
  assertBoardShape(state.board);
  if (!isPlayer(state.turn)) throw new Error('turn must be BLACK or WHITE');
  if (!isIntInRange(action, 0, ACTION_SIZE - 1)) {
    throw new Error(`action must be an integer in 0..${ACTION_SIZE - 1}`);
  }
  if (action < PLACE_ACTION_COUNT) {
    return { kind: 'PLACE', to: toCanonicalCoord(coordFromCell(action), state.turn) };
  }
  const moveIndex = action - PLACE_ACTION_COUNT;
  const fromCell = Math.floor(moveIndex / DIRECTION_COUNT);
  const dirIndex = moveIndex % DIRECTION_COUNT;
  const canonicalFrom = coordFromCell(fromCell);
  const [dr, dc] = MOVE_DIRECTIONS[dirIndex]!;
  const canonicalTo = { r: canonicalFrom.r + dr, c: canonicalFrom.c + dc };
  if (!inBoard(BOARD_SIZE, canonicalTo.r, canonicalTo.c)) {
    throw new Error('action leaves the board');
  }
  return {
    kind: 'MOVE',
    from: toCanonicalCoord(canonicalFrom, state.turn),
    to: toCanonicalCoord(canonicalTo, state.turn),
  };
}

export function legalActions(state: GameState): number[] {
  if (getResult(state, DEFAULT_CONFIG) !== null) return [];
  return legalMoves(state, DEFAULT_CONFIG).map((move) => actionId(state, move));
}

export function snapshotFromState(state: GameState): Snapshot {
  return {
    state: encodeState(state),
    features: encodeFeatures(state),
    legalActions: legalActions(state),
    result: getResult(state, DEFAULT_CONFIG),
  };
}

export function applyAction(state: GameState, action: number): GameState {
  if (getResult(state, DEFAULT_CONFIG) !== null) throw new Error('game is already over');
  const move = moveForAction(state, action);
  if (!legalMoves(state, DEFAULT_CONFIG).some((candidate) => JSON.stringify(candidate) === JSON.stringify(move))) throw new Error('illegal action');
  return applyMove(state, move);
}
