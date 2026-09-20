import type { RuleConfig } from '../src/core/config';
import { goalCellsFor, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move, Piece, Player } from '../src/core/types';

const JEV_MODEL = 'typesafe-ai/jev';
const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_CHOICES = 255;

export type JevErrorCode =
  | 'http_429'
  | 'http_error'
  | 'worker_error'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'non_free';

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.status = status;
  }
}

export interface JevMoveOptions {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface JevMoveResult {
  move: Move | null;
  elapsedMs: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

interface JevState {
  rules: string[];
  coordinates: string;
  boardLegend: string;
  board: string[];
  sideToMove: 'SELF';
  selfDirection: string;
  selfGoalCells: string[];
  opponentGoalCells: string[];
  guardsInHand: { self: number; opponent: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coordinate(r: number, c: number): string {
  return `(${r},${c})`;
}

function describePiece(piece: Piece): string {
  return piece.type === 'KING' ? 'king' : 'guard';
}

function describeMove(state: GameState, move: Move): string {
  if (move.kind === 'PLACE') {
    return `Place a SELF guard at ${coordinate(move.to.r, move.to.c)}.`;
  }

  const piece = state.board[move.from.r]?.[move.from.c];
  const target = state.board[move.to.r]?.[move.to.c];
  const moving = piece ? describePiece(piece) : 'piece';
  const capture = target
    ? ` and capture the OPPONENT ${describePiece(target)}`
    : '';
  return `Move the SELF ${moving} from ${coordinate(move.from.r, move.from.c)} to ${coordinate(move.to.r, move.to.c)}${capture}.`;
}

function ruleSummary(config: RuleConfig): string[] {
  const placement = config.placement === 'adjacent'
    ? 'A reserve guard may be placed on an empty orthogonally adjacent cell to any SELF piece.'
    : 'A reserve guard may be placed on any empty cell in SELF territory (strictly beyond the center row toward SELF home).';
  const guardMovement = config.guardMove === 'step'
    ? 'A guard moves one orthogonal step to an empty cell or captures an OPPONENT guard.'
    : 'A guard slides orthogonally through empty cells and may stop on an empty cell or capture the first OPPONENT guard.';
  const kingCapture = config.kingCapture
    ? 'A guard may capture the OPPONENT king for an immediate win.'
    : 'The OPPONENT king cannot be captured.';
  const goalRestriction = config.noGuardOnGoal
    ? 'Guards cannot stop on either side\'s goal cells, except when capturing a king ends the game.'
    : 'Guards may stop on goal cells.';
  const surround = config.kingSurroundLoss
    ? 'A side loses if all four orthogonal neighbors of its king are board edges or OPPONENT pieces.'
    : 'King surround is not a loss condition.';

  return [
    'Choose exactly one listed legal action for SELF.',
    'A king moves one cell in any of eight directions, only to an empty cell.',
    placement,
    guardMovement,
    kingCapture,
    goalRestriction,
    'A side wins when its king reaches one of its far-edge goal cells.',
    surround,
    'A side with no legal action loses.',
  ];
}

function boardCell(piece: Piece | null, self: Player): string {
  if (!piece) return '.';
  if (piece.player === self) return piece.type === 'KING' ? 'K' : 'G';
  return piece.type === 'KING' ? 'k' : 'g';
}

export function describeJevState(state: GameState, config: RuleConfig): JevState {
  const self = state.turn;
  const other = opponent(self);
  return {
    rules: ruleSummary(config),
    coordinates: `Zero-based (row,column). Row 0 is the first board row shown; column 0 is left. Board size is ${config.boardSize}x${config.boardSize}.`,
    boardLegend: 'K=SELF king, G=SELF guard, k=OPPONENT king, g=OPPONENT guard, .=empty.',
    board: state.board.map(
      (row, r) => `${r}: ${row.map((piece) => boardCell(piece, self)).join('')}`,
    ),
    sideToMove: 'SELF',
    selfDirection: self === 'BLACK'
      ? 'SELF advances toward decreasing row numbers; OPPONENT advances toward increasing row numbers.'
      : 'SELF advances toward increasing row numbers; OPPONENT advances toward decreasing row numbers.',
    selfGoalCells: goalCellsFor(self, config).map((cell) => coordinate(cell.r, cell.c)),
    opponentGoalCells: goalCellsFor(other, config).map((cell) => coordinate(cell.r, cell.c)),
    guardsInHand: {
      self: state.guardsInHand[self],
      opponent: state.guardsInHand[other],
    },
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reportedCost(payload: Record<string, unknown>): number | null {
  const providerMetadata = payload.providerMetadata;
  if (!isRecord(providerMetadata)) return null;
  const gateway = providerMetadata.gateway;
  if (!isRecord(gateway) || !Object.hasOwn(gateway, 'cost')) return null;
  const raw = gateway.cost;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function validateProbabilities(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(value, key)) return false;
    const probability = value[key];
    return typeof probability === 'number'
      && Number.isFinite(probability)
      && probability >= 0
      && probability <= 1;
  });
}

export async function chooseJevMove(
  state: GameState,
  config: RuleConfig,
  options: JevMoveOptions,
): Promise<JevMoveResult> {
  const startedAt = Date.now();
  const moves = legalMoves(state, config);
  if (moves.length === 0) {
    return {
      move: null,
      elapsedMs: Date.now() - startedAt,
      model: JEV_MODEL,
      inputTokens: null,
      outputTokens: null,
      cost: null,
    };
  }
  if (moves.length > MAX_CHOICES) {
    throw new JevError('invalid_response', `JEV supports at most ${MAX_CHOICES} choices.`);
  }

  const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
  const moveByKey = new Map<string, Move>();
  for (const [index, move] of moves.entries()) {
    const key = `m${index}`;
    criteria[key] = describeMove(state, move);
    moveByKey.set(key, move);
  }

  const requestBody = {
    model: JEV_MODEL,
    state: describeJevState(state, config),
    questions: {
      move: {
        type: 'choice',
        instructions: 'Choose the legal action that gives SELF the best chance to win under the supplied rules. Return exactly one listed choice.',
        criteria,
      },
    },
  };

  const controller = new AbortController();
  let stoppedBy: 'timeout' | 'aborted' | undefined;
  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : Math.max(0, Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS);
  const stop = (reason: 'timeout' | 'aborted') => {
    if (stoppedBy) return;
    stoppedBy = reason;
    controller.abort(new DOMException(reason === 'timeout' ? 'Timed out' : 'Aborted', 'AbortError'));
  };
  const onCallerAbort = () => stop('aborted');
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);

  const throwRequestError = (error: unknown): never => {
    if (stoppedBy === 'timeout') throw new JevError('timeout', 'JEV request timed out.');
    if (stoppedBy === 'aborted') throw new JevError('aborted', 'JEV request was aborted.');
    if (error instanceof JevError) throw error;
    throw new JevError('http_error', 'JEV request failed.');
  };

  try {
    let response: Response;
    try {
      response = await withAbort(
        (options.fetchImpl ?? fetch)(EVALUATE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error: unknown) {
      return throwRequestError(error);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new JevError('http_429', 'JEV request was rate limited.', response.status);
      }
      throw new JevError('http_error', `JEV request failed with HTTP ${response.status}.`, response.status);
    }

    let rawPayload: unknown;
    try {
      rawPayload = await withAbort(response.json(), controller.signal);
    } catch (error: unknown) {
      if (stoppedBy) return throwRequestError(error);
      throw new JevError('invalid_response', 'JEV returned an unreadable response.');
    }
    if (!isRecord(rawPayload)) {
      throw new JevError('invalid_response', 'JEV returned a malformed response.');
    }
    if (Object.hasOwn(rawPayload, 'model') && rawPayload.model !== JEV_MODEL) {
      throw new JevError('invalid_response', 'JEV returned an unexpected model.');
    }

    const cost = reportedCost(rawPayload);
    if (cost !== null && cost !== 0) {
      throw new JevError('non_free', 'JEV reported a nonzero request cost.');
    }

    const answers = rawPayload.answers;
    const moveAnswer = isRecord(answers) ? answers.move : undefined;
    if (
      !isRecord(moveAnswer)
      || moveAnswer.type !== 'choice'
      || typeof moveAnswer.choice !== 'string'
      || !moveByKey.has(moveAnswer.choice)
      || !validateProbabilities(moveAnswer.probabilities, [...moveByKey.keys()])
    ) {
      throw new JevError('invalid_response', 'JEV returned an invalid move choice.');
    }

    const usage = rawPayload.usage;
    return {
      move: moveByKey.get(moveAnswer.choice)!,
      elapsedMs: Date.now() - startedAt,
      model: JEV_MODEL,
      inputTokens: isRecord(usage) ? tokenCount(usage.inputTokens) : null,
      outputTokens: isRecord(usage) ? tokenCount(usage.outputTokens) : null,
      cost,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
