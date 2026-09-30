import { describe, expect, it } from 'vitest';
import { DEFAULT_TOURNAMENT_ELO, eloDelta, rankEntrants, type RankingEntrant } from './tournamentElo';

describe('tournament Elo', () => {
  it('gives 16 at equal ratings and more for an upset than for a favourite win', () => {
    expect(eloDelta(0, 0, DEFAULT_TOURNAMENT_ELO)).toBe(16);
    const favourite = eloDelta(200, 0, DEFAULT_TOURNAMENT_ELO);
    const upset = eloDelta(0, 200, DEFAULT_TOURNAMENT_ELO);
    expect(favourite).toBe(8);
    expect(upset).toBe(24);
    expect(favourite + upset).toBe(32);
    expect(eloDelta(-100, 0, { k: 32, scale: 400 })).toBeGreaterThan(16);
  });
});

const entrant = (id: string, points: number, wins: number, games: number): RankingEntrant => ({ id, points, wins, games });

describe('tournament ranking', () => {
  it('leaves unqualified players unranked and shares ranks (1, 1, 3)', () => {
    const ranks = rankEntrants([entrant('a', 30, 3, 3), entrant('b', 30, 3, 3), entrant('c', 10, 2, 3), entrant('d', 99, 2, 2)], [], 3);
    expect([...ranks]).toEqual(expect.arrayContaining([['a', 1], ['b', 1], ['c', 3], ['d', null]]));
  });

  it('breaks equal points by win rate, then by head-to-head between the tied pair', () => {
    const byRate = rankEntrants([entrant('a', 20, 3, 5), entrant('b', 20, 3, 4)], [], 3);
    expect(byRate.get('b')).toBe(1);
    expect(byRate.get('a')).toBe(2);
    const byMeeting = rankEntrants([entrant('a', 20, 3, 4), entrant('b', 20, 3, 4)], [{ winnerId: 'b', loserId: 'a' }], 3);
    expect(byMeeting.get('b')).toBe(1);
    expect(byMeeting.get('a')).toBe(2);
    const split = rankEntrants([entrant('a', 20, 3, 4), entrant('b', 20, 3, 4)],
      [{ winnerId: 'b', loserId: 'a' }, { winnerId: 'a', loserId: 'b' }], 3);
    expect(split.get('a')).toBe(1);
    expect(split.get('b')).toBe(1);
  });

  it('does not force multiway ties that are incomplete or cyclic, and is independent of input order', () => {
    const three = [entrant('a', 20, 3, 4), entrant('b', 20, 3, 4), entrant('c', 20, 3, 4)];
    const incomplete = rankEntrants(three, [{ winnerId: 'a', loserId: 'b' }], 3);
    expect([...incomplete.values()]).toEqual([1, 1, 1]);
    const cycle = [{ winnerId: 'a', loserId: 'b' }, { winnerId: 'b', loserId: 'c' }, { winnerId: 'c', loserId: 'a' }];
    expect([...rankEntrants(three, cycle, 3).values()]).toEqual([1, 1, 1]);
    const complete = [{ winnerId: 'a', loserId: 'b' }, { winnerId: 'a', loserId: 'c' }, { winnerId: 'b', loserId: 'c' }];
    const forward = rankEntrants(three, complete, 3);
    const reversed = rankEntrants([...three].reverse(), [...complete].reverse(), 3);
    expect(Object.fromEntries(forward)).toEqual({ a: 1, b: 2, c: 3 });
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });
});
