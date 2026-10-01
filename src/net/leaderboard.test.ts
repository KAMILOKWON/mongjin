import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLeaderboard, parseLeaderboard, rankingWindow } from './leaderboard';
const entry = { rank: 1, name: '선수', rating: 1200, wins: 1, losses: 0, winRate: 100 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('leaderboard API contract', () => {
  it('preserves competition ranks, including ties and skipped ranks', () => {
    const entries = [entry, { ...entry, name: '동점' }, { ...entry, rank: 3, rating: 1100 }];
    expect(parseLeaderboard({ totalPlayers: 3, entries }).entries.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(parseLeaderboard({ totalPlayers: 0, entries: [] })).toEqual({ totalPlayers: 0, entries: [] });
  });
  it('rejects malformed success responses instead of showing an empty ranking', () => {
    for (const value of [null, {}, { totalPlayers: -1, entries: [] }, { totalPlayers: 1, entries: [{ ...entry, rating: '1200' }] }]) {
      expect(() => parseLeaderboard(value)).toThrow();
    }
  });
  it('accepts profile presence while keeping old-server rows non-invitable', () => {
    const connected = { ...entry, playerId: 'player-1', presence: 'matching' };
    expect(parseLeaderboard({ totalPlayers: 1, entries: [connected] }).entries[0]).toEqual(connected);
    expect(parseLeaderboard({ totalPlayers: 1, entries: [entry] }).entries[0].playerId).toBeUndefined();
    for (const invalid of [{ ...entry, playerId: '' }, { ...entry, presence: 'hidden' }, { ...entry, playerId: 1 }]) {
      expect(() => parseLeaderboard({ totalPlayers: 1, entries: [invalid] })).toThrow();
    }
  });
  it('requests pagination on the configured server without leaking websocket query parameters', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ totalPlayers: 80, entries: [entry] }) });
    vi.stubGlobal('fetch', request);
    await fetchLeaderboard('wss://example.com/socket?token=private', 50);
    expect(request.mock.calls[0][0]).toBe('https://example.com/leaderboard?limit=50&offset=50');
  });
  it('requests online filtering with pagination and validates the filtered count', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ totalPlayers: 80, totalEntries: 2, entries: [entry] }) });
    vi.stubGlobal('fetch', request);
    expect((await fetchLeaderboard('ws://localhost:3001', 1, undefined, true)).totalEntries).toBe(2);
    expect(request.mock.calls[0][0]).toBe('http://localhost:3001/leaderboard?limit=50&offset=1&online=1');
    for (const totalEntries of [-1, 81, 1.5, '2', null]) {
      expect(() => parseLeaderboard({ totalPlayers: 80, totalEntries, entries: [entry] })).toThrow();
    }
  });
  it('rejects HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchLeaderboard('https://example.com')).rejects.toThrow('503');
  });
  it('aborts stalled requests after the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))));
    const result = expect(fetchLeaderboard('https://example.com')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  });
});

describe('focused ranking window', () => {
  it('shows every returned online player without fading and keeps global ranks', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ ...entry, playerId: `p${i}`, rank: i * 10 + 1, presence: 'idle' as const }));
    const rows = rankingWindow(entries, { ...entry, playerId: 'p8' }, false, true);
    expect(rows).toHaveLength(9);
    expect(rows.every(row => !row.faded)).toBe(true);
    expect(rows[8]?.mine).toBe(true);
    expect(rows[8]?.entry.rank).toBe(81);
    expect(rankingWindow([...entries, { ...entry, presence: 'offline' }, entry], null, false, true)).toHaveLength(9);
  });
  it('uses profile identity in both ranking views even when a nickname changed', () => {
    const mine = { ...entry, playerId: 'me', name: '새 이름', presence: 'idle' as const };
    const other = { ...entry, playerId: 'other', name: '이전 이름' };
    const me = { rank: 1, name: '이전 이름', rating: 1200, playerId: 'me' };
    const nearby = rankingWindow([mine, other], me, false);
    expect(nearby.filter(row => row.mine)).toHaveLength(1);
    expect(nearby.find(row => row.mine)?.entry.presence).toBe('idle');
    expect(nearby.find(row => !row.mine)?.entry.playerId).toBe('other');
    expect(rankingWindow([mine, other], me, true).map(row => row.mine)).toEqual([true, false]);
    expect(rankingWindow([mine, other], { ...me, rank: 5 }, false).filter(row => row.entry.playerId === 'me')).toHaveLength(1);
  });
  it('centers the official profile even when a tied group extends beyond the page', () => {
    const me = { rank: 4, name: '내 계정', rating: 1200 };
    const entries = [1, 2, 3, 4, 4, 4, 4].map((rank, i) => ({ ...entry, rank, rating: rank < 4 ? 1400 - rank : 1200, name: `선수${i}` }));
    const rows = rankingWindow(entries, me, false);
    expect(rows[3]).toEqual({ entry: me, mine: true, faded: false });
    expect(rows.filter((row) => !row.faded)).toHaveLength(5);
    expect(rows[0].faded).toBe(true);
    expect(rows[6].faded).toBe(true);
  });
  it('does not duplicate the current player and supports first/last ranks', () => {
    const me = { rank: 1, name: entry.name, rating: entry.rating };
    expect(rankingWindow([entry], me, false)).toEqual([{ entry: me, mine: true, faded: false }]);
    expect(rankingWindow([], null, true)).toEqual([]);
  });
  it('shows the top five clearly and fades only the following rows', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ ...entry, name: String(i), rank: i + 1 }));
    const rows = rankingWindow(entries, { ...entry, rank: 50 }, true);
    expect(rows.map((row) => row.entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.filter((row) => !row.faded)).toHaveLength(5);
  });
});
