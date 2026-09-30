import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { Move, Player } from '../src/core/types';
import type { StoredTournamentEvent, TournamentServiceEvent } from './tournamentEvents';

/**
 * 대회 전용 저장소. 프로필 저장소(mongjin_profiles, profiles.json)와 분리되어
 * 대회 결과가 일반 Elo/승패/일일 프로모션 기록을 바꾸지 않는다.
 * 모든 쓰기는 관련 사건 기록과 같은 원자적 경계에서 처리한다.
 */
export type TournamentParticipantKind = 'human' | 'bot';
/** 이 값이 있는 경기만 대회 Elo에 반영한다. 이전 버전(봇 포함) 기록은 재해석하지 않는다. */
export const TOURNAMENT_SCORING_VERSION = 'elo-v1' as const;

export interface TournamentRegistrationRecord {
  playerId: string;
  name: string;
  /** 마지막 신청 시각(ISO) */
  registeredAt: string;
  /** 모집 마감 전 철회 시각. 다시 신청하면 사라진다 */
  withdrawnAt?: string;
  /** 대회에 처음 입장한 시각. enter/reenter 구분용 */
  firstEnteredAt?: string;
  /** 모집 마감 이후(진행 중 입장 포함) 신청 */
  late?: boolean;
}

export interface TournamentMatchRecord {
  matchId: string;
  blackId: string;
  whiteId: string;
  blackKind: TournamentParticipantKind;
  whiteKind: TournamentParticipantKind;
  blackName: string;
  whiteName: string;
  status: 'playing' | 'completed' | 'abandoned';
  winner?: Player;
  reason?: string;
  startedAt: string;
  endedAt?: string;
  moves?: Move[];
  scoring?: typeof TOURNAMENT_SCORING_VERSION;
  blackRatingBefore?: number;
  whiteRatingBefore?: number;
  blackDelta?: number;
  whiteDelta?: number;
  blackRatingAfter?: number;
  whiteRatingAfter?: number;
  blackPlatform?: string;
  whitePlatform?: string;
}

export interface TournamentDecisionRecord {
  status: 'confirmed' | 'cancelled';
  decidedAt: string;
  registrationCount: number;
}

export interface TournamentFinalStanding {
  playerId: string;
  name: string;
  points: number;
  wins: number;
  losses: number;
  games: number;
  rank: number | null;
}

export interface TournamentChampionRecord {
  playerId: string;
  name: string;
  points: number;
  title: string | null;
}

export interface TournamentFinalRecord {
  finalizedAt: string;
  standings: TournamentFinalStanding[];
  champions: TournamentChampionRecord[];
}

export interface TournamentLifecycleRecord {
  decision?: TournamentDecisionRecord;
  reminderAt?: string;
  startedAt?: string;
  finalized?: TournamentFinalRecord;
}
export type TournamentLifecycleKey = keyof TournamentLifecycleRecord;

export interface TournamentStoreData {
  settings: Record<string, unknown> | null;
  lifecycle: TournamentLifecycleRecord;
  registrations: TournamentRegistrationRecord[];
  matches: TournamentMatchRecord[];
  events: StoredTournamentEvent[];
}

export interface TournamentStore {
  readonly kind: 'memory' | 'file' | 'postgres';
  load(): Promise<TournamentStoreData>;
  /** 운영 설정 스냅샷(감사·점수 규칙 고정용) */
  saveSettings(settings: Record<string, unknown>): Promise<void>;
  /** 신청/철회/첫 입장 기록 (upsert) */
  saveRegistration(registration: TournamentRegistrationRecord, events: TournamentServiceEvent[]): Promise<void>;
  appendEvents(events: TournamentServiceEvent[]): Promise<void>;
  startMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<void>;
  /** 이미 최종 상태인 경기는 바꾸지 않고 false. 같은 결과가 두 번 들어와도 한 번만 반영된다 */
  finishMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<boolean>;
  /** 값이 아직 없을 때만 기록하고 true. 확정/취소·알림·최종화가 재시작 후 중복되지 않는다 */
  setLifecycle<K extends TournamentLifecycleKey>(
    key: K,
    value: NonNullable<TournamentLifecycleRecord[K]>,
    events: TournamentServiceEvent[],
  ): Promise<boolean>;
  markEventsDelivered(ids: string[], deliveredAt: number): Promise<void>;
  close(): Promise<void>;
}

interface FileShape {
  version: 2;
  tournamentId: string;
  settings: Record<string, unknown> | null;
  lifecycle: TournamentLifecycleRecord;
  registrations: Record<string, TournamentRegistrationRecord>;
  matches: Record<string, TournamentMatchRecord>;
  events: Record<string, StoredTournamentEvent>;
}

function stored(events: TournamentServiceEvent[]): StoredTournamentEvent[] {
  return events.map((event) => ({ ...structuredClone(event), deliveredAt: null }));
}

/** filePath가 null이면 메모리 전용(테스트). 쓰기는 직렬화하고 임시 파일 + rename으로 원자적으로 교체한다. */
export class FileTournamentStore implements TournamentStore {
  readonly kind: 'memory' | 'file';
  private data: FileShape;
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly tournamentId: string, private readonly filePath: string | null) {
    this.kind = filePath ? 'file' : 'memory';
    this.data = FileTournamentStore.empty(tournamentId);
  }

  private static empty(tournamentId: string): FileShape {
    return { version: 2, tournamentId, settings: null, lifecycle: {}, registrations: {}, matches: {}, events: {} };
  }

  async load(): Promise<TournamentStoreData> {
    if (!this.loaded) {
      this.loaded = true;
      if (this.filePath) {
        try {
          const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<FileShape> & { version?: number };
          if (parsed.tournamentId && parsed.tournamentId !== this.tournamentId) {
            throw new Error('대회 저장 파일의 대회 ID가 다릅니다');
          }
          // 버전 1 파일의 entrants(봇 포함)는 새 신청으로 옮기지 않는다. 경기 기록은 보존만 한다.
          const current = parsed.version === 2;
          this.data = {
            ...FileTournamentStore.empty(this.tournamentId),
            settings: current ? parsed.settings ?? null : null,
            lifecycle: current ? parsed.lifecycle ?? {} : {},
            registrations: current ? parsed.registrations ?? {} : {},
            matches: parsed.matches ?? {},
            events: current ? parsed.events ?? {} : {},
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return structuredClone({
      settings: this.data.settings,
      lifecycle: this.data.lifecycle,
      registrations: Object.values(this.data.registrations),
      matches: Object.values(this.data.matches),
      events: Object.values(this.data.events).sort((a, b) => a.occurredAt - b.occurredAt),
    });
  }

  saveSettings(settings: Record<string, unknown>): Promise<void> {
    return this.mutate(() => {
      this.data.settings = structuredClone(settings);
      return true;
    }).then(() => undefined);
  }

  saveRegistration(registration: TournamentRegistrationRecord, events: TournamentServiceEvent[]): Promise<void> {
    return this.mutate(() => {
      this.data.registrations[registration.playerId] = structuredClone(registration);
      this.addEvents(events);
      return true;
    }).then(() => undefined);
  }

  appendEvents(events: TournamentServiceEvent[]): Promise<void> {
    if (!events.length) return Promise.resolve();
    return this.mutate(() => this.addEvents(events)).then(() => undefined);
  }

  startMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<void> {
    return this.mutate(() => {
      if (this.data.matches[match.matchId]) return false;
      this.data.matches[match.matchId] = structuredClone({ ...match, status: 'playing' as const });
      this.addEvents(events);
      return true;
    }).then(() => undefined);
  }

  finishMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<boolean> {
    return this.mutate(() => {
      const existing = this.data.matches[match.matchId];
      if (existing && existing.status !== 'playing') return false;
      this.data.matches[match.matchId] = structuredClone(match);
      this.addEvents(events);
      return true;
    });
  }

  setLifecycle<K extends TournamentLifecycleKey>(
    key: K,
    value: NonNullable<TournamentLifecycleRecord[K]>,
    events: TournamentServiceEvent[],
  ): Promise<boolean> {
    return this.mutate(() => {
      if (this.data.lifecycle[key] !== undefined) return false;
      this.data.lifecycle[key] = structuredClone(value);
      this.addEvents(events);
      return true;
    });
  }

  markEventsDelivered(ids: string[], deliveredAt: number): Promise<void> {
    return this.mutate(() => {
      let changed = false;
      for (const id of ids) {
        const event = this.data.events[id];
        if (event && event.deliveredAt === null) {
          event.deliveredAt = deliveredAt;
          changed = true;
        }
      }
      return changed;
    }).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private addEvents(events: TournamentServiceEvent[]): boolean {
    let changed = false;
    for (const event of stored(events)) {
      if (this.data.events[event.id]) continue;
      this.data.events[event.id] = event;
      changed = true;
    }
    return changed;
  }

  private mutate(change: () => boolean): Promise<boolean> {
    const run = this.queue.catch(() => undefined).then(async () => {
      if (!this.loaded) await this.load();
      const snapshot = structuredClone(this.data);
      const changed = change();
      if (!changed) return false;
      if (this.filePath) {
        try {
          await mkdir(dirname(this.filePath), { recursive: true });
          const temporary = this.filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
          await writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
          await rename(temporary, this.filePath);
        } catch (error) {
          this.data = snapshot;
          throw error;
        }
      }
      return true;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class PostgresTournamentStore implements TournamentStore {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;

  constructor(private readonly tournamentId: string, connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mongjin_tournament_matches (
        tournament_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        black_id TEXT NOT NULL,
        white_id TEXT NOT NULL,
        black_kind TEXT NOT NULL,
        white_kind TEXT NOT NULL,
        black_name TEXT NOT NULL,
        white_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('playing', 'completed', 'abandoned')),
        winner TEXT CHECK (winner IN ('BLACK', 'WHITE')),
        reason TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        moves JSONB,
        PRIMARY KEY (tournament_id, match_id)
      );
      ALTER TABLE mongjin_tournament_matches
        ADD COLUMN IF NOT EXISTS scoring TEXT,
        ADD COLUMN IF NOT EXISTS black_rating_before INTEGER,
        ADD COLUMN IF NOT EXISTS white_rating_before INTEGER,
        ADD COLUMN IF NOT EXISTS black_delta INTEGER,
        ADD COLUMN IF NOT EXISTS white_delta INTEGER,
        ADD COLUMN IF NOT EXISTS black_rating_after INTEGER,
        ADD COLUMN IF NOT EXISTS white_rating_after INTEGER,
        ADD COLUMN IF NOT EXISTS black_platform TEXT,
        ADD COLUMN IF NOT EXISTS white_platform TEXT;
      CREATE TABLE IF NOT EXISTS mongjin_tournament_registrations (
        tournament_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        registered_at TIMESTAMPTZ NOT NULL,
        withdrawn_at TIMESTAMPTZ,
        first_entered_at TIMESTAMPTZ,
        late BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (tournament_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS mongjin_tournament_state (
        tournament_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tournament_id, key)
      );
      CREATE TABLE IF NOT EXISTS mongjin_tournament_events (
        tournament_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        occurred_at BIGINT NOT NULL,
        player_ids JSONB NOT NULL,
        data JSONB NOT NULL,
        delivered_at BIGINT,
        PRIMARY KEY (tournament_id, event_id)
      );
    `);
  }

  async load(): Promise<TournamentStoreData> {
    const id = [this.tournamentId];
    const [state, registrations, matches, events] = await Promise.all([
      this.pool.query('SELECT key, value FROM mongjin_tournament_state WHERE tournament_id = $1', id),
      this.pool.query('SELECT * FROM mongjin_tournament_registrations WHERE tournament_id = $1', id),
      this.pool.query('SELECT * FROM mongjin_tournament_matches WHERE tournament_id = $1 ORDER BY started_at', id),
      this.pool.query('SELECT * FROM mongjin_tournament_events WHERE tournament_id = $1 ORDER BY occurred_at, event_id', id),
    ]);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : undefined);
    const int = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
    const lifecycle: TournamentLifecycleRecord = {};
    let settings: Record<string, unknown> | null = null;
    for (const row of state.rows) {
      if (row.key === 'settings') settings = row.value;
      else (lifecycle as Record<string, unknown>)[row.key] = row.value;
    }
    return {
      settings,
      lifecycle,
      registrations: registrations.rows.map((row) => ({
        playerId: row.player_id,
        name: row.name,
        registeredAt: iso(row.registered_at)!,
        withdrawnAt: iso(row.withdrawn_at),
        firstEnteredAt: iso(row.first_entered_at),
        late: Boolean(row.late),
      })),
      matches: matches.rows.map((row) => ({
        matchId: row.match_id,
        blackId: row.black_id,
        whiteId: row.white_id,
        blackKind: row.black_kind,
        whiteKind: row.white_kind,
        blackName: row.black_name,
        whiteName: row.white_name,
        status: row.status,
        winner: row.winner ?? undefined,
        reason: row.reason ?? undefined,
        startedAt: iso(row.started_at)!,
        endedAt: iso(row.ended_at),
        moves: row.moves ?? undefined,
        scoring: row.scoring ?? undefined,
        blackRatingBefore: int(row.black_rating_before),
        whiteRatingBefore: int(row.white_rating_before),
        blackDelta: int(row.black_delta),
        whiteDelta: int(row.white_delta),
        blackRatingAfter: int(row.black_rating_after),
        whiteRatingAfter: int(row.white_rating_after),
        blackPlatform: row.black_platform ?? undefined,
        whitePlatform: row.white_platform ?? undefined,
      })),
      events: events.rows.map((row) => ({
        id: row.event_id,
        tournamentId: row.tournament_id,
        title: row.title,
        kind: row.kind,
        occurredAt: Number(row.occurred_at),
        playerIds: row.player_ids,
        data: row.data,
        deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
      })),
    };
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO mongjin_tournament_state (tournament_id, key, value) VALUES ($1, 'settings', $2::jsonb)
       ON CONFLICT (tournament_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.tournamentId, JSON.stringify(settings)],
    );
  }

  saveRegistration(registration: TournamentRegistrationRecord, events: TournamentServiceEvent[]): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO mongjin_tournament_registrations
          (tournament_id, player_id, name, registered_at, withdrawn_at, first_entered_at, late)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tournament_id, player_id) DO UPDATE SET
           name = EXCLUDED.name, registered_at = EXCLUDED.registered_at, withdrawn_at = EXCLUDED.withdrawn_at,
           first_entered_at = EXCLUDED.first_entered_at, late = EXCLUDED.late`,
        [this.tournamentId, registration.playerId, registration.name, registration.registeredAt,
          registration.withdrawnAt ?? null, registration.firstEnteredAt ?? null, Boolean(registration.late)],
      );
      await this.insertEvents(client, events);
    });
  }

  appendEvents(events: TournamentServiceEvent[]): Promise<void> {
    if (!events.length) return Promise.resolve();
    return this.transaction((client) => this.insertEvents(client, events));
  }

  startMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<void> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO mongjin_tournament_matches
          (tournament_id, match_id, black_id, white_id, black_kind, white_kind, black_name, white_name, status, started_at,
           scoring, black_rating_before, white_rating_before, black_platform, white_platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'playing', $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tournament_id, match_id) DO NOTHING RETURNING match_id`,
        [this.tournamentId, match.matchId, match.blackId, match.whiteId, match.blackKind, match.whiteKind,
          match.blackName, match.whiteName, match.startedAt, match.scoring ?? null, match.blackRatingBefore ?? null,
          match.whiteRatingBefore ?? null, match.blackPlatform ?? null, match.whitePlatform ?? null],
      );
      if ((inserted.rowCount ?? 0) > 0) await this.insertEvents(client, events);
    });
  }

  finishMatch(match: TournamentMatchRecord, events: TournamentServiceEvent[]): Promise<boolean> {
    return this.transaction(async (client) => {
      // 시작 기록이 유실된 경우에도 최종 기록을 남기되, 이미 최종 상태면 바꾸지 않는다.
      const result = await client.query(
        `INSERT INTO mongjin_tournament_matches
          (tournament_id, match_id, black_id, white_id, black_kind, white_kind, black_name, white_name,
           status, winner, reason, started_at, ended_at, moves, scoring, black_rating_before, white_rating_before,
           black_delta, white_delta, black_rating_after, white_rating_after, black_platform, white_platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (tournament_id, match_id) DO UPDATE SET
           status = EXCLUDED.status, winner = EXCLUDED.winner, reason = EXCLUDED.reason,
           ended_at = EXCLUDED.ended_at, moves = EXCLUDED.moves, scoring = EXCLUDED.scoring,
           black_rating_before = EXCLUDED.black_rating_before, white_rating_before = EXCLUDED.white_rating_before,
           black_delta = EXCLUDED.black_delta, white_delta = EXCLUDED.white_delta,
           black_rating_after = EXCLUDED.black_rating_after, white_rating_after = EXCLUDED.white_rating_after
         WHERE mongjin_tournament_matches.status = 'playing'
         RETURNING match_id`,
        [this.tournamentId, match.matchId, match.blackId, match.whiteId, match.blackKind, match.whiteKind,
          match.blackName, match.whiteName, match.status, match.winner ?? null, match.reason ?? null,
          match.startedAt, match.endedAt ?? new Date().toISOString(), JSON.stringify(match.moves ?? []),
          match.scoring ?? null, match.blackRatingBefore ?? null, match.whiteRatingBefore ?? null,
          match.blackDelta ?? null, match.whiteDelta ?? null, match.blackRatingAfter ?? null, match.whiteRatingAfter ?? null,
          match.blackPlatform ?? null, match.whitePlatform ?? null],
      );
      const changed = (result.rowCount ?? 0) > 0;
      if (changed) await this.insertEvents(client, events);
      return changed;
    });
  }

  setLifecycle<K extends TournamentLifecycleKey>(
    key: K,
    value: NonNullable<TournamentLifecycleRecord[K]>,
    events: TournamentServiceEvent[],
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO mongjin_tournament_state (tournament_id, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tournament_id, key) DO NOTHING RETURNING key`,
        [this.tournamentId, key, JSON.stringify(value)],
      );
      const changed = (result.rowCount ?? 0) > 0;
      if (changed) await this.insertEvents(client, events);
      return changed;
    });
  }

  async markEventsDelivered(ids: string[], deliveredAt: number): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(
      `UPDATE mongjin_tournament_events SET delivered_at = $3
       WHERE tournament_id = $1 AND event_id = ANY($2::text[]) AND delivered_at IS NULL`,
      [this.tournamentId, ids, deliveredAt],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async insertEvents(client: PoolClient, events: TournamentServiceEvent[]): Promise<void> {
    for (const event of events) {
      await client.query(
        `INSERT INTO mongjin_tournament_events
          (tournament_id, event_id, kind, title, occurred_at, player_ids, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (tournament_id, event_id) DO NOTHING`,
        [this.tournamentId, event.id, event.kind, event.title, event.occurredAt,
          JSON.stringify(event.playerIds), JSON.stringify(event.data)],
      );
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function createTournamentStore(
  tournamentId: string,
  filePath: string,
  connectionString = process.env.DATABASE_URL,
): Promise<TournamentStore> {
  if (!connectionString) return new FileTournamentStore(tournamentId, filePath);
  const store = new PostgresTournamentStore(tournamentId, connectionString);
  await store.initialize();
  return store;
}
