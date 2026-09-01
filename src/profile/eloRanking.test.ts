import { describe, expect, it } from 'vitest';
import { calculateEloRank } from './eloRanking';

describe('calculateEloRank', () => {
  it('counts only players with a higher Elo', () => {
    expect(calculateEloRank(1200, [1450, 1250, 1200, 1180])).toBe(3);
  });

  it('gives the same rank to players with the same Elo', () => {
    const ratings = [1300, 1200, 1200, 1100];
    expect(calculateEloRank(1200, ratings)).toBe(2);
  });

  it('returns first place when nobody has a higher Elo', () => {
    expect(calculateEloRank(1400, [1400, 1400, 1200])).toBe(1);
  });
});
