import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { RuleConfig } from '../src/core/config';
import type { Move, Player } from '../src/core/types';
import { initialState, legalMoves } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';

// Bump when shared rule semantics change; config alone cannot identify rule code.
export const RECORD_RULES_VERSION = 'mongjin-core-1';
export interface GameRecord {
  schemaVersion: 1;
  rulesVersion: string;
  matchId: string;
  kind: 'random' | 'friend' | 'bot';
  startedAt: string;
  endedAt?: string;
  status: 'playing' | 'completed' | 'abandoned';
  players: Record<Player, { kind: 'human' | 'bot'; rating: number | null }>;
  config: RuleConfig;
  moves: Move[];
  winner?: Player;
  reason?: string;
  revision: number;
}

export interface GameRecordStore {
  save(record: GameRecord): Promise<void>;
  records(): AsyncIterable<GameRecord>;
  close(): Promise<void>;
}

export class FileGameRecordStore implements GameRecordStore {
  constructor(private readonly directory: string) {}
  async save(record: GameRecord) {
    if (!/^[a-zA-Z0-9-]+$/.test(record.matchId)) throw new Error('Invalid match ID');
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${record.matchId}.json`);
    let old: GameRecord | undefined;
    try { old = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (old && old.revision >= record.revision) return;
    await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async *records() {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.sort()) {
      if (name.endsWith('.json')) yield JSON.parse(await readFile(join(this.directory, name), 'utf8')) as GameRecord;
    }
  }
  async close() {}
}

export class PostgresGameRecordStore implements GameRecordStore {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    this.pool.on('error', (error) => console.error('[records] Postgres 연결 오류:', error));
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mongjin_game_records (
      match_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      record JSONB NOT NULL
    )`);
  }
  async save(record: GameRecord) {
    await this.pool.query(`INSERT INTO mongjin_game_records (match_id, revision, record)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT (match_id) DO UPDATE
      SET revision = EXCLUDED.revision, record = EXCLUDED.record
      WHERE mongjin_game_records.revision < EXCLUDED.revision`,
    [record.matchId, record.revision, JSON.stringify(record)]);
  }
  async *records() {
    let after = '';
    while (true) {
      const result = await this.pool.query<{ match_id: string; record: GameRecord }>(
        'SELECT match_id, record FROM mongjin_game_records WHERE match_id > $1 ORDER BY match_id LIMIT 200', [after]);
      if (!result.rows.length) return;
      for (const row of result.rows) yield row.record;
      after = result.rows[result.rows.length - 1]!.match_id;
    }
  }
  async close() { await this.pool.end(); }
}

export async function createGameRecordStore(directory: string, connectionString = process.env.DATABASE_URL): Promise<GameRecordStore> {
  if (!connectionString) return new FileGameRecordStore(directory);
  const store = new PostgresGameRecordStore(connectionString);
  try { await store.initialize(); } catch (error) { await store.close(); throw error; }
  return store;
}

/** Serialize immutable snapshots per game. Later snapshots also recover earlier failed writes. */
export class GameRecorder {
  private pending = new Map<string, Promise<void>>();
  constructor(private readonly store: GameRecordStore,
    private readonly onError: (error: unknown) => void = console.error) {}
  save(record: GameRecord): Promise<void> {
    const snapshot = structuredClone(record);
    const previous = this.pending.get(record.matchId) ?? Promise.resolve();
    const task = previous.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { await this.store.save(snapshot); return; }
        catch (error) {
          if (attempt === 2) { this.onError(error); return; }
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    });
    this.pending.set(record.matchId, task);
    void task.then(() => { if (this.pending.get(record.matchId) === task) this.pending.delete(record.matchId); });
    return task;
  }
  async flush() { await Promise.all(this.pending.values()); }
}

export interface ExportOptions { minElo: number; both: boolean; includeBots: boolean; includeForfeits: boolean }

/** Rebuild from the canonical rules; never trust imported moves as legal by default. */
export function replayRecord(record: GameRecord) {
  if (record.schemaVersion !== 1 || record.rulesVersion !== RECORD_RULES_VERSION) throw new Error('Unsupported record/rules version');
  let state = initialState(record.config);
  for (const move of record.moves) {
    if (getResult(state, record.config) || !legalMoves(state, record.config).some((m) => JSON.stringify(m) === JSON.stringify(move))) {
      throw new Error(`Illegal move at ply ${state.history.length + 1}`);
    }
    state = applyMove(state, move);
  }
  if (record.status === 'completed') {
    if (!record.winner || !record.endedAt) throw new Error('Missing completed result');
    if (record.reason !== 'resign' && record.reason !== 'disconnect') {
      const result = getResult(state, record.config);
      if (!result || result.winner !== record.winner || result.reason !== record.reason) throw new Error('Result mismatch');
    }
  }
  return state;
}

export function trainingRecord(record: GameRecord, options: ExportOptions) {
  if (record.status !== 'completed' || !record.moves.length) return null;
  if (!options.includeBots && record.kind === 'bot') return null;
  if (record.reason === 'disconnect' || (!options.includeForfeits && record.reason === 'resign')) return null;
  const eligibleSides = (['BLACK', 'WHITE'] as const).filter((side) => {
    const player = record.players[side];
    return player.kind === 'human' && player.rating !== null && player.rating >= options.minElo;
  });
  if (eligibleSides.length < (options.both ? 2 : 1)) return null;
  replayRecord(record);
  // Explicit allowlist: no profile IDs, names, tokens, or raw room/session data.
  return {
    schemaVersion: record.schemaVersion, rulesVersion: record.rulesVersion, matchId: record.matchId,
    kind: record.kind, startedAt: record.startedAt, endedAt: record.endedAt,
    players: {
      BLACK: { kind: record.players.BLACK.kind, rating: record.players.BLACK.rating },
      WHITE: { kind: record.players.WHITE.kind, rating: record.players.WHITE.rating },
    },
    config: record.config, moves: record.moves, winner: record.winner, reason: record.reason,
    eligibleSides,
  };
}
