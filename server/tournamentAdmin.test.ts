import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTournamentAdmin, planTournamentAdmin } from './tournamentAdmin';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mongjin-admin-cli-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function file(name: string, value: unknown) { const path = join(dir, name); await writeFile(path, JSON.stringify(value)); return path; }
describe('operator CLI', () => {
  it('defaults every command to a local JSON preview and never touches network', async () => {
    const fetcher = vi.fn(), output = vi.fn();
    const publish = await file('schedule.json', { id: 'cup', startsAt: Date.now() + 60000, endsAt: Date.now() + 120000 });
    const notice = await file('notice.json', { id: 'reviewed-notice', title: '확정 공지', body: '승인된 안내' });
    const reward = await file('reward.json', { id: '["cup","p1","champion"]', status: 'fulfilled' });
    for (const args of [['publish', '--file', publish], ['notice', '--file', notice], ['reward-status', '--file', reward], ['status'], ['analytics', '--days', '28'], ['notifications'], ['rewards'], ['training-export']]) await runTournamentAdmin(args, { fetcher, output, env: {} });
    expect(fetcher).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledTimes(8);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ mode: 'preview', method: 'POST', path: '/admin/tournaments', body: { startingScore: 0, eloK: 32 } });
  });
  it('requires explicit execute, endpoint and min-24-character admin token; preview contains no bearer secret', async () => {
    const output = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => new Response('{"tournaments":[]}', { status: 200 }));
    await expect(runTournamentAdmin(['status', '--execute'], { output, fetcher, env: {} })).rejects.toThrow('BASE_URL_REQUIRED');
    await expect(runTournamentAdmin(['status', '--execute', '--base-url', 'http://127.0.0.1:8080'], { output, fetcher, env: { MONGJIN_ADMIN_TOKEN: 'short' } })).rejects.toThrow('ADMIN_TOKEN_REQUIRED');
    const secret = 'private-admin-secret'.repeat(2);
    await runTournamentAdmin(['status', '--execute', '--base-url', 'http://127.0.0.1:8080'], { output, fetcher, env: { MONGJIN_ADMIN_TOKEN: secret } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${secret}` } });
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  });
  it('rejects ambiguous/wrong endpoints, unknown options, bad windows and unsupported mutation commands', async () => {
    for (const args of [['status', '--base-url', 'http://example.invalid'], ['status', '--base-url', 'https://token@example.invalid'], ['status', '--base-url', 'https://example.invalid/path'], ['analytics', '--days', '7'], ['status', '--days', '14'], ['update'], ['status', '--token', 'secret']]) await expect(planTournamentAdmin(args)).rejects.toThrow();
  });
  it('rejects invalid publish input before either preview or network', async () => {
    const path = await file('invalid.json', { id: 'cup', startsAt: Date.now() - 1, endsAt: Date.now() + 10000 });
    const output = vi.fn(), fetcher = vi.fn();
    await expect(runTournamentAdmin(['publish', '--file', path, '--execute'], { output, fetcher })).rejects.toThrow('INVALID_SETTINGS');
    expect(output).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
