import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { learnBotOpening, type BotLearning, type BotLearningGame } from './rankedBotLearning';
import { RANKED_BOTS, isRankedBotId } from './rankedBots';

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
  legacyMigratedAt?: string;
  botLearning?: BotLearning;
}

export interface LegacyProfileClaim {
  name: string;
  wins: number;
  losses: number;
  rating: number;
  migratedAt: string;
}

export interface LegacyProfileMigrationResult {
  migrated: boolean;
  profile: StoredProfile;
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

export interface RecordedBotMatch {
  botPlayerId?: string;
  learningGame?: BotLearningGame;
  matchId: string;
  roomId: string;
  playerId: string;
  playerWon: boolean;
  botName: string;
  botRating: number;
  botSearchRating: number;
  difficultyBand: string;
  reason: string;
  completedAt: string;
}

export interface BotMatchResult {
  recorded: boolean;
  bot?: StoredProfile;
  player?: StoredProfile;
}

export interface BotMatchProgress {
  completed: number;
  recentWins: number;
  recentLosses: number;
}

export type MatchPlatform = 'toss' | 'web' | 'mobile' | 'steam' | 'unknown';
export type MatchLifecycleEvent = 'started' | 'completed' | 'abandoned';

export interface RecordedMatchEvent {
  matchId: string;
  roomId: string;
  playerId: string;
  matchKind: 'random' | 'bot';
  opponentKind: 'human' | 'bot';
  event: MatchLifecycleEvent;
  platform: MatchPlatform;
  plyCount: number;
  outcome?: 'win' | 'loss';
  reason?: string;
  occurredAt: string;
}

export interface ProfileRepository {
  readonly kind: 'file' | 'postgres';
  loadProfiles(): Promise<StoredProfile[]>;
  importProfiles(profiles: StoredProfile[]): Promise<number>;
  saveProfile(profile: StoredProfile): Promise<void>;
  saveProfileMetadata(profile: StoredProfile): Promise<StoredProfile>;
  migrateLegacyProfile(playerId: string, claim: LegacyProfileClaim): Promise<LegacyProfileMigrationResult>;
  recordMatch(match: RecordedMatch): Promise<MatchResult>;
  recordBotMatch(match: RecordedBotMatch): Promise<BotMatchResult>;
  getBotMatchProgress(playerId: string, recentLimit?: number): Promise<BotMatchProgress>;
  getRecentBotOpponents(playerId: string, limit?: number): Promise<string[]>;
  recordMatchEvent(event: RecordedMatchEvent): Promise<void>;
  close(): Promise<void>;
}

const ELO_K = 24;

function cloneProfile(profile: StoredProfile): StoredProfile {
  return structuredClone(profile);
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

export function applyBotEloResult(
  player: StoredProfile,
  botRating: number,
  playerWon: boolean,
  completedAt: string,
): StoredProfile {
  const expected = 1 / (1 + 10 ** ((botRating - player.rating) / 400));
  return {
    ...player,
    wins: player.wins + (playerWon ? 1 : 0),
    losses: player.losses + (playerWon ? 0 : 1),
    rating: Math.max(100, Math.round(player.rating + ELO_K * ((playerWon ? 1 : 0) - expected))),
    updatedAt: completedAt,
  };
}

function rankedBotResult(current: StoredProfile, bot: StoredProfile | undefined, match: RecordedBotMatch) {
  if (match.botPlayerId && (!bot || !isRankedBotId(bot.playerId) || bot.playerId === current.playerId)) {
    throw new Error('고정 봇 프로필이 없습니다');
  }
  const player = applyBotEloResult(current, match.botRating, match.playerWon, match.completedAt);
  if (!bot) return { player };
  // Use the match-start opponent rating even if this bot finishes another game concurrently.
  const delta = player.rating - current.rating;
  return { player, bot: {
    ...bot, wins: bot.wins + Number(!match.playerWon), losses: bot.losses + Number(match.playerWon),
    rating: Math.max(100, bot.rating - delta), updatedAt: match.completedAt,
    botLearning: learnBotOpening(bot.botLearning, match.learningGame),
  } };
}

function rankedBotIdForMatch(match: Pick<RecordedBotMatch, 'botPlayerId' | 'botName'>): string | undefined {
  if (match.botPlayerId && isRankedBotId(match.botPlayerId)) return match.botPlayerId;
  return RANKED_BOTS.find((bot) => bot.name === match.botName)?.id;
}

function recentLimit(value: number, fallback = 5): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function compareRecentBotMatches(left: RecordedBotMatch, right: RecordedBotMatch): number {
  return right.completedAt.localeCompare(left.completedAt) || right.matchId.localeCompare(left.matchId);
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

interface FileSnapshot {
  profiles: StoredProfile[];
  matchIds: string[];
  botMatches: RecordedBotMatch[];
  matchEvents: RecordedMatchEvent[];
}

function readSnapshot(filePath: string): FileSnapshot {
  const snapshotPath = `${filePath}.snapshot.json`;
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as FileSnapshot;
  const modified = statSync(snapshotPath).mtimeMs;
  const mirrors: Array<[string, unknown]> = [[filePath, snapshot.profiles],
    [`${filePath}.matches.json`, snapshot.matchIds], [`${filePath}.bot-matches.json`, snapshot.botMatches],
    [`${filePath}.match-events.json`, snapshot.matchEvents]];
  for (const [path, expected] of mirrors) {
    if (existsSync(path) && statSync(path).mtimeMs > modified &&
        JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(expected)) {
      throw new Error('snapshot 이후 변경된 레거시 파일이 있습니다. 롤백 데이터를 명시적으로 병합해야 합니다');
    }
  }
  return snapshot;
}

export class FileProfileRepository implements ProfileRepository {
  readonly kind = 'file' as const;
  private committed!: FileSnapshot;
  private readonly profiles = new Map<string, StoredProfile>();
  private readonly recordedMatchIds = new Set<string>();
  private readonly botMatches: RecordedBotMatch[] = [];
  private readonly matchEvents: RecordedMatchEvent[] = [];
  private readonly recordedEventKeys = new Set<string>();
  private readonly matchIdsFile: string;
  private readonly botMatchesFile: string;
  private readonly matchEventsFile: string;

  constructor(private readonly filePath: string) {
    this.matchIdsFile = `${filePath}.matches.json`;
    this.botMatchesFile = `${filePath}.bot-matches.json`;
    this.matchEventsFile = `${filePath}.match-events.json`;
    if (existsSync(`${filePath}.snapshot.json`)) {
      const snapshot = readSnapshot(filePath);
      for (const profile of snapshot.profiles) this.profiles.set(profile.playerId, profile);
      for (const id of snapshot.matchIds) this.recordedMatchIds.add(id);
      this.botMatches.push(...snapshot.botMatches);
      this.matchEvents.push(...snapshot.matchEvents);
      for (const event of this.matchEvents) this.recordedEventKeys.add(this.eventKey(event));
      this.committed = this.snapshot();
      return;
    }
    for (const profile of readProfileFile(filePath)) this.profiles.set(profile.playerId, cloneProfile(profile));
    if (existsSync(this.matchIdsFile)) {
      const ids = JSON.parse(readFileSync(this.matchIdsFile, 'utf8')) as string[];
      if (Array.isArray(ids)) for (const id of ids) this.recordedMatchIds.add(id);
    }
    if (existsSync(this.botMatchesFile)) {
      const matches = JSON.parse(readFileSync(this.botMatchesFile, 'utf8')) as RecordedBotMatch[];
      if (Array.isArray(matches)) this.botMatches.push(...matches);
    }
    if (existsSync(this.matchEventsFile)) {
      const events = JSON.parse(readFileSync(this.matchEventsFile, 'utf8')) as RecordedMatchEvent[];
      if (Array.isArray(events)) {
        this.matchEvents.push(...events);
        for (const event of events) this.recordedEventKeys.add(this.eventKey(event));
      }
    }
    this.committed = this.snapshot();
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

  async saveProfileMetadata(profile: StoredProfile): Promise<StoredProfile> {
    const current = this.profiles.get(profile.playerId);
    const saved = current ? { ...profile, wins: current.wins, losses: current.losses, rating: current.rating,
      botLearning: current.botLearning, legacyMigratedAt: current.legacyMigratedAt } : profile;
    await this.saveProfile(saved);
    return cloneProfile(saved);
  }

  async migrateLegacyProfile(
    playerId: string,
    claim: LegacyProfileClaim,
  ): Promise<LegacyProfileMigrationResult> {
    const current = this.profiles.get(playerId);
    if (!current) throw new Error('승계할 프로필이 없습니다');
    if (current.legacyMigratedAt) return { migrated: false, profile: cloneProfile(current) };
    const profile: StoredProfile = {
      ...current,
      name: claim.name,
      wins: claim.wins,
      losses: claim.losses,
      rating: claim.rating,
      updatedAt: claim.migratedAt,
      legacyMigratedAt: claim.migratedAt,
    };
    this.profiles.set(playerId, profile);
    this.persistProfiles();
    return { migrated: true, profile: cloneProfile(profile) };
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
    return { recorded: true, ...result };
  }

  async recordBotMatch(match: RecordedBotMatch): Promise<BotMatchResult> {
    if (this.recordedMatchIds.has(match.matchId)) return { recorded: false };
    const current = this.profiles.get(match.playerId);
    if (!current) throw new Error('봇 경기 결과를 저장할 프로필이 없습니다');
    const { player, bot } = rankedBotResult(current, match.botPlayerId ? this.profiles.get(match.botPlayerId) : undefined, match);
    this.profiles.set(player.playerId, player);
    if (bot) this.profiles.set(bot.playerId, bot);
    this.recordedMatchIds.add(match.matchId);
    const { learningGame: _learningGame, ...summary } = match;
    this.botMatches.push(summary);
    this.persistProfiles();
    return { recorded: true, player: cloneProfile(player), ...(bot ? { bot: cloneProfile(bot) } : {}) };
  }

  async getBotMatchProgress(playerId: string, recentLimit = 8): Promise<BotMatchProgress> {
    const matches = this.botMatches
      .filter((match) => match.playerId === playerId)
      .sort(compareRecentBotMatches);
    const recent = matches.slice(0, Math.max(1, recentLimit));
    return {
      completed: matches.length,
      recentWins: recent.filter((match) => match.playerWon).length,
      recentLosses: recent.filter((match) => !match.playerWon).length,
    };
  }

  async getRecentBotOpponents(playerId: string, limit = 5): Promise<string[]> {
    const boundedLimit = recentLimit(limit);
    if (boundedLimit === 0) return [];
    return this.botMatches
      .filter((match) => match.playerId === playerId)
      .sort(compareRecentBotMatches)
      .slice(0, boundedLimit)
      .map(rankedBotIdForMatch)
      .filter((botId): botId is string => botId !== undefined);
  }

  async recordMatchEvent(event: RecordedMatchEvent): Promise<void> {
    const key = this.eventKey(event);
    if (this.recordedEventKeys.has(key)) return;
    this.recordedEventKeys.add(key);
    this.matchEvents.push({ ...event });
    this.persistProfiles();
  }

  async close(): Promise<void> {}

  private snapshot(): FileSnapshot {
    return structuredClone({ profiles: [...this.profiles.values()], matchIds: [...this.recordedMatchIds],
      botMatches: this.botMatches, matchEvents: this.matchEvents });
  }

  private persistProfiles(): void {
    const next = this.snapshot();
    try {
      atomicWriteJson(`${this.filePath}.snapshot.json`, next);
    } catch (error) {
      // A failed commit must remain retryable in this running process as well as after restart.
      const old = structuredClone(this.committed);
      this.profiles.clear();
      for (const profile of old.profiles) this.profiles.set(profile.playerId, profile);
      this.recordedMatchIds.clear();
      for (const id of old.matchIds) this.recordedMatchIds.add(id);
      this.botMatches.splice(0, this.botMatches.length, ...old.botMatches);
      this.matchEvents.splice(0, this.matchEvents.length, ...old.matchEvents);
      this.recordedEventKeys.clear();
      for (const event of old.matchEvents) this.recordedEventKeys.add(this.eventKey(event));
      throw error;
    }
    this.committed = next;
    // Compatibility exports are not the commit record. Their failure cannot undo a saved result.
    try {
      atomicWriteJson(this.filePath, next.profiles);
      atomicWriteJson(this.matchIdsFile, next.matchIds);
      atomicWriteJson(this.botMatchesFile, next.botMatches);
      atomicWriteJson(this.matchEventsFile, next.matchEvents);
    } catch (error) {
      console.error('[profiles] 호환 JSON 사본 저장 실패; snapshot은 저장됨:', error);
    }
  }

  private eventKey(event: RecordedMatchEvent): string {
    return `${event.matchId}:${event.playerId}:${event.event}`;
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
  legacy_migrated_at: Date | string | null;
  bot_learning: BotLearning | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

function rowToProfile(row: ProfileRow): StoredProfile {
  return {
    ...(row.bot_learning ? { botLearning: row.bot_learning } : {}),
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
    ...(optionalIso(row.legacy_migrated_at) ? { legacyMigratedAt: optionalIso(row.legacy_migrated_at) } : {}),
  };
}

const PROFILE_COLUMNS = `
  player_id, token, name, wins, losses, rating, created_at, updated_at,
  toss_user_key, toss_access_token, toss_refresh_token, toss_token_expires_at, unlinked_at,
  legacy_migrated_at, bot_learning
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
        unlinked_at TIMESTAMPTZ,
        legacy_migrated_at TIMESTAMPTZ
      );

      ALTER TABLE mongjin_profiles
        ADD COLUMN IF NOT EXISTS legacy_migrated_at TIMESTAMPTZ;

      ALTER TABLE mongjin_profiles ADD COLUMN IF NOT EXISTS bot_learning JSONB;

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

      CREATE TABLE IF NOT EXISTS mongjin_bot_matches (
        match_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        player_id TEXT NOT NULL REFERENCES mongjin_profiles(player_id),
        player_won BOOLEAN NOT NULL,
        bot_name TEXT NOT NULL,
        bot_rating INTEGER NOT NULL CHECK (bot_rating >= 100),
        bot_search_rating INTEGER,
        difficulty_band TEXT,
        reason TEXT NOT NULL,
        player_rating_before INTEGER NOT NULL,
        player_rating_after INTEGER NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS mongjin_bot_matches_completed_at_idx
        ON mongjin_bot_matches (completed_at DESC);

      ALTER TABLE mongjin_bot_matches
        ADD COLUMN IF NOT EXISTS bot_search_rating INTEGER;

      ALTER TABLE mongjin_bot_matches
        ADD COLUMN IF NOT EXISTS difficulty_band TEXT;

      ALTER TABLE mongjin_bot_matches ADD COLUMN IF NOT EXISTS bot_player_id TEXT REFERENCES mongjin_profiles(player_id);

      CREATE INDEX IF NOT EXISTS mongjin_bot_matches_player_completed_idx
        ON mongjin_bot_matches (player_id, completed_at DESC);

      CREATE TABLE IF NOT EXISTS mongjin_match_events (
        match_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        player_id TEXT NOT NULL REFERENCES mongjin_profiles(player_id),
        match_kind TEXT NOT NULL CHECK (match_kind IN ('random', 'bot')),
        opponent_kind TEXT NOT NULL CHECK (opponent_kind IN ('human', 'bot')),
        event_type TEXT NOT NULL CHECK (event_type IN ('started', 'completed', 'abandoned')),
        platform TEXT NOT NULL CHECK (platform IN ('toss', 'web', 'mobile', 'steam', 'unknown')),
        ply_count INTEGER NOT NULL CHECK (ply_count >= 0),
        outcome TEXT CHECK (outcome IN ('win', 'loss')),
        reason TEXT,
        occurred_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (match_id, player_id, event_type)
      );

      CREATE INDEX IF NOT EXISTS mongjin_match_events_player_time_idx
        ON mongjin_match_events (player_id, occurred_at DESC);

      ALTER TABLE mongjin_match_events
        ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('win', 'loss'));

      CREATE INDEX IF NOT EXISTS mongjin_match_events_kind_time_idx
        ON mongjin_match_events (match_kind, event_type, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS mongjin_legacy_profile_migrations (
        player_id TEXT PRIMARY KEY REFERENCES mongjin_profiles(player_id),
        claimed_name TEXT NOT NULL,
        claimed_wins INTEGER NOT NULL,
        claimed_losses INTEGER NOT NULL,
        claimed_rating INTEGER NOT NULL,
        previous_name TEXT NOT NULL,
        previous_wins INTEGER NOT NULL,
        previous_losses INTEGER NOT NULL,
        previous_rating INTEGER NOT NULL,
        migrated_at TIMESTAMPTZ NOT NULL
      );
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

  async saveProfileMetadata(profile: StoredProfile): Promise<StoredProfile> {
    const result = await this.upsertProfile(this.pool, profile, false, true);
    return rowToProfile(result.rows[0]!);
  }

  async migrateLegacyProfile(
    playerId: string,
    claim: LegacyProfileClaim,
  ): Promise<LegacyProfileMigrationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS}
           FROM mongjin_profiles
          WHERE player_id = $1
          FOR UPDATE`,
        [playerId],
      );
      const row = locked.rows[0];
      if (!row) throw new Error('승계할 프로필이 없습니다');
      const current = rowToProfile(row);
      if (current.legacyMigratedAt) {
        await client.query('COMMIT');
        return { migrated: false, profile: current };
      }

      await client.query(
        `INSERT INTO mongjin_legacy_profile_migrations (
           player_id, claimed_name, claimed_wins, claimed_losses, claimed_rating,
           previous_name, previous_wins, previous_losses, previous_rating, migrated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          playerId,
          claim.name,
          claim.wins,
          claim.losses,
          claim.rating,
          current.name,
          current.wins,
          current.losses,
          current.rating,
          claim.migratedAt,
        ],
      );
      const updated = await client.query<ProfileRow>(
        `UPDATE mongjin_profiles
            SET name = $2,
                wins = $3,
                losses = $4,
                rating = $5,
                updated_at = $6,
                legacy_migrated_at = $6
          WHERE player_id = $1
          RETURNING ${PROFILE_COLUMNS}`,
        [playerId, claim.name, claim.wins, claim.losses, claim.rating, claim.migratedAt],
      );
      await client.query('COMMIT');
      return { migrated: true, profile: rowToProfile(updated.rows[0]!) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async recordBotMatch(match: RecordedBotMatch): Promise<BotMatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS}
           FROM mongjin_profiles
          WHERE player_id = ANY($1::text[])
          ORDER BY player_id
          FOR UPDATE`,
        [[match.playerId, ...(match.botPlayerId ? [match.botPlayerId] : [])]],
      );
      const row = locked.rows.find((item) => item.player_id === match.playerId);
      if (!row) throw new Error('봇 경기 결과를 저장할 프로필이 없습니다');
      const current = rowToProfile(row);

      const claim = await client.query(
        `INSERT INTO mongjin_bot_matches (
           match_id, room_id, player_id, player_won, bot_name, bot_rating,
           bot_search_rating, difficulty_band, reason,
           player_rating_before, player_rating_after, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
         ON CONFLICT (match_id) DO NOTHING
         RETURNING match_id`,
        [
          match.matchId,
          match.roomId,
          match.playerId,
          match.playerWon,
          match.botName,
          match.botRating,
          match.botSearchRating,
          match.difficultyBand,
          match.reason,
          current.rating,
          match.completedAt,
        ],
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return { recorded: false };
      }

      const botRow = locked.rows.find((item) => item.player_id === match.botPlayerId);
      const { player, bot } = rankedBotResult(current, botRow ? rowToProfile(botRow) : undefined, match);
      if (bot) await this.upsertProfile(client, bot, false);
      await this.upsertProfile(client, player, false);
      await client.query(
        `UPDATE mongjin_bot_matches
            SET player_rating_after = $2, bot_player_id = $3
          WHERE match_id = $1`,
        [match.matchId, player.rating, match.botPlayerId ?? null],
      );
      await client.query('COMMIT');
      return { recorded: true, player, bot };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getBotMatchProgress(playerId: string, recentLimit = 8): Promise<BotMatchProgress> {
    const [total, recent] = await Promise.all([
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM mongjin_bot_matches
          WHERE player_id = $1`,
        [playerId],
      ),
      this.pool.query<{ player_won: boolean }>(
        `SELECT player_won
           FROM mongjin_bot_matches
          WHERE player_id = $1
          ORDER BY completed_at DESC
          LIMIT $2`,
        [playerId, Math.max(1, recentLimit)],
      ),
    ]);
    return {
      completed: Number(total.rows[0]?.count ?? 0),
      recentWins: recent.rows.filter((row) => row.player_won).length,
      recentLosses: recent.rows.filter((row) => !row.player_won).length,
    };
  }

  async getRecentBotOpponents(playerId: string, limit = 5): Promise<string[]> {
    const boundedLimit = recentLimit(limit);
    if (boundedLimit === 0) return [];
    const result = await this.pool.query<{ bot_player_id: string | null; bot_name: string }>(
      `SELECT bot_player_id, bot_name
         FROM mongjin_bot_matches
        WHERE player_id = $1
        ORDER BY completed_at DESC, match_id DESC
        LIMIT $2`,
      [playerId, boundedLimit],
    );
    return result.rows
      .map((row) => rankedBotIdForMatch({ botPlayerId: row.bot_player_id ?? undefined, botName: row.bot_name }))
      .filter((botId): botId is string => botId !== undefined);
  }

  async recordMatchEvent(event: RecordedMatchEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO mongjin_match_events (
         match_id, room_id, player_id, match_kind, opponent_kind,
         event_type, platform, ply_count, outcome, reason, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (match_id, player_id, event_type) DO NOTHING`,
      [
        event.matchId,
        event.roomId,
        event.playerId,
        event.matchKind,
        event.opponentKind,
        event.event,
        event.platform,
        event.plyCount,
        event.outcome ?? null,
        event.reason ?? null,
        event.occurredAt,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private upsertProfile(
    executor: Pick<Pool | PoolClient, 'query'>,
    profile: StoredProfile,
    insertOnly: boolean,
    metadataOnly = false,
  ): Promise<{ rowCount: number | null; rows: ProfileRow[] }> {
    const conflict = insertOnly
      ? 'ON CONFLICT (player_id) DO NOTHING'
      : `ON CONFLICT (player_id) DO UPDATE SET
           token = EXCLUDED.token,
           name = EXCLUDED.name,
           ${metadataOnly ? '' : 'wins = EXCLUDED.wins, losses = EXCLUDED.losses, rating = EXCLUDED.rating,'}
           updated_at = EXCLUDED.updated_at,
           toss_user_key = EXCLUDED.toss_user_key,
           toss_access_token = EXCLUDED.toss_access_token,
           toss_refresh_token = EXCLUDED.toss_refresh_token,
           toss_token_expires_at = EXCLUDED.toss_token_expires_at,
           unlinked_at = EXCLUDED.unlinked_at,
           ${metadataOnly ? '' : 'bot_learning = EXCLUDED.bot_learning,'}
           legacy_migrated_at = COALESCE(mongjin_profiles.legacy_migrated_at, EXCLUDED.legacy_migrated_at)`;
    return executor.query<ProfileRow>(
      `INSERT INTO mongjin_profiles (${PROFILE_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ${conflict} RETURNING ${PROFILE_COLUMNS}`,
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
        profile.legacyMigratedAt ?? null,
        profile.botLearning ? JSON.stringify(profile.botLearning) : null,
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
  if (existsSync(`${filePath}.snapshot.json`)) {
    return readSnapshot(filePath).profiles;
  }
  return readProfileFile(filePath);
}
