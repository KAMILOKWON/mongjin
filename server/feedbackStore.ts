import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Pool, type QueryResultRow } from 'pg';
import type { FeedbackSubmission } from './feedback';

export interface FeedbackRecord {
  schemaVersion: 1;
  requestId: string;
  payloadHash: string;
  submission: FeedbackSubmission;
  receiptId: string;
  status: 'pending' | 'completed';
  createdAt: string;
  completedAt?: string;
  from: string;
  to: string;
}

export type SaveFeedbackRecord = (record: FeedbackRecord) => Promise<void>;

export interface FeedbackStore {
  get(requestId: string): Promise<FeedbackRecord | null>;
  createIfAbsent(record: FeedbackRecord): Promise<FeedbackRecord>;
  withRecordLock<T>(
    requestId: string,
    operation: (record: FeedbackRecord, save: SaveFeedbackRecord) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isFeedbackRecord(value: unknown, requestId: string): value is FeedbackRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<FeedbackRecord>;
  return record.schemaVersion === 1 &&
    record.requestId === requestId &&
    typeof record.payloadHash === 'string' && /^[0-9a-f]{64}$/u.test(record.payloadHash) &&
    !!record.submission && typeof record.submission === 'object' &&
    typeof record.receiptId === 'string' && UUID_PATTERN.test(record.receiptId) &&
    (record.status === 'pending' || record.status === 'completed') &&
    typeof record.createdAt === 'string' &&
    typeof record.from === 'string' &&
    typeof record.to === 'string';
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDataDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!created) return;

  const parentOfFirstCreated = resolve(dirname(resolve(created)));
  let current = resolve(directory);
  while (true) {
    await syncDirectory(current);
    if (current === parentOfFirstCreated) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function readFileRecord(directory: string, requestId: string): Promise<FeedbackRecord | null> {
  let contents: string;
  try {
    contents = await readFile(join(directory, `${requestId}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Feedback record is corrupt');
  }
  if (!isFeedbackRecord(value, requestId)) throw new Error('Feedback record is invalid');
  return value;
}

function validateWrite(requestId: string, record: FeedbackRecord): void {
  if (record.requestId !== requestId || !isFeedbackRecord(record, requestId)) {
    throw new Error('Feedback record key mismatch');
  }
}

async function writeFileRecord(directory: string, record: FeedbackRecord): Promise<void> {
  await ensureDataDirectory(directory);
  const path = join(directory, `${record.requestId}.json`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class FileFeedbackStore implements FeedbackStore {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  get(requestId: string): Promise<FeedbackRecord | null> {
    return readFileRecord(this.directory, requestId);
  }

  async createIfAbsent(record: FeedbackRecord): Promise<FeedbackRecord> {
    validateWrite(record.requestId, record);
    await ensureDataDirectory(this.directory);
    const path = join(this.directory, `${record.requestId}.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, path);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
    if (created) await syncDirectory(this.directory);
    const existing = await readFileRecord(this.directory, record.requestId);
    if (!existing) throw new Error('Feedback record was not persisted');
    return existing;
  }

  async withRecordLock<T>(
    requestId: string,
    operation: (record: FeedbackRecord, save: SaveFeedbackRecord) => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(requestId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const record = await readFileRecord(this.directory, requestId);
      if (!record) throw new Error('Feedback record does not exist');
      const save = async (next: FeedbackRecord) => {
        validateWrite(requestId, next);
        if (next.payloadHash !== record.payloadHash) throw new Error('Feedback payload hash is immutable');
        await writeFileRecord(this.directory, next);
        Object.assign(record, next);
      };
      return operation(record, save);
    });
    this.locks.set(requestId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(requestId) === current) this.locks.delete(requestId);
    }
  }

  async close(): Promise<void> {}
}

interface FeedbackRow extends QueryResultRow {
  request_id: string;
  payload_hash: string;
  record: FeedbackRecord;
}

export class PostgresFeedbackStore implements FeedbackStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mongjin_feedback_reports (
        request_id UUID PRIMARY KEY,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        record JSONB NOT NULL
      )
    `);
  }

  async get(requestId: string): Promise<FeedbackRecord | null> {
    const result = await this.pool.query<FeedbackRow>(
      'SELECT request_id, payload_hash, record FROM mongjin_feedback_reports WHERE request_id = $1',
      [requestId],
    );
    return result.rows[0] ? this.recordFromRow(result.rows[0], requestId) : null;
  }

  async createIfAbsent(record: FeedbackRecord): Promise<FeedbackRecord> {
    validateWrite(record.requestId, record);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      const inserted = await client.query<FeedbackRow>(
        `INSERT INTO mongjin_feedback_reports (request_id, payload_hash, record)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING request_id, payload_hash, record`,
        [record.requestId, record.payloadHash, JSON.stringify(record)],
      );
      let stored = inserted.rows[0];
      if (!stored) {
        const selected = await client.query<FeedbackRow>(
          'SELECT request_id, payload_hash, record FROM mongjin_feedback_reports WHERE request_id = $1',
          [record.requestId],
        );
        stored = selected.rows[0];
      }
      if (!stored) throw new Error('Feedback record was not persisted');
      const result = this.recordFromRow(stored, record.requestId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async withRecordLock<T>(
    requestId: string,
    operation: (record: FeedbackRecord, save: SaveFeedbackRecord) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      const result = await client.query<FeedbackRow>(
        `SELECT request_id, payload_hash, record
         FROM mongjin_feedback_reports WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Feedback record does not exist');
      const record = this.recordFromRow(row, requestId);
      const save = async (next: FeedbackRecord) => {
        validateWrite(requestId, next);
        if (next.payloadHash !== record.payloadHash) throw new Error('Feedback payload hash is immutable');
        const update = await client.query(
          `UPDATE mongjin_feedback_reports SET record = $3::jsonb
           WHERE request_id = $1 AND payload_hash = $2`,
          [requestId, record.payloadHash, JSON.stringify(next)],
        );
        if (update.rowCount !== 1) throw new Error('Feedback record update was not persisted');
        Object.assign(record, next);
      };
      const value = await operation(record, save);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private recordFromRow(row: FeedbackRow, requestId: string): FeedbackRecord {
    if (!isFeedbackRecord(row.record, requestId) || row.payload_hash.trim() !== row.record.payloadHash) {
      throw new Error('Feedback record is invalid');
    }
    return row.record;
  }
}

export async function createFeedbackStore(
  fileDirectory = process.env.MONGJIN_FEEDBACK_DATA_DIR?.trim() || join(process.cwd(), 'data', 'feedback'),
  connectionString = process.env.DATABASE_URL,
): Promise<FeedbackStore> {
  if (!connectionString) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required for production feedback persistence');
    }
    return new FileFeedbackStore(fileDirectory);
  }
  const store = new PostgresFeedbackStore(connectionString);
  try {
    await store.initialize();
  } catch (error) {
    await store.close();
    throw error;
  }
  return store;
}
