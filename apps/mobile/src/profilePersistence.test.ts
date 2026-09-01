import { describe, expect, it } from 'vitest';
import { mergeOnlineProgress, onlineProgressSnapshot } from './profilePersistence';

const remote = (overrides: Partial<Parameters<typeof mergeOnlineProgress>[1]> = {}) => ({
  playerId: 'player-a',
  name: '몽진왕',
  wins: 4,
  losses: 2,
  rating: 1230,
  rank: 3,
  totalPlayers: 10,
  ...overrides,
});

describe('online profile persistence', () => {
  it('stores the first server profile without changing its record', () => {
    const progress = mergeOnlineProgress(null, remote({ legacyMigrationComplete: true }));
    expect(onlineProgressSnapshot(progress)).toMatchObject({
      wins: 4,
      losses: 2,
      rating: 1230,
      legacyMigrationComplete: true,
    });
  });

  it('does not move win/loss counters backwards for the same identity', () => {
    const first = mergeOnlineProgress(null, remote());
    const stale = mergeOnlineProgress(first, remote({ wins: 0, losses: 0, rating: 1210 }));
    expect(onlineProgressSnapshot(stale)).toMatchObject({ wins: 4, losses: 2, rating: 1210 });
  });

  it('carries the old record forward when the server issues a new identity', () => {
    const first = mergeOnlineProgress(null, remote());
    const replacement = mergeOnlineProgress(first, remote({ playerId: 'player-b', wins: 1, losses: 0, rating: 1212 }));
    expect(onlineProgressSnapshot(replacement)).toMatchObject({
      playerId: 'player-b',
      wins: 5,
      losses: 2,
      rating: 1242,
    });
  });

  it('keeps accumulating across multiple server identity replacements', () => {
    const first = mergeOnlineProgress(null, remote());
    const second = mergeOnlineProgress(first, remote({ playerId: 'player-b', wins: 1, losses: 1, rating: 1200 }));
    const third = mergeOnlineProgress(second, remote({ playerId: 'player-c', wins: 2, losses: 0, rating: 1224 }));
    expect(onlineProgressSnapshot(third)).toMatchObject({ wins: 7, losses: 3, rating: 1254 });
  });

  it('folds carried segments into the official server snapshot after migration', () => {
    const first = mergeOnlineProgress(null, remote());
    const replacement = mergeOnlineProgress(first, remote({ playerId: 'player-b', wins: 1, losses: 0, rating: 1212 }));
    const official = mergeOnlineProgress(replacement, remote({
      playerId: 'player-b',
      wins: 5,
      losses: 2,
      rating: 1242,
      legacyMigrationComplete: true,
    }));
    expect(onlineProgressSnapshot(official)).toMatchObject({
      wins: 5,
      losses: 2,
      rating: 1242,
      legacyMigrationComplete: true,
    });
  });
});
