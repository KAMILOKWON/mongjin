import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresTournamentStore, TOURNAMENT_SCORING_VERSION, type TournamentMatchRecord } from './tournamentStore';

const connection = process.env.MONGJIN_TEST_DATABASE_URL;
const loopback = (() => {
  if (!connection) return false;
  const url = new URL(connection);
  return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1';
})();
const tournamentId = 'pgtest-' + randomUUID().slice(0, 8);

afterAll(async () => {
  if (!loopback) return;
  const pool = new Pool({ connectionString: connection });
  for (const table of ['mongjin_tournament_matches', 'mongjin_tournament_registrations', 'mongjin_tournament_state', 'mongjin_tournament_events']) {
    await pool.query('DELETE FROM ' + table + ' WHERE tournament_id = $1', [tournamentId]);
  }
  await pool.end();
});

const event = (id: string) => ({ id, tournamentId, title: '대회', kind: 'match_complete' as const, occurredAt: 1, playerIds: ['a', 'b'], data: { n: 1 } });
const match = (status: TournamentMatchRecord['status']): TournamentMatchRecord => ({
  matchId: 'm1', blackId: 'a', whiteId: 'b', blackKind: 'human', whiteKind: 'human', blackName: 'A', whiteName: 'B',
  status, startedAt: '2026-10-10T12:00:00.000Z', scoring: TOURNAMENT_SCORING_VERSION, blackRatingBefore: 0, whiteRatingBefore: 0,
  blackPlatform: 'toss', whitePlatform: 'mobile',
  ...(status === 'playing' ? {} : { winner: 'BLACK', reason: 'resign', endedAt: '2026-10-10T12:05:00.000Z', moves: [], blackDelta: 16, whiteDelta: -16, blackRatingAfter: 16, whiteRatingAfter: -16 }),
});

describe.skipIf(!loopback)('postgres tournament store', () => {
  it('migrates idempotently and keeps results, lifecycle and events exactly once', async () => {
    const store = new PostgresTournamentStore(tournamentId, connection!);
    await store.initialize();
    await store.initialize();
    await store.saveSettings({ startingScore: 0 });
    await store.saveRegistration({ playerId: 'a', name: 'A', registeredAt: '2026-10-10T11:00:00.000Z' }, [{ ...event('e-reg'), kind: 'register' }]);
    await store.saveRegistration({ playerId: 'a', name: 'A2', registeredAt: '2026-10-10T11:00:00.000Z', firstEnteredAt: '2026-10-10T12:00:00.000Z' }, []);
    await store.startMatch(match('playing'), [event('e-start')]);
    await store.startMatch(match('playing'), [event('e-start-dup')]);
    expect(await store.finishMatch(match('completed'), [event('e-done')])).toBe(true);
    expect(await store.finishMatch({ ...match('completed'), winner: 'WHITE' }, [event('e-done-2')])).toBe(false);
    const decision = { status: 'confirmed' as const, decidedAt: '2026-10-10T11:30:00.000Z', registrationCount: 2 };
    expect(await store.setLifecycle('decision', decision, [{ ...event('e-dec'), kind: 'confirmed' }])).toBe(true);
    expect(await store.setLifecycle('decision', { ...decision, status: 'cancelled' }, [{ ...event('e-dec-2'), kind: 'cancelled' }])).toBe(false);
    await store.markEventsDelivered(['e-reg'], 5);

    const data = await store.load();
    expect(data.settings).toEqual({ startingScore: 0 });
    expect(data.lifecycle.decision).toEqual(decision);
    expect(data.registrations).toEqual([expect.objectContaining({ playerId: 'a', name: 'A2', firstEnteredAt: '2026-10-10T12:00:00.000Z', late: false })]);
    expect(data.matches).toEqual([expect.objectContaining({ status: 'completed', winner: 'BLACK', blackDelta: 16, whiteDelta: -16, blackRatingAfter: 16, whitePlatform: 'mobile' })]);
    expect(data.events.map((row) => [row.id, row.deliveredAt])).toEqual([['e-dec', null], ['e-done', null], ['e-reg', 5], ['e-start', null]]);
    await store.close();
  });
});
