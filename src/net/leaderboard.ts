import type { PlayerPresence } from './invitationProtocol';

export interface LeaderboardEntry {
  rank: number; name: string; rating: number; wins: number; losses: number; winRate: number;
  playerId?: string;
  presence?: PlayerPresence;
}
export interface LeaderboardPage { entries: LeaderboardEntry[]; totalPlayers: number; totalEntries?: number }

export function parseLeaderboard(value: unknown): LeaderboardPage {
  const page = value as Partial<LeaderboardPage> | null;
  if (!page || !Number.isInteger(page.totalPlayers) || page.totalPlayers! < 0 || !Array.isArray(page.entries)
    || (page.totalEntries !== undefined && (!Number.isInteger(page.totalEntries) || page.totalEntries < 0
      || page.totalEntries > page.totalPlayers! || page.entries.length > page.totalEntries))
    || page.entries.some((entry) => !entry || typeof entry.name !== 'string'
      || (entry.playerId !== undefined && (typeof entry.playerId !== 'string' || !entry.playerId))
      || (entry.presence !== undefined && !['offline', 'idle', 'matching', 'playing'].includes(entry.presence))
      || !Number.isInteger(entry.rank) || entry.rank < 1
      || ![entry.rating, entry.wins, entry.losses, entry.winRate].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))) {
    throw new Error('Invalid leaderboard response');
  }
  return page as LeaderboardPage;
}

export async function fetchLeaderboard(serverUrl: string, offset = 0, signal?: AbortSignal, onlineOnly = false): Promise<LeaderboardPage> {
  const url = new URL('/leaderboard', serverUrl.replace(/^ws/, 'http'));
  url.searchParams.set('limit', '50');
  url.searchParams.set('offset', String(Math.max(0, Math.floor(offset))));
  if (onlineOnly) url.searchParams.set('online', '1');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`Leaderboard HTTP ${response.status}`);
    return parseLeaderboard(await response.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export type RankingProfile = Pick<LeaderboardEntry, 'rank' | 'name' | 'rating' | 'playerId' | 'presence'> & Partial<Pick<LeaderboardEntry, 'wins' | 'losses' | 'winRate'>>;
export interface FocusedRankingRow { entry: RankingProfile; mine: boolean; faded: boolean }
export function rankingWindow(entries: LeaderboardEntry[], me: RankingProfile | null, top: boolean, onlineOnly = false): FocusedRankingRow[] {
  const isMine = (entry: RankingProfile) => !!me && (entry.playerId && me.playerId
    ? entry.playerId === me.playerId : entry.name === me.name && entry.rating === me.rating);
  if (onlineOnly) return entries.filter(entry => entry.presence !== undefined && entry.presence !== 'offline')
    .map(entry => ({ entry, mine: isMine(entry), faded: false }));
  if (top || !me) return entries.slice(0, 7).map((entry, index) => ({ entry, mine: isMine(entry), faded: index >= 5 }));
  const before = entries.filter((entry) => entry.rank < me.rank && !isMine(entry)).slice(-3);
  const after = entries.filter((entry) => entry.rank >= me.rank && !isMine(entry)).slice(0, 3);
  const mine = entries.find(isMine);
  return [
    ...before.map((entry, index) => ({ entry, mine: false, faded: before.length === 3 && index === 0 })),
    { entry: mine?.presence ? { ...me, presence: mine.presence } : me, mine: true, faded: false },
    ...after.map((entry, index) => ({ entry, mine: false, faded: index === 2 })),
  ];
}
