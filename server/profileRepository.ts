import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool, type PoolClient } from 'pg';

export interface StoredProfile {
  playerId: string;
  token: string;
  name: string;
  wins: number;
  losses: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
  tossUserKey?: number;
  tossAccessToken?: string;
  tossRefreshToken?: string;
  tossTokenExpiresAt?: string;
  unlinkedAt?: string;
}

export interface RecordedMatch {
  matchId: string;
  roomId: string;
  winnerId: string;
  loserId: string;
  reason: string;
  completedAt: string;
}

export interface MatchResult {
  recorded: boolean;
  winner?: StoredProfile;
  loser?: StoredProfile;
}

export interface ProfileRepository {
  readonly kind: 'file' | 'postgres';
  loadProfiles(): Promise<StoredProfile[]>;
  importProfiles(profiles: StoredProfile[]): Promise<number>;
  saveProfile(profile: StoredProfile): Promise<void>;
  recordMatch(match: RecordedMatch): Promise<MatchResult>;
  close(): Promise<void>;
}

const ELO_K = 24;

function cloneProfile(profile: StoredProfile): StoredProfile {
  return { ...profile };
}

export function applyEloResult(
  winner: StoredProfile,
  loser: StoredProfile,
  completedAt: string,
): { winner: StoredProfile; loser: StoredProfile } {
  const winnerExpected = 1 / (1 + 10 ** ((loser.rating - winner.rating) / 400));
  const loserExpected = 1 / (1 + 10 ** ((winner.rating - loser.rating) / 400));
  return {
    winner: {
      ...winner,
      wins: winner.wins + 1,
      rating: Math.round(winner.rating + ELO_K * (1 - winnerExpected)),
      updatedAt: completedAt,
    },
    loser: {
      ...loser,
      losses: loser.losses + 1,
      rating: Math.max(100, Math.round(loser.rating + ELO_K * (0 - loserExpected))),
      updatedAt: completedAt,
    },
  };
}

function readProfileFile(filePath: string): StoredProfile[] {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoredProfile[];
  if (!Array.isArray(parsed)) throw new Error('프로필 저장 파일은 배열이어야 합니다');
  return parsed;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tempFile, filePath);
}

export class FileProfileRepository implements ProfileRepository {
  readonly kind = 'file' as const;
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly recordedMatchIds = new Set<string>();
  private readonly matchIdsFile: string;

  constructor(private readonly filePath: string) {
    this.matchIdsFile = `${filePath}.matches.json`;
    for (const profile of readProfileFile(filePath)) this.profiles.set(profile.playerId, cloneProfile(profile));
    if (existsSync(this.matchIdsFile)) {
      const ids = JSON.parse(readFileSync(this.matchIdsFile, 'utf8')) as string[];
      if (Array.isArray(ids)) for (const id of ids) this.recordedMatchIds.add(id);
    }
  }

  async loadProfiles(): Promise<StoredProfile[]> {
    return [...this.profiles.values()].map(cloneProfile);
  }

  async importProfiles(profiles: StoredProfile[]): Promise<number> {
    let imported = 0;
    for (const profile of profiles) {
      if (this.profiles.has(profile.playerId)) continue;
      this.profiles.set(profile.playerId, cloneProfile(profile));
      imported += 1;
    }
    if (imported > 0) this.persistProfiles();
    return imported;
  }

  async saveProfile(profile: StoredProfile): Promise<void> {
    this.profiles.set(profile.playerId, cloneProfile(profile));
    this.persistProfiles();
  }

  async recordMatch(match: RecordedMatch): Promise<MatchResult> {
    if (this.recordedMatchIds.has(match.matchId)) return { recorded: false };
    const winner = this.profiles.get(match.winnerId);
    const loser = this.profiles.get(match.loserId);
    if (!winner || !loser) throw new Error('경기 결과를 저장할 프로필이 없습니다');
    const result = applyEloResult(winner, loser, match.completedAt);
    this.profiles.set(result.winner.playerId, result.winner);
    this.profiles.set(result.loser.playerId, result.loser);
    this.recordedMatchIds.add(match.matchId);
    this.persistProfiles();
    atomicWriteJson(this.matchIdsFile, [...this.recordedMatchIds]);
    return { recorded: true, ...result };
  }

  async close(): Promise<void> {}

  private persistProfiles(): void {
    atomicWriteJson(this.filePath, [...this.profiles.values()]);
  }
}

interface ProfileRow {
  player_id: string;
  token: string;
  name: string;
  wins: number;
  losses: number;
  rating: number;
  created_at: Date | string;
  updated_at: Date | string;
  toss_user_key: string | number | null;
  toss_access_token: string | null;
  toss_refresh_token: string | null;
  toss_token_expires_at: Date | string | null;
  unlinked_at: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

function rowToProfile(row: ProfileRow): StoredProfile {
  return {
    playerId: row.player_id,
    token: row.token,
    name: row.name,
    wins: row.wins,
    losses: row.losses,
    rating: row.rating,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.toss_user_key === null ? {} : { tossUserKey: Number(row.toss_user_key) }),
    ...(row.toss_access_token === null ? {} : { tossAccessToken: row.toss_access_token }),
    ...(row.toss_refresh_token === null ? {} : { tossRefreshToken: row.toss_refresh_token }),
    ...(optionalIso(row.toss_token_expires_at) ? { tossTokenExpiresAt: optionalIso(row.toss_token_expires_at) } : {}),
    ...(optionalIso(row.unlinked_at) ? { unlinkedAt: optionalIso(row.unlinked_at) } : {}),
  };
}

const PROFILE_COLUMNS = `
  player_id, token, name, wins, losses, rating, created_at, updated_at,
  toss_user_key, toss_access_token, toss_refresh_token, toss_token_expires_at, unlinked_at
`;

export class PostgresProfileRepository implements ProfileRepository {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Math.max(1, Number(process.env.DATABASE_POOL_SIZE ?? 5)),
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mongjin_profiles (
        player_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
        rating INTEGER NOT NULL DEFAULT 1200 CHECK (rating >= 100),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        toss_user_key BIGINT UNIQUE,
        toss_access_token TEXT,
        toss_refresh_token TEXT,
        toss_token_expires_at TIMESTAMPTZ,
        unlinked_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS mongjin_profiles_rating_idx
        ON mongjin_profiles (rating DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS mongjin_matches (
        match_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        winner_id TEXT NOT NULL REFERENCES mongjin_profiles(player_id),
        loser_id TEXT NOT NULL REFERENCES mongjin_profiles(player_id),
        reason TEXT NOT NULL,
        winner_rating_before INTEGER NOT NULL,
        loser_rating_before INTEGER NOT NULL,
        winner_rating_after INTEGER NOT NULL,
        loser_rating_after INTEGER NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS mongjin_matches_completed_at_idx
        ON mongjin_matches (completed_at DESC);
    `);
  }

  async loadProfiles(): Promise<StoredProfile[]> {
    const result = await this.pool.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM mongjin_profiles`);
    return result.rows.map(rowToProfile);
  }

  async importProfiles(profiles: StoredProfile[]): Promise<number> {
    if (profiles.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let imported = 0;
      for (const profile of profiles) {
        const result = await this.upsertProfile(client, profile, true);
        imported += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return imported;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveProfile(profile: StoredProfile): Promise<void> {
    await this.upsertProfile(this.pool, profile, false);
  }

  async recordMatch(match: RecordedMatch): Promise<MatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS}
           FROM mongjin_profiles
          WHERE player_id = ANY($1::text[])
          ORDER BY player_id
          FOR UPDATE`,
        [[match.winnerId, match.loserId]],
      );
      const byId = new Map(locked.rows.map((row) => [row.player_id, rowToProfile(row)]));
      const winner = byId.get(match.winnerId);
      const loser = byId.get(match.loserId);
      if (!winner || !loser) throw new Error('경기 결과를 저장할 프로필이 없습니다');

      const claim = await client.query(
        `INSERT INTO mongjin_matches (
           match_id, room_id, winner_id, loser_id, reason,
           winner_rating_before, loser_rating_before,
           winner_rating_after, loser_rating_after, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7, $8)
         ON CONFLICT (match_id) DO NOTHING
         RETURNING match_id`,
        [
          match.matchId,
          match.roomId,
          match.winnerId,
          match.loserId,
          match.reason,
          winner.rating,
          loser.rating,
          match.completedAt,
        ],
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return { recorded: false };
      }

      const result = applyEloResult(winner, loser, match.completedAt);
      await this.upsertProfile(client, result.winner, false);
      await this.upsertProfile(client, result.loser, false);
      await client.query(
        `UPDATE mongjin_matches
            SET winner_rating_after = $2, loser_rating_after = $3
          WHERE match_id = $1`,
        [match.matchId, result.winner.rating, result.loser.rating],
      );
      await client.query('COMMIT');
      return { recorded: true, ...result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private upsertProfile(
    executor: Pick<Pool | PoolClient, 'query'>,
    profile: StoredProfile,
    insertOnly: boolean,
  ): Promise<{ rowCount: number | null }> {
    const conflict = insertOnly
      ? 'ON CONFLICT (player_id) DO NOTHING'
      : `ON CONFLICT (player_id) DO UPDATE SET
           token = EXCLUDED.token,
           name = EXCLUDED.name,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           rating = EXCLUDED.rating,
           updated_at = EXCLUDED.updated_at,
           toss_user_key = EXCLUDED.toss_user_key,
           toss_access_token = EXCLUDED.toss_access_token,
           toss_refresh_token = EXCLUDED.toss_refresh_token,
           toss_token_expires_at = EXCLUDED.toss_token_expires_at,
           unlinked_at = EXCLUDED.unlinked_at`;
    return executor.query(
      `INSERT INTO mongjin_profiles (${PROFILE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ${conflict}`,
      [
        profile.playerId,
        profile.token,
        profile.name,
        profile.wins,
        profile.losses,
        profile.rating,
        profile.createdAt,
        profile.updatedAt,
        profile.tossUserKey ?? null,
        profile.tossAccessToken ?? null,
        profile.tossRefreshToken ?? null,
        profile.tossTokenExpiresAt ?? null,
        profile.unlinkedAt ?? null,
      ],
    );
  }
}

export async function createProfileRepository(
  filePath: string,
  connectionString = process.env.DATABASE_URL,
): Promise<ProfileRepository> {
  if (!connectionString) return new FileProfileRepository(filePath);
  const repository = new PostgresProfileRepository(connectionString);
  await repository.initialize();
  return repository;
}

export function loadProfilesForMigration(filePath: string): StoredProfile[] {
  return readProfileFile(filePath);
}
