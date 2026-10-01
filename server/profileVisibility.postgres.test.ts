import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { PostgresProfileRepository, type StoredProfile } from './profileRepository';

// An explicit disposable database is required; never use the production DATABASE_URL.
it.skipIf(!process.env.MONGJIN_TEST_DATABASE_URL)('Postgres 접속 표시 설정의 이전 스키마 이행과 재시작 유지', async () => {
  const admin = new Pool({ connectionString: process.env.MONGJIN_TEST_DATABASE_URL });
  const schema = `visibility_${randomUUID().replaceAll('-', '')}`;
  const scoped = new URL(process.env.MONGJIN_TEST_DATABASE_URL!);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  let repository: PostgresProfileRepository | undefined;
  const now = new Date().toISOString();
  const player: StoredProfile = { playerId: randomUUID(), token: randomUUID(), name: 'visibility-test',
    wins: 0, losses: 0, rating: 1200, createdAt: now, updatedAt: now };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".mongjin_profiles (
      player_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 1200, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL, toss_user_key BIGINT UNIQUE,
      toss_access_token TEXT, toss_refresh_token TEXT, toss_token_expires_at TIMESTAMPTZ,
      unlinked_at TIMESTAMPTZ, legacy_migrated_at TIMESTAMPTZ
    )`);
    await admin.query(`INSERT INTO "${schema}".mongjin_profiles
      (player_id, token, name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
    [player.playerId, player.token, player.name, now, now]);
    repository = new PostgresProfileRepository(scoped.toString());
    await repository.initialize();
    expect((await repository.loadProfiles())[0]?.showOnline).toBe(true);
    await repository.saveProfileMetadata({ ...player, showOnline: false }, { updateOnlineVisibility: true });
    const stale = await repository.saveProfileMetadata({ ...player, name: 'renamed', showOnline: true });
    expect(stale.showOnline).toBe(false);
    await repository.close();
    repository = new PostgresProfileRepository(scoped.toString());
    await repository.initialize();
    expect((await repository.loadProfiles())[0]?.showOnline).toBe(false);
    await repository.saveProfileMetadata({ ...player, showOnline: true }, { updateOnlineVisibility: true });
    expect((await repository.loadProfiles())[0]?.showOnline).toBe(true);
    expect((await repository.loadProfiles())[0]?.name).toBe('renamed');
    await expect(repository.saveProfileMetadata({ ...player, token: 'stale-test-token', showOnline: false }, { updateOnlineVisibility: true })).rejects.toThrow();
  } finally {
    await repository?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}, 30_000);
