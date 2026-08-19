import type { RuleConfig } from '../../src/core/config';
import type { GameState, Move, PieceType, Player } from '../../src/core/types';
import { applyMove } from '../../src/core/apply';
import { initialState } from '../../src/core/rules';
import { fromSquare, toSquare } from './coords';
import type {
  FinishedGameInput,
  MgnAnnotation,
  MgnGame,
  MgnHeaders,
  MgnMoveEntry,
  MgnResult,
} from './types';
import { MGN_VERSION } from './types';

const CONFIG_KEYS: (keyof RuleConfig)[] = [
  'boardSize',
  'guardCount',
  'goalCells',
  'placement',
  'guardMove',
  'kingSurroundLoss',
  'noGuardOnGoal',
  'kingCapture',
];

const ANNOTATIONS: MgnAnnotation[] = ['!!', '??', '!?', '?!', '!', '?'];

function pieceLetter(type: PieceType): 'K' | 'G' {
  return type === 'KING' ? 'K' : 'G';
}

function moveToken(move: Move, state: GameState, boardSize: number): string {
  if (move.kind === 'PLACE') {
    return `@${toSquare(move.to, boardSize)}`;
  }
  const piece = state.board[move.from.r][move.from.c]!;
  const from = toSquare(move.from, boardSize);
  const to = toSquare(move.to, boardSize);
  const captured = state.board[move.to.r][move.to.c];
  const sep = captured ? 'x' : '-';
  return `${pieceLetter(piece.type)}${from}${sep}${to}`;
}

export function formatMovetextFromMoves(moves: Move[], config: RuleConfig): string {
  const entries: MgnMoveEntry[] = moves.map((move) => ({ move }));
  return formatMovetext(entries, config.boardSize, config);
}

function formatMovetext(moves: MgnMoveEntry[], boardSize: number, config: RuleConfig): string {
  let state = initialState(config);
  const parts: string[] = [];
  let moveNo = 1;
  let blackTurn = true;

  for (const entry of moves) {
    const token = moveToken(entry.move, state, boardSize);
    const suffix = `${entry.annotation ?? ''}`;
    const withAnnot = suffix ? `${token}${suffix}` : token;
    const comment = entry.comment ? ` {${entry.comment}}` : '';

    if (blackTurn) {
      parts.push(`${moveNo}. ${withAnnot}${comment}`);
    } else {
      parts[parts.length - 1] += ` ${withAnnot}${comment}`;
      moveNo += 1;
    }

    state = applyMove(state, entry.move);
    blackTurn = !blackTurn;
  }

  return parts.join(' ');
}

function parseConfig(headers: Record<string, string>): RuleConfig {
  const readBool = (key: string, fallback: boolean) => {
    const raw = headers[key];
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };
  const readNum = (key: string, fallback: number) => {
    const raw = headers[key];
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) throw new Error(`잘못된 숫자 헤더 [${key}]: ${raw}`);
    return n;
  };

  const goalCells = headers.goalCells as RuleConfig['goalCells'] | undefined;
  const placement = headers.placement as RuleConfig['placement'] | undefined;
  const guardMove = headers.guardMove as RuleConfig['guardMove'] | undefined;

  return {
    boardSize: readNum('boardSize', 9),
    guardCount: readNum('guardCount', 8),
    goalCells: goalCells ?? 'center-3',
    placement: placement ?? 'adjacent',
    guardMove: guardMove ?? 'step',
    kingSurroundLoss: readBool('kingSurroundLoss', true),
    noGuardOnGoal: readBool('noGuardOnGoal', true),
    kingCapture: readBool('kingCapture', true),
  };
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    const match = trimmed.match(/^\[(\w+)\s+"(.*)"\]$/);
    if (match) headers[match[1]] = match[2];
  }
  return headers;
}

function parseResult(raw: string): MgnResult {
  const upper = raw.toUpperCase();
  if (upper === 'BLACK' || upper === '흑' || upper === '1-0') return 'BLACK';
  if (upper === 'WHITE' || upper === '백' || upper === '0-1') return 'WHITE';
  if (upper === 'DRAW' || upper === '½-½' || upper === '1/2-1/2') return 'DRAW';
  throw new Error(`알 수 없는 Result: ${raw}`);
}

function stripAnnotation(token: string): { token: string; annotation?: MgnAnnotation } {
  for (const ann of ANNOTATIONS) {
    if (token.endsWith(ann)) {
      return { token: token.slice(0, -ann.length), annotation: ann };
    }
  }
  return { token };
}

function parseMoveToken(token: string, state: GameState, boardSize: number): Move {
  if (token.startsWith('@')) {
    return { kind: 'PLACE', to: fromSquare(token.slice(1), boardSize) };
  }

  const match = token.match(/^([KG])([a-k]\d+)([x-])([a-k]\d+)$/i);
  if (!match) throw new Error(`잘못된 수 표기: ${token}`);

  const from = fromSquare(match[2], boardSize);
  const to = fromSquare(match[4], boardSize);
  const piece = state.board[from.r][from.c];
  if (!piece) throw new Error(`출발 칸에 말 없음: ${token}`);
  const expected = match[1].toUpperCase() === 'K' ? 'KING' : 'GUARD';
  if (piece.type !== expected) {
    throw new Error(`말 종류 불일치 ${token}: 기대 ${expected}, 실제 ${piece.type}`);
  }
  return { kind: 'MOVE', from, to };
}

function parseMovetext(movetext: string, config: RuleConfig): MgnMoveEntry[] {
  let state = initialState(config);
  const entries: MgnMoveEntry[] = [];
  const withoutComments = movetext.replace(/\{[^}]*\}/g, (comment) => {
    return ' '.repeat(comment.length);
  });

  const tokens = withoutComments
    .replace(/\d+\./g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const comments: string[] = [];
  const commentRe = /\{([^}]*)\}/g;
  let commentMatch: RegExpExecArray | null;
  while ((commentMatch = commentRe.exec(movetext)) !== null) {
    comments.push(commentMatch[1].trim());
  }
  let commentIdx = 0;

  for (const raw of tokens) {
    const { token, annotation } = stripAnnotation(raw);
    const move = parseMoveToken(token, state, config.boardSize);
    const entry: MgnMoveEntry = { move };
    if (annotation) entry.annotation = annotation;
    if (comments[commentIdx]) {
      entry.comment = comments[commentIdx];
      commentIdx += 1;
    }
    entries.push(entry);
    state = applyMove(state, move);
  }

  return entries;
}

export function serializeGame(game: MgnGame): string {
  const h = game.headers;
  const lines: string[] = [`[MGN "${h.mgn}"]`];

  const optional: (keyof MgnHeaders)[] = [
    'event',
    'site',
    'date',
    'round',
    'opponentId',
    'botSide',
    'termination',
  ];
  for (const key of optional) {
    const val = h[key];
    if (typeof val === 'string' && val) lines.push(`[${key} "${val}"]`);
  }

  lines.push(`[Black "${h.black}"]`);
  lines.push(`[White "${h.white}"]`);
  lines.push(`[Result "${h.result}"]`);

  for (const key of CONFIG_KEYS) {
    lines.push(`[${key} "${String(h.config[key])}"]`);
  }

  const movetext = formatMovetext(game.moves, h.config.boardSize, h.config);
  return `${lines.join('\n')}\n\n${movetext}\n`;
}

export function parseGame(text: string): MgnGame {
  const blocks = text.trim().split(/\n\s*\n/);
  const headerBlock = blocks[0] ?? '';
  const movetext = blocks.slice(1).join(' ').trim();

  const raw = parseHeaders(headerBlock);
  const config = parseConfig(raw);

  const headers: MgnHeaders = {
    mgn: raw.MGN ?? MGN_VERSION,
    event: raw.event,
    site: raw.site,
    date: raw.date,
    round: raw.round,
    black: raw.Black ?? 'Anonymous',
    white: raw.White ?? 'Anonymous',
    result: parseResult(raw.Result ?? 'DRAW'),
    termination: raw.termination as MgnHeaders['termination'],
    opponentId: raw.opponentId,
    botSide: raw.botSide as Player | undefined,
    config,
  };

  return {
    headers,
    moves: movetext ? parseMovetext(movetext, config) : [],
  };
}

export function gameFromFinished(input: FinishedGameInput): MgnGame {
  const winner = input.result.winner;
  const moves: MgnMoveEntry[] = input.moves.map((move) => ({ move }));

  return {
    headers: {
      mgn: MGN_VERSION,
      event: input.meta.event ?? 'Casual Game',
      site: input.meta.site ?? 'mongjin',
      date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      black: input.meta.black,
      white: input.meta.white,
      result: winner,
      termination: input.result.reason,
      opponentId: input.meta.opponentId,
      botSide: input.meta.botSide,
      config: { ...input.config },
    },
    moves,
  };
}

export function movesFromGame(game: MgnGame): Move[] {
  return game.moves.map((e) => e.move);
}
