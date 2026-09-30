import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

export interface CommunityChange { namespace: string; key: string; value: unknown | null }
export interface CommunityStore {
  get<T>(namespace: string, key: string): Promise<T | null>;
  list<T>(namespace: string): Promise<T[]>;
  commit(changes: CommunityChange[]): Promise<void>;
  close(): Promise<void>;
}
const recordKey = (namespace: string, key: string) => JSON.stringify([namespace, key]);
export class FileCommunityStore implements CommunityStore {
  private data: Record<string, unknown> = {};
  private pending: Promise<void> = Promise.resolve();
  private initialized: Promise<void>;
  constructor(private readonly path: string | null) {
    this.initialized = this.load();
  }
  private async load() {
    if (!this.path) return;
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('Invalid community store');
      this.data = data.records;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async get<T>(namespace: string, key: string): Promise<T | null> {
    await this.initialized; await this.pending;
    return structuredClone(this.data[recordKey(namespace, key)] as T ?? null);
  }
  async list<T>(namespace: string): Promise<T[]> {
    await this.initialized; await this.pending;
    return Object.entries(this.data).filter(([key]) => JSON.parse(key)[0] === namespace).map(([, value]) => structuredClone(value as T));
  }
  commit(changes: CommunityChange[]): Promise<void> {
    const write = this.pending.then(async () => {
      await this.initialized;
      const next = structuredClone(this.data);
      for (const change of changes) {
        const key = recordKey(change.namespace, change.key);
        if (change.value === null) delete next[key];
        else next[key] = structuredClone(change.value);
      }
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(temp, JSON.stringify({ version: 1, records: next }), { mode: 0o600 });
        await rename(temp, this.path);
      }
      this.data = next;
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
  async close() { await this.pending; }
}
export class PostgresCommunityStore implements CommunityStore {
  private pool: Pool;
  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 3 }); }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mongjin_community_records (
      namespace TEXT NOT NULL, key TEXT NOT NULL, record JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(namespace,key)
    )`);
  }
  async get<T>(namespace: string, key: string): Promise<T | null> {
    const r = await this.pool.query('SELECT record FROM mongjin_community_records WHERE namespace=$1 AND key=$2', [namespace,key]);
    return r.rows[0]?.record ?? null;
  }
  async list<T>(namespace: string): Promise<T[]> {
    const r = await this.pool.query('SELECT record FROM mongjin_community_records WHERE namespace=$1 ORDER BY key', [namespace]);
    return r.rows.map(row => row.record);
  }
  async commit(changes: CommunityChange[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { namespace,key,value } of changes) {
        if (value === null) await client.query('DELETE FROM mongjin_community_records WHERE namespace=$1 AND key=$2',[namespace,key]);
        else await client.query(`INSERT INTO mongjin_community_records(namespace,key,record) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(namespace,key) DO UPDATE SET record=EXCLUDED.record,updated_at=NOW()`,[namespace,key,JSON.stringify(value)]);
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
export async function createCommunityStore(path: string, url: string | undefined = process.env.DATABASE_URL): Promise<CommunityStore> {
  if (!url) return new FileCommunityStore(path);
  const store = new PostgresCommunityStore(url);
  try { await store.initialize(); return store; }
  catch (error) { await store.close(); throw error; }
}
