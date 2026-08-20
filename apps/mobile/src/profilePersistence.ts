export interface RemoteProfileProgress {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  rating: number;
  rank: number;
  totalPlayers: number;
}

export interface StoredOnlineProgress {
  playerId: string;
  name: string;
  carriedWins: number;
  carriedLosses: number;
  carriedRatingDelta: number;
  currentWins: number;
  currentLosses: number;
  currentRating: number;
  rank: number;
  totalPlayers: number;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function validRating(value: number): number {
  return Number.isFinite(value) ? Math.max(100, Math.round(value)) : 1200;
}

export function mergeOnlineProgress(
  previous: StoredOnlineProgress | null,
  remote: RemoteProfileProgress,
): StoredOnlineProgress {
  const currentWins = nonNegativeInteger(remote.wins);
  const currentLosses = nonNegativeInteger(remote.losses);
  const currentRating = validRating(remote.rating);

  if (!previous) {
    return {
      playerId: remote.playerId,
      name: remote.name,
      carriedWins: 0,
      carriedLosses: 0,
      carriedRatingDelta: 0,
      currentWins,
      currentLosses,
      currentRating,
      rank: nonNegativeInteger(remote.rank),
      totalPlayers: nonNegativeInteger(remote.totalPlayers),
    };
  }

  if (previous.playerId === remote.playerId) {
    return {
      ...previous,
      name: remote.name,
      // A player's result counters only increase. Ignore an out-of-order or
      // partially restored server snapshot instead of resetting the device.
      currentWins: Math.max(previous.currentWins, currentWins),
      currentLosses: Math.max(previous.currentLosses, currentLosses),
      currentRating,
      rank: nonNegativeInteger(remote.rank),
      totalPlayers: nonNegativeInteger(remote.totalPlayers),
    };
  }

  // The server can issue a new identity after its backing store is restored or
  // reset. Close the prior segment into the carried totals before tracking the
  // new server identity so the device-visible record remains continuous.
  return {
    playerId: remote.playerId,
    name: remote.name,
    carriedWins: previous.carriedWins + previous.currentWins,
    carriedLosses: previous.carriedLosses + previous.currentLosses,
    carriedRatingDelta: previous.carriedRatingDelta + previous.currentRating - 1200,
    currentWins,
    currentLosses,
    currentRating,
    rank: nonNegativeInteger(remote.rank),
    totalPlayers: nonNegativeInteger(remote.totalPlayers),
  };
}

export function onlineProgressSnapshot(progress: StoredOnlineProgress): RemoteProfileProgress {
  const wins = progress.carriedWins + progress.currentWins;
  const losses = progress.carriedLosses + progress.currentLosses;
  return {
    playerId: progress.playerId,
    name: progress.name,
    wins,
    losses,
    rating: Math.max(100, 1200 + progress.carriedRatingDelta + progress.currentRating - 1200),
    rank: progress.rank,
    totalPlayers: progress.totalPlayers,
  };
}
