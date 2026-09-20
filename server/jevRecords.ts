import { mkdir, writeFile, rename, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { JevError } from './jev';

export interface JevRecord {
  turnId: string;
  gameId: string;
  ply: number;
  stateHash: string;
  [key: string]: unknown;
}

/** Persistence must not let a selected move outlive the turn's absolute deadline. */
export async function waitForJevRecord(write: Promise<void>, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  return new Promise<void>((resolve, reject) => {
    onAbort = () => reject(new JevError('aborted', 'JEV recording cancelled'));
    timer = setTimeout(() => reject(new JevError('timeout', 'JEV recording deadline reached')), Math.max(0, deadlineMs - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (Date.now() >= deadlineMs) reject(new JevError('timeout', 'JEV recording deadline reached'));
    write.then(resolve, reject);
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

/** Decision records are separate from the canonical MGN/game replay format. */
export async function createJevRecordStore(directory: string, connectionString?: string) {
  const pending = new Map<string, Promise<void>>();
  const pool = connectionString ? new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000 }) : null;
  if (pool) {
    pool.on('error', () => console.error('[jev] 판단 기록 DB 연결 오류'));
    await pool.query(`CREATE TABLE IF NOT EXISTS mongjin_jev_turns (
      turn_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, ply INTEGER NOT NULL,
      state_hash TEXT NOT NULL, record JSONB NOT NULL
    )`);
  }
  return {
    async save(record: JevRecord) {
      if (!/^[a-zA-Z0-9-]+$/.test(record.turnId)) throw new Error('Invalid JEV turn ID');
      // A timeout can enqueue an error record before the previous write has finished.
      // Snapshot and serialize each turn so a late 'selected' write cannot overwrite 'error'.
      const data = JSON.stringify(record);
      const write = (pending.get(record.turnId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (pool) {
          await pool.query(`INSERT INTO mongjin_jev_turns (turn_id, game_id, ply, state_hash, record)
            VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (turn_id) DO UPDATE SET record = EXCLUDED.record`,
          [record.turnId, record.gameId, record.ply, record.stateHash, data]);
        } else {
          await mkdir(directory, { recursive: true });
          const path = join(directory, `${record.turnId}.json`);
          await writeFile(`${path}.tmp`, data, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        }
      });
      pending.set(record.turnId, write);
      try { await write; }
      finally { if (pending.get(record.turnId) === write) pending.delete(record.turnId); }
    },
    async *records(gameId?: string): AsyncGenerator<JevRecord> {
      if (pool) {
        // Keyset pagination keeps exports bounded without exposing credentials through HTTP.
        let last = '';
        for (;;) {
          const rows = await pool.query('SELECT turn_id, record FROM mongjin_jev_turns WHERE turn_id > $1 AND ($2::text IS NULL OR game_id = $2) ORDER BY turn_id LIMIT 100', [last, gameId ?? null]);
          if (!rows.rows.length) return;
          for (const row of rows.rows) { last = row.turn_id; yield row.record as JevRecord; }
        }
      } else {
        let names: string[];
        try { names = await readdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for (const name of names.sort()) {
          if (!name.endsWith('.json')) continue;
          const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as JevRecord;
          if (!gameId || record.gameId === gameId) yield record;
        }
      }
    },
    async close() { await Promise.allSettled(pending.values()); await pool?.end(); },
  };
}
