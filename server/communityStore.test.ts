import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCommunityStore } from './communityStore';

let dir: string;
let path: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mongjin-community-store-')); path = join(dir, 'nested', 'community.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('FileCommunityStore', () => {
  it('persists records across restart and leaves no temp files', async () => {
    const a = new FileCommunityStore(path);
    await a.commit([{ namespace: 'n', key: 'k1', value: { v: 1 } }, { namespace: 'n', key: 'k2', value: { v: 2 } }, { namespace: 'other', key: 'k1', value: 'x' }]);
    await a.close();
    const b = new FileCommunityStore(path);
    expect(await b.get('n', 'k1')).toEqual({ v: 1 });
    expect((await b.list<{ v: number }>('n')).map((x) => x.v).sort()).toEqual([1, 2]);
    expect(await b.list('other')).toEqual(['x']);
    expect(await b.get('n', 'missing')).toBeNull();
    await b.close();
    expect((await readdir(join(dir, 'nested'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('null deletes, and the same key in different namespaces does not collide', async () => {
    const s = new FileCommunityStore(path);
    await s.commit([{ namespace: 'a', key: 'k', value: 1 }, { namespace: 'b', key: 'k', value: 2 }]);
    await s.commit([{ namespace: 'a', key: 'k', value: null }]);
    await s.close();
    const r = new FileCommunityStore(path);
    expect(await r.get('a', 'k')).toBeNull();
    expect(await r.get('b', 'k')).toBe(2);
    await r.close();
  });

  it('returns copies so callers cannot mutate stored state', async () => {
    const s = new FileCommunityStore(path);
    const input = { list: [1] };
    await s.commit([{ namespace: 'n', key: 'k', value: input }]);
    input.list.push(2);
    const got = await s.get<{ list: number[] }>('n', 'k');
    got!.list.push(3);
    expect(await s.get('n', 'k')).toEqual({ list: [1] });
    await s.close();
  });

  it('serializes concurrent commits without losing any', async () => {
    const s = new FileCommunityStore(path);
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.commit([{ namespace: 'n', key: String(i), value: i }])));
    await s.close();
    const r = new FileCommunityStore(path);
    expect(await r.list('n')).toHaveLength(25);
    await r.close();
  });

  it('a failed commit leaves earlier data intact and the store usable', async () => {
    const s = new FileCommunityStore(path);
    await s.commit([{ namespace: 'n', key: 'ok', value: 1 }]);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await expect(s.commit([{ namespace: 'n', key: 'bad', value: circular }])).rejects.toBeTruthy();
    expect(await s.get('n', 'bad')).toBeNull();
    await s.commit([{ namespace: 'n', key: 'after', value: 2 }]);
    await s.close();
    const r = new FileCommunityStore(path);
    expect(await r.get('n', 'ok')).toBe(1);
    expect(await r.get('n', 'after')).toBe(2);
    await r.close();
  });

  it('rejects a corrupt or wrong-version file instead of silently discarding data', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, records: {} }));
    await expect(new FileCommunityStore(path).get('n', 'k')).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
  });

  it('in-memory mode (null path) works without touching disk', async () => {
    const s = new FileCommunityStore(null);
    await s.commit([{ namespace: 'n', key: 'k', value: 1 }]);
    expect(await s.get('n', 'k')).toBe(1);
    await s.close();
  });
});
