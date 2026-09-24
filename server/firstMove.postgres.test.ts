import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { PostgresGameRecordStore, RECORD_RULES_VERSION } from './gameRecords';
import { backfillFirstMoves } from './firstMove';
import { PostgresProfileRepository, type StoredProfile } from './profileRepository';

// Only an explicitly configured disposable test database is used here.
it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('Postgres 이전 행 스키마·단조 병합·기보 복원', async () => {
  const admin = new Pool({ connectionString: process.env.MONGJIN_TEST_DATABASE_URL! });
  const schema = `first_move_${randomUUID().replaceAll('-', '')}`;
  const scopedUrl = new URL(process.env.MONGJIN_TEST_DATABASE_URL!);
  scopedUrl.searchParams.set('options', `-csearch_path=${schema}`);
  const connection = scopedUrl.toString();
  let repo: PostgresProfileRepository | undefined;
  let games: PostgresGameRecordStore | undefined;
  const id = randomUUID();
  const player: StoredProfile = { playerId: id, token: randomUUID(), name: `test-${id}`,
    wins: 0, losses: 0, rating: 1200, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    // Exact preflag profile shape: this row exists before the new repository initializes.
    await admin.query(`CREATE TABLE "${schema}".mongjin_profiles (
      player_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 1200, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL, toss_user_key BIGINT UNIQUE,
      toss_access_token TEXT, toss_refresh_token TEXT, toss_token_expires_at TIMESTAMPTZ,
      unlinked_at TIMESTAMPTZ, legacy_migrated_at TIMESTAMPTZ, bot_learning JSONB
    )`);
    await admin.query(`INSERT INTO "${schema}".mongjin_profiles
      (player_id, token, name, wins, losses, rating, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [player.playerId, player.token, player.name, player.wins, player.losses, player.rating,
      player.createdAt, player.updatedAt]);
    const column = () => admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'mongjin_profiles' AND column_name = 'has_played_move'`, [schema]);
    expect((await column()).rows).toHaveLength(0);

    repo = new PostgresProfileRepository(connection);
    games = new PostgresGameRecordStore(connection);
    await repo.initialize(); await games.initialize();
    expect((await column()).rows).toHaveLength(1);
    expect((await repo.loadProfiles()).find((item) => item.playerId === id)?.hasPlayedMove).toBe(false);
    await repo.recordMatchEvent({ matchId: id, roomId: id, playerId: id,
      matchKind: 'bot', opponentKind: 'bot', event: 'completed', platform: 'web',
      plyCount: 2, outcome: 'loss', reason: 'resign', occurredAt: new Date().toISOString() });
    await games.save({ schemaVersion: 1, rulesVersion: RECORD_RULES_VERSION, matchId: id,
      kind: 'bot', startedAt: new Date().toISOString(), status: 'completed', revision: 2,
      players: { BLACK: { kind: 'bot', rating: 1200 }, WHITE: { kind: 'human', rating: 1200 } },
      config: DEFAULT_CONFIG, moves: [
        { kind: 'PLACE', to: { r: 1, c: 1 } }, { kind: 'PLACE', to: { r: 2, c: 2 } },
      ] });
    expect(await backfillFirstMoves(repo, games)).toBe(1);
    const stale = await repo.saveProfileMetadata(player);
    expect(stale.hasPlayedMove).toBe(true);
    await repo.saveProfile(player);
    expect((await repo.loadProfiles()).find((item) => item.playerId === id)?.hasPlayedMove).toBe(true);
    const reopened = new PostgresProfileRepository(connection);
    try {
      await reopened.initialize();
      expect((await reopened.loadProfiles()).find((item) => item.playerId === id)?.hasPlayedMove).toBe(true);
    } finally { await reopened.close(); }
  } finally {
    await games?.close(); await repo?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}, 30000);
