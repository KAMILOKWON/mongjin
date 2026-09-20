import { moveKey } from '../src/bot/moveKey';
import type { RuleConfig } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { initialState, positionKey } from '../src/core/rules';
import type { Coord, GameState, Move, Player } from '../src/core/types';
import { RECORD_RULES_VERSION, replayRecord, type GameRecord } from './gameRecords';

export interface HumanStyleSample {
  record: GameRecord;
  eligibleSide: Player;
}

/** Only position/move frequencies, never account data or source match identifiers. */
export interface HumanStyleBook {
  version: 1;
  rulesVersion: string;
  games: number;
  moves: number;
  positions: Record<string, Record<string, number>>;
}

export function humanStylePositionKey(state: GameState, config: RuleConfig): string {
  const rules = Object.entries(config).sort(([a], [b]) => a.localeCompare(b));
  return `${JSON.stringify(rules)}:${positionKey(state)}`;
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function coordinate(value: unknown): Coord {
  if (!hasKeys(value, ['r', 'c']) || typeof value.r !== 'number' || !Number.isInteger(value.r)
    || typeof value.c !== 'number' || !Number.isInteger(value.c)) throw new Error('Invalid coordinate');
  return { r: value.r, c: value.c };
}

/** JSONB reorders keys. Normalize strict move objects before the existing replay validator. */
function canonicalMove(value: unknown): Move {
  if (hasKeys(value, ['kind', 'to']) && value.kind === 'PLACE') {
    return { kind: 'PLACE', to: coordinate(value.to) };
  }
  if (hasKeys(value, ['kind', 'from', 'to']) && value.kind === 'MOVE') {
    return { kind: 'MOVE', from: coordinate(value.from), to: coordinate(value.to) };
  }
  throw new Error('Invalid move');
}

export function buildHumanStyleBook(samples: readonly HumanStyleSample[]): HumanStyleBook {
  const book: HumanStyleBook = { version: 1, rulesVersion: RECORD_RULES_VERSION, games: 0, moves: 0, positions: {} };
  const ids = new Set<string>();
  for (const { record, eligibleSide } of samples) {
    if (ids.has(record.matchId)) throw new Error('Duplicate match');
    ids.add(record.matchId);
    if (record.status !== 'completed' || !['goal', 'capture', 'surround', 'no-moves'].includes(record.reason ?? '')
      || !record.moves.length) throw new Error('A completed natural result is required');
    if (!['BLACK', 'WHITE'].includes(eligibleSide) || record.players[eligibleSide]?.kind !== 'human') {
      throw new Error('Eligible side must be human');
    }
    const normalized = { ...record, moves: record.moves.map(canonicalMove) };
    replayRecord(normalized);
    let state = initialState(record.config);
    for (const move of normalized.moves) {
      if (state.turn === eligibleSide) {
        const key = humanStylePositionKey(state, record.config);
        const counts = book.positions[key] ??= {};
        const signature = moveKey(move);
        counts[signature] = (counts[signature] ?? 0) + 1;
        book.moves++;
      }
      state = applyMove(state, move);
    }
    book.games++;
  }
  return book;
}

/** The shared search applies this only to safe, near-best candidates; it never forces a recorded move. */
export function humanStylePreference(
  book: HumanStyleBook,
  state: GameState,
  config: RuleConfig,
  side: Player,
): ((root: GameState, move: Move) => number) | undefined {
  if (book.version !== 1 || book.rulesVersion !== RECORD_RULES_VERSION || state.turn !== side) return undefined;
  const counts = book.positions[humanStylePositionKey(state, config)];
  if (!counts) return undefined;
  const observations = Object.values(counts);
  if (!observations.length || observations.some((count) => !Number.isInteger(count) || count <= 0)) return undefined;
  const total = observations.reduce((sum, count) => sum + count, 0);
  const maximum = Math.max(...observations);
  const confidence = total / (total + 2);
  return (root, move) => root === state ? ((counts[moveKey(move)] ?? 0) / maximum) * confidence : 0;
}
