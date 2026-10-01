import type { StoredProfile } from './profileRepository';

export interface LeaderboardEntry {
  playerId: string;
  rank: number;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  winRate: number;
}

export function buildLeaderboard(
  profiles: Iterable<StoredProfile>,
  limit: number,
  offset: number,
  include?: (profile: StoredProfile) => boolean,
): LeaderboardEntry[] {
  const sorted = [...profiles].sort(
    (left, right) =>
      right.rating - left.rating ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.playerId.localeCompare(right.playerId),
  );
  let previousRating: number | null = null;
  let rank = 0;
  const ranked = sorted.map((profile, index) => {
    if (profile.rating !== previousRating) rank = index + 1;
    previousRating = profile.rating;
    const games = profile.wins + profile.losses;
    return {
      playerId: profile.playerId,
      rank,
      name: profile.name,
      rating: profile.rating,
      wins: profile.wins,
      losses: profile.losses,
      winRate: games === 0 ? 0 : Math.round((profile.wins / games) * 1000) / 10,
    };
  });
  const visible = include ? ranked.filter((_, index) => include(sorted[index]!)) : ranked;
  return visible.slice(offset, offset + limit);
}
