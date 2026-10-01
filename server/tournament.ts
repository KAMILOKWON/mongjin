import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { GameState, Move, Player } from '../src/core/types';
import {
  TOURNAMENT_PROTOCOL_VERSION,
  type TournamentBackgroundView,
  type TournamentConfigView,
  type TournamentEndReason,
  type TournamentEntrantStatus,
  type TournamentErrorCode,
  type TournamentMatchView,
  type TournamentNextEvent,
  type TournamentPauseReason,
  type TournamentPhase,
  type TournamentPresence,
  type TournamentPublicStatus,
  type TournamentServerMessage,
  type TournamentSnapshot,
  type TournamentStandingView,
} from '../src/net/tournamentProtocol';
import type { MatchPlatform, StoredProfile } from './profileRepository';
import { isRankedBotId, selectRankedBot } from './rankedBots';
import { chooseOfficialBotMove, createRankedBot, officialBotMoveDelayMs, type OfficialBot } from './officialBot';
import {
  DEFAULT_BACKGROUND_LEASE_MS,
  DEFAULT_BACKGROUND_READY_TIMEOUT_MS,
  MAX_BACKGROUND_LEASE_MS,
  MAX_BACKGROUND_READY_TIMEOUT_MS,
  MIN_BACKGROUND_LEASE_MS,
  MIN_BACKGROUND_READY_TIMEOUT_MS,
  isPresence,
  parseBackgroundDestination,
  type BackgroundChangeSink,
  type BackgroundLease,
  type CanBackgroundWait,
  type TournamentBackgroundDestination,
  type TournamentBackgroundChange,
  type TournamentBackgroundStatus,
} from './tournamentBackground';
import { eloDelta, rankEntrants, type HeadToHeadResult } from './tournamentElo';
import {
  TournamentEventDispatcher,
  tournamentEventId,
  type TournamentEventKind,
  type TournamentEventSink,
  type TournamentServiceEvent,
} from './tournamentEvents';
import {
  TOURNAMENT_SCORING_VERSION,
  type TournamentFinalRecord,
  type TournamentLifecycleRecord,
  type TournamentMatchRecord,
  type TournamentRegistrationRecord,
  type TournamentStore,
} from './tournamentStore';

export type { TournamentEventKind, TournamentServiceEvent, TournamentEventSink } from './tournamentEvents';
export type { CanBackgroundWait, BackgroundChangeSink, TournamentBackgroundChange, TournamentBackgroundStatus } from './tournamentBackground';

export const DEFAULT_TOURNAMENT_TITLE = '제1회 천하제일몽진대회';
export const DEFAULT_INAUGURAL_CHAMPION_TITLE = '초대 천하제일몽진대회 우승자';

/** 대회 한 개의 운영 설정. 반복 주기는 코드에 두지 않고 대회마다 운영자가 지정한다. */
export interface TournamentSettings {
  id: string;
  title: string;
  /** epoch ms */
  registrationStartsAt: number;
  /** 이 시각의 신청 수로 개최 확정/취소를 한 번 결정한다 */
  registrationEndsAt: number;
  startsAt: number;
  /** 이 시각 이후 새 경기를 시작하지 않는다 */
  endsAt: number;
  minimumParticipants: number;
  minimumRankedMatches: number;
  startingScore: number;
  eloK: number;
  eloScale: number;
  /** 매칭 후 양쪽 준비 확인을 기다리는 최대 시간 */
  readyTimeoutMs: number;
  /** 양쪽 준비 뒤 서버가 세는 시작 카운트다운. 이 동안 착수 시계는 없다 */
  matchCountdownMs: number;
  moveTimeMs: number;
  reconnectGraceMs: number;
  /** 시작 전 알림 시점. 0이면 보내지 않는다 */
  reminderLeadMs: number;
  /** 앱 밖 대기 유효 기간. 클라이언트 신호로 연장되지 않는다 */
  backgroundLeaseMs?: number;
  /** 참가자 중 앱 밖에서 매칭된 사람이 있을 때의 준비 제한 시간 */
  backgroundReadyTimeoutMs?: number;
  isInaugural: boolean;
  /** 우승자 칭호. 없으면 대회명 + ' 우승자' */
  championTitle: string;
  rewardDescription: string;
  /** 운영자가 설정한 다음 대회. 없으면 null (날짜를 만들어내지 않는다) */
  nextTournament: TournamentNextEvent | null;
  /** 운영자가 고른 고정 공식 봇 ID 목록. 비어 있으면 기존 인간 전용 대회다. */
  rankedBotIds?: string;
  /** 이전 클라이언트 표시용. 자동 다음 대기에는 쓰지 않는다 */
  resultCountdownMs: number;
  /** 봇 대회에서 혼자 기다린 사람에게 봇을 붙이기까지의 대기 시간 */
  waitMs: number;
  standingsLimit: number;
  eventRetryMs: number;
}

export interface TournamentIdentity {
  playerId: string;
  name: string;
  platform: MatchPlatform;
  /** 이전 버전 호환 필드. 참가 자격에 쓰지 않는다 */
  loopback?: boolean;
}

export interface TournamentClient {
  send(message: TournamentServerMessage): void;
}

export interface TournamentServiceOptions {
  settings: TournamentSettings | null;
  store: TournamentStore | null;
  /** 읽기 전용 실제 프로필. 봇 참가에는 프로필이 모두 있어야 한다. */
  getBotProfiles?: () => Iterable<StoredProfile>;
  /** 같은 플레이어가 일반 대국/대기열에 있는지 (다른 소켓 포함) */
  isPlayerBusyElsewhere?: (playerId: string) => boolean;
  /** 저장된 대회 사건 수신. 실패하면 재시도하고 재시작 후에도 미전달분을 다시 보낸다 */
  onEvent?: TournamentEventSink;
  /** 앱 밖 대기 허용 판정(저장된 대기 기기와 실제 발송 가능 여부). 없으면 앱 밖 대기를 허용하지 않는다 */
  canBackgroundWait?: CanBackgroundWait;
  /** 앱 밖 표시 상태 변화. 실패해도 매칭은 계속된다 */
  onBackgroundChange?: BackgroundChangeSink;
  ruleConfig?: RuleConfig;
  random?: () => number;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
}

// ─── 설정 ──────────────────────────────────────────────────────────────────

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 비어 있으면 fallback, 값이 있는데 잘못되면 NaN */
function optionalTime(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return parseTime(value) ?? Number.NaN;
}

function parseNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function flag(value: string | undefined): boolean {
  return value === '1' || value?.trim().toLowerCase() === 'true';
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Optional CSV input: trim IDs, preserve the chosen order, and reject every ambiguous entry. */
export function parseTournamentRankedBotIds(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === '') return [];
  const ids = value.split(',').map((id) => id.trim());
  if (ids.length > 4 || ids.some((id) => !id || !isRankedBotId(id)) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function nextTournamentFromEnv(env: Record<string, string | undefined>): TournamentNextEvent | null {
  const id = env.MONGJIN_TOURNAMENT_NEXT_ID?.trim();
  const startsAt = parseTime(env.MONGJIN_TOURNAMENT_NEXT_STARTS_AT);
  const endsAt = parseTime(env.MONGJIN_TOURNAMENT_NEXT_ENDS_AT);
  if (!id || !ID_PATTERN.test(id) || startsAt === null || endsAt === null || endsAt <= startsAt) return null;
  return { id, title: env.MONGJIN_TOURNAMENT_NEXT_TITLE?.trim() || '천하제일몽진대회', startsAt, endsAt };
}

/**
 * MONGJIN_TOURNAMENT_ID/STARTS_AT/ENDS_AT 중 하나라도 없거나 잘못되면 대회 비활성(null).
 * 모집 시작 기본값은 즉시, 모집 마감 기본값은 대회 시작 시각이다.
 * 이전 봇 관련 변수(MIN_HUMANS, BOT_POOL)와 토스 전용 테스트 우회는 더 이상 읽지 않는다.
 */
export function tournamentSettingsFromEnv(
  env: Record<string, string | undefined>,
  logger: Pick<Console, 'warn'> = console,
): TournamentSettings | null {
  const id = env.MONGJIN_TOURNAMENT_ID?.trim();
  const startsAt = parseTime(env.MONGJIN_TOURNAMENT_STARTS_AT);
  const endsAt = parseTime(env.MONGJIN_TOURNAMENT_ENDS_AT);
  if (!id && startsAt === null && endsAt === null) return null;
  const invalid = () => {
    logger.warn('[tournament] 대회 환경 변수가 올바르지 않아 대회를 비활성화합니다');
    return null;
  };
  if (!id || !ID_PATTERN.test(id) || startsAt === null || endsAt === null || endsAt <= startsAt) return invalid();
  const registrationStartsAt = optionalTime(env.MONGJIN_TOURNAMENT_REGISTRATION_STARTS_AT, 0);
  const registrationEndsAt = optionalTime(env.MONGJIN_TOURNAMENT_REGISTRATION_ENDS_AT, startsAt);
  if (
    !Number.isFinite(registrationStartsAt) ||
    !Number.isFinite(registrationEndsAt) ||
    registrationStartsAt >= registrationEndsAt ||
    registrationEndsAt > startsAt
  ) return invalid();
  const title = env.MONGJIN_TOURNAMENT_TITLE?.trim() || DEFAULT_TOURNAMENT_TITLE;
  const isInaugural = flag(env.MONGJIN_TOURNAMENT_INAUGURAL);
  const rankedBotIds = parseTournamentRankedBotIds(env.MONGJIN_TOURNAMENT_RANKED_BOT_IDS);
  if (!rankedBotIds) return invalid();
  return {
    id,
    title,
    registrationStartsAt,
    registrationEndsAt,
    startsAt,
    endsAt,
    minimumParticipants: parseNumber(env.MONGJIN_TOURNAMENT_MIN_PARTICIPANTS, 2, 2, 100_000),
    minimumRankedMatches: parseNumber(env.MONGJIN_TOURNAMENT_MIN_RANKED_MATCHES, 3, 1, 1_000),
    startingScore: parseNumber(env.MONGJIN_TOURNAMENT_STARTING_SCORE, 0, -100_000, 100_000),
    eloK: parseNumber(env.MONGJIN_TOURNAMENT_ELO_K, 32, 1, 400),
    eloScale: parseNumber(env.MONGJIN_TOURNAMENT_ELO_SCALE, 400, 50, 4_000),
    readyTimeoutMs: parseNumber(env.MONGJIN_TOURNAMENT_READY_TIMEOUT_MS, 15_000, 1_000, 120_000),
    matchCountdownMs: parseNumber(env.MONGJIN_TOURNAMENT_MATCH_COUNTDOWN_MS, 5_000, 0, 60_000),
    moveTimeMs: parseNumber(env.MONGJIN_TOURNAMENT_MOVE_MS, 30_000, 3_000, 600_000),
    reconnectGraceMs: parseNumber(env.MONGJIN_TOURNAMENT_RECONNECT_GRACE_MS, 20_000, 1_000, 300_000),
    reminderLeadMs: parseNumber(env.MONGJIN_TOURNAMENT_REMINDER_LEAD_MS, 3_600_000, 0, 86_400_000),
    backgroundLeaseMs: parseNumber(env.MONGJIN_TOURNAMENT_BACKGROUND_LEASE_MS, DEFAULT_BACKGROUND_LEASE_MS, MIN_BACKGROUND_LEASE_MS, MAX_BACKGROUND_LEASE_MS),
    backgroundReadyTimeoutMs: parseNumber(
      env.MONGJIN_TOURNAMENT_BACKGROUND_READY_TIMEOUT_MS,
      DEFAULT_BACKGROUND_READY_TIMEOUT_MS,
      MIN_BACKGROUND_READY_TIMEOUT_MS,
      MAX_BACKGROUND_READY_TIMEOUT_MS,
    ),
    isInaugural,
    championTitle: env.MONGJIN_TOURNAMENT_CHAMPION_TITLE?.trim()
      || (isInaugural ? DEFAULT_INAUGURAL_CHAMPION_TITLE : title + ' 우승자'),
    rewardDescription: env.MONGJIN_TOURNAMENT_REWARD_DESCRIPTION?.trim() ?? '',
    nextTournament: nextTournamentFromEnv(env),
    ...(rankedBotIds.length ? { rankedBotIds: rankedBotIds.join(',') } : {}),
    resultCountdownMs: parseNumber(env.MONGJIN_TOURNAMENT_RESULT_COUNTDOWN_MS, 5_000, 0, 60_000),
    waitMs: parseNumber(env.MONGJIN_TOURNAMENT_WAIT_MS, 15_000, 0, 600_000),
    standingsLimit: 100,
    eventRetryMs: parseNumber(env.MONGJIN_TOURNAMENT_EVENT_RETRY_MS, 30_000, 1_000, 3_600_000),
  };
}

// ─── 내부 상태 ────────────────────────────────────────────────────────────

interface Entrant {
  playerId: string;
  name: string;
  key: string;
  isBot: boolean;
  registration: TournamentRegistrationRecord | null;
  platform: string;
  points: number;
  wins: number;
  losses: number;
  games: number;
  status: TournamentEntrantStatus;
  queuedAt: number | null;
  matchId: string | null;
  lastOpponentId: string | null;
  /** 지금 대회 화면에 들어와 있는지(입장~퇴장). enter/leave/reenter 지표용 */
  present: boolean;
  /** 앱 표시 상태. 알리지 않는 클라이언트는 foreground */
  presence: TournamentPresence;
  /** 비동기 목적지 검증 도중 상태가 바뀌었는지 확인하는 순번 */
  presenceSeq: number;
  /** 유효한 앱 밖 대기. 서버 메모리에만 있어 재시작하면 사라진다 */
  lease: BackgroundLease | null;
  /** foreground 복귀 뒤에도 실제 종료 때까지 OS 표시 종료 책임을 유지한다 */
  backgroundActive: boolean;
  pausedReason: TournamentPauseReason | null;
}

interface Side {
  playerId: string;
  name: string;
  platform: string;
  isBot: boolean;
  /** 매칭 전 대기 시작 시각. 시작 전 취소 시 순서를 되돌린다 */
  queuedAt: number;
  /** 이 경기가 본인의 몇 번째 점수 반영 경기인지 */
  matchNumber: number | null;
}

interface LiveMatch {
  id: string;
  black: Side;
  white: Side;
  state: GameState;
  status: 'preparing' | 'countdown' | 'playing' | 'finished';
  ready: Set<Player>;
  readyTimer: ReturnType<typeof setTimeout> | null;
  botTimer: ReturnType<typeof setTimeout> | null;
  readyDeadline: number | null;
  preparedAt: number;
  startsAt: number | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  finishing: boolean;
  startedAt: number | null;
  turnDeadline: number | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  graceTimers: Map<Player, ReturnType<typeof setTimeout>>;
  startPersist: Promise<void>;
  ratingsBefore: Record<Player, number> | null;
  deltas: Record<Player, number> | null;
  botEngine: OfficialBot | null;
  winner: Player | null;
  reason: TournamentEndReason | null;
  finishedAt: number | null;
}

const ERROR_MESSAGES: Record<TournamentErrorCode, string> = {
  NOT_AUTHENTICATED: '프로필 연결을 먼저 완료해 주세요',
  DISABLED: '진행 중인 대회가 없어요',
  NOT_ELIGIBLE: '대회에 참가할 수 없는 계정이에요',
  NOT_STARTED: '아직 대회가 시작되지 않았어요',
  ENDED: '대회가 끝났어요',
  NOT_JOINED: '대회에 먼저 참가해 주세요',
  BUSY_ELSEWHERE: '다른 대국을 마친 뒤 참가해 주세요',
  IN_MATCH: '진행 중인 대회 경기가 있어요',
  NO_MATCH: '진행 중인 대회 경기가 없어요',
  STALE_MOVE: '판이 이미 바뀌었어요',
  NOT_YOUR_TURN: '내 차례가 아니에요',
  ILLEGAL_MOVE: '둘 수 없는 수예요',
  MATCH_FINISHED: '이미 끝난 경기예요',
  SUPERSEDED: '다른 화면에서 대회에 접속했어요',
  INVALID_MESSAGE: '잘못된 요청이에요',
  SERVER_ERROR: '요청을 처리하지 못했어요',
  UPDATE_REQUIRED: '앱을 최신 버전으로 업데이트해 주세요',
  REGISTRATION_CLOSED: '참가 신청 기간이 아니에요',
  CANCELLED: '참가 인원이 부족해 이번 대회는 열리지 않아요',
  NOT_READY: '대국이 아직 시작되지 않았어요',
  FOREGROUND_REQUIRED: '앱으로 돌아온 뒤 준비해 주세요',
};

const END_REASONS = new Set<TournamentEndReason>([
  'goal', 'capture', 'surround', 'no-moves', 'resign', 'timeout', 'disconnect', 'abandoned', 'store-error',
]);

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function parseCoord(value: unknown): { r: number; c: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { r, c } = value as { r?: unknown; c?: unknown };
  return isInt(r) && isInt(c) ? { r, c } : null;
}

/** 여분 필드를 버린 정규 수 객체. 형식이 틀리면 null */
export function parseTournamentMove(value: unknown): Move | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { kind?: unknown; from?: unknown; to?: unknown };
  const to = parseCoord(raw.to);
  if (!to) return null;
  if (raw.kind === 'PLACE') return { kind: 'PLACE', to };
  if (raw.kind === 'MOVE') {
    const from = parseCoord(raw.from);
    return from ? { kind: 'MOVE', from, to } : null;
  }
  return null;
}

function sameMove(left: Move, right: Move): boolean {
  if (left.kind !== right.kind || left.to.r !== right.to.r || left.to.c !== right.to.c) return false;
  if (left.kind === 'MOVE' && right.kind === 'MOVE') return left.from.r === right.from.r && left.from.c === right.from.c;
  return true;
}

const iso = (ms: number) => new Date(ms).toISOString();
const PRE_START = new Set<TournamentEntrantStatus>(['preparing', 'countdown']);

interface StandingRow {
  entrant: Entrant;
  rank: number | null;
  qualified: boolean;
}

// ─── 서비스 ───────────────────────────────────────────────────────────────

/**
 * 대회 한 개를 소유하는 서버 권위 서비스. 사람끼리만 매칭하고 플랫폼으로 참가를 제한하지 않는다.
 * 신청(registration)과 실제 대기(queue)는 별개다. 결과 화면에서는 명시적인 NEXT 전까지 다시 대기하지 않는다.
 */
export class TournamentService {
  private readonly settings: (TournamentSettings & { backgroundLeaseMs: number; backgroundReadyTimeoutMs: number }) | null;
  private readonly store: TournamentStore | null;
  private readonly ruleConfig: RuleConfig;
  private readonly random: () => number;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  private readonly entrants = new Map<string, Entrant>();
  private readonly matches = new Map<string, LiveMatch>();
  private readonly botProfiles = new Map<string, StoredProfile>();
  private readonly reservedBotIds = new Set<string>();
  private readonly clientsByPlayer = new Map<string, TournamentClient>();
  private readonly playerByClient = new Map<TournamentClient, string>();
  private readonly identities = new Map<string, TournamentIdentity>();
  private readonly supersededClients = new WeakSet<TournamentClient>();
  private backgroundChanges: Promise<void> = Promise.resolve();
  private readonly headToHead: HeadToHeadResult[] = [];
  private lifecycle: TournamentLifecycleRecord = {};
  private dispatcher: TournamentEventDispatcher | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private standingsCache: StandingRow[] | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastPhase: TournamentPhase = 'disabled';
  private ready = false;
  private closed = false;

  constructor(private readonly options: TournamentServiceOptions) {
    this.settings = options.settings ? {
      ...options.settings,
      backgroundLeaseMs: parseNumber(String(options.settings.backgroundLeaseMs ?? DEFAULT_BACKGROUND_LEASE_MS), DEFAULT_BACKGROUND_LEASE_MS, MIN_BACKGROUND_LEASE_MS, MAX_BACKGROUND_LEASE_MS),
      backgroundReadyTimeoutMs: parseNumber(String(options.settings.backgroundReadyTimeoutMs ?? DEFAULT_BACKGROUND_READY_TIMEOUT_MS), DEFAULT_BACKGROUND_READY_TIMEOUT_MS, MIN_BACKGROUND_READY_TIMEOUT_MS, MAX_BACKGROUND_READY_TIMEOUT_MS),
    } : null;
    this.store = options.store;
    this.ruleConfig = options.ruleConfig ?? { ...DEFAULT_CONFIG };
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? console;
  }

  /**
   * 저장된 신청·결과·생명주기를 불러온다. 끝나지 못한 경기는 점수 없이 abandoned로 닫고,
   * 점수는 저장된 변화량의 합으로만 복원한다. 미전달 사건은 다시 보낸다.
   */
  async init(): Promise<void> {
    if (this.ready) return;
    const settings = this.settings;
    const store = this.store;
    if (settings && store) {
      this.loadConfiguredBotProfiles();
      const data = await store.load();
      this.lockScoring(data.settings);
      await store.saveSettings({ ...settings });
      this.lifecycle = data.lifecycle ?? {};
      for (const registration of data.registrations) {
        if (isRankedBotId(registration.playerId)) continue;
        const entrant = this.ensureEntrant(registration.playerId, registration.name);
        entrant.registration = { ...registration };
      }
      const matches = [...data.matches].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      for (const record of matches) {
        if (record.scoring !== TOURNAMENT_SCORING_VERSION || !this.isRecoverableRecord(record)) continue;
        if (record.status === 'playing') {
          const closed: TournamentMatchRecord = { ...record, status: 'abandoned', winner: undefined, reason: 'abandoned', endedAt: iso(Date.now()) };
          try {
            await store.finishMatch(closed, []);
          } catch (error) {
            this.logger.error('[tournament] 미완료 경기를 닫지 못했습니다:', error);
          }
          continue;
        }
        this.ensureEntrant(record.blackId, record.blackName);
        this.ensureEntrant(record.whiteId, record.whiteName);
        if (record.status === 'completed' && record.winner && isInt(record.blackDelta) && isInt(record.whiteDelta)) {
          this.applyResult(record.blackId, record.whiteId, record.winner, { BLACK: record.blackDelta, WHITE: record.whiteDelta });
        }
      }
      this.dispatcher = new TournamentEventDispatcher({
        sink: this.options.onEvent,
        markDelivered: (ids, at) => store.markEventsDelivered(ids, at),
        retryMs: settings.eventRetryMs,
        logger: this.logger,
      });
      this.dispatcher.enqueue(data.events.filter((event) => event.deliveredAt === null).map(({ deliveredAt: _unused, ...event }) => event));
      await this.advanceLifecycle();
      this.lastPhase = this.phase();
      this.tickTimer = setInterval(() => this.tick(), 1_000);
      this.tickTimer.unref?.();
    }
    this.ready = true;
  }

  private loadConfiguredBotProfiles(): void {
    const ids = parseTournamentRankedBotIds(this.settings?.rankedBotIds);
    if (!ids) throw new Error('INVALID_SETTINGS');
    if (!ids.length) return;
    const source = this.options.getBotProfiles?.();
    if (!source) throw new Error('RANKED_BOT_PROFILES_UNAVAILABLE');
    const profiles = [...source];
    for (const id of ids) {
      const matches = profiles.filter((profile) => profile.playerId === id);
      const profile = matches[0];
      if (matches.length !== 1 || !profile || !isRankedBotId(profile.playerId) ||
        typeof profile.name !== 'string' || !profile.name.trim() || typeof profile.token !== 'string' ||
        !profile.token || profile.unlinkedAt || !Number.isFinite(profile.rating)) {
        throw new Error('RANKED_BOT_PROFILE_UNAVAILABLE');
      }
      this.botProfiles.set(id, structuredClone(profile));
      const entrant = this.ensureEntrant(id, profile.name);
      entrant.isBot = true;
      entrant.registration = null;
      entrant.points = 0;
      entrant.platform = 'unknown';
    }
  }

  /** Keep human-only history intact; restore bot Elo only for a configured, profile-backed human-bot record. */
  private isRecoverableRecord(record: TournamentMatchRecord): boolean {
    const blackBot = record.blackKind === 'bot';
    const whiteBot = record.whiteKind === 'bot';
    if (blackBot && whiteBot) return false;
    if (blackBot) {
      return this.botProfiles.has(record.blackId) && record.whiteKind === 'human' && !isRankedBotId(record.whiteId);
    }
    if (whiteBot) {
      return this.botProfiles.has(record.whiteId) && record.blackKind === 'human' && !isRankedBotId(record.blackId);
    }
    if (record.blackKind !== 'human' || record.whiteKind !== 'human' ||
      isRankedBotId(record.blackId) || isRankedBotId(record.whiteId)) return false;
    return true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const match of this.matches.values()) this.clearMatchTimers(match);
    // 유효 기간은 메모리에만 있다. 정상 종료 때 앱 밖 표시 종료를 알리고, 비정상 종료는 메인이 재시작 때 정리한다.
    for (const entrant of this.entrants.values()) this.endLease(entrant);
    await this.settle();
    this.dispatcher?.close();
    await this.store?.close();
  }

  /** 테스트/종료용: 진행 중인 생명주기 처리·저장·사건 전달이 끝날 때까지 기다린다 */
  async settle(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await this.lifecycleChain.catch(() => undefined);
      if (this.pendingWrites.size) await Promise.allSettled([...this.pendingWrites]);
      await this.dispatcher?.idle();
      if (!this.pendingWrites.size) return;
    }
  }

  get enabled(): boolean {
    return this.settings !== null && this.store !== null;
  }

  phase(now = Date.now()): TournamentPhase {
    const s = this.settings;
    if (!s || !this.store) return 'disabled';
    if (now < s.registrationStartsAt) return 'scheduled';
    if (now < s.registrationEndsAt) return 'recruiting';
    if (this.decisionStatus() === 'cancelled') return 'cancelled';
    if (now < s.startsAt) return 'confirmed';
    if (now < s.endsAt) return 'active';
    if (this.hasPlayingMatch() || !this.lifecycle.finalized) return 'finishing';
    return 'finished';
  }

  /** 대회 대기열·시작 준비·공식 경기 중이면 일반 매칭을 막는다 */
  isPlayerBusy(playerId: string): boolean {
    const status = this.entrants.get(playerId)?.status;
    return status === 'queued' || status === 'preparing' || status === 'countdown' || status === 'playing';
  }

  /** 대기 중 만다꼬 훈련 허용: 진행 중 대회, 연결된 사람 참가자가 대기열에 있을 때만. 점수와 무관하다 */
  canPractice(playerId: string): boolean {
    if (this.phase() !== 'active' || isRankedBotId(playerId)) return false;
    const entrant = this.entrants.get(playerId);
    return Boolean(entrant && entrant.status === 'queued' && entrant.presence === 'foreground' && this.clientsByPlayer.has(playerId));
  }

  activeHumans(): number {
    let count = 0;
    for (const entrant of this.entrants.values()) {
      if (entrant.isBot) continue;
      if (entrant.status === 'queued' || PRE_START.has(entrant.status)) count += 1;
      else if (entrant.status === 'playing' && entrant.matchId && this.matches.get(entrant.matchId)?.status === 'playing') count += 1;
      else if (entrant.status === 'result' && this.clientsByPlayer.has(entrant.playerId)) count += 1;
    }
    return count;
  }

  registrationCount(): number {
    let humans = 0;
    for (const entrant of this.entrants.values()) if (!entrant.isBot && this.isRegistered(entrant)) humans += 1;
    return humans + this.botProfiles.size;
  }

  publicStatus(): TournamentPublicStatus {
    let entrantCount = 0;
    for (const entrant of this.entrants.values()) if (!entrant.isBot && entrant.registration?.firstEnteredAt) entrantCount += 1;
    return {
      protocolVersion: TOURNAMENT_PROTOCOL_VERSION,
      config: this.configView(),
      phase: this.phase(),
      serverNow: Date.now(),
      entrantCount,
      registrationCount: this.registrationCount(),
      nextTournament: this.settings?.nextTournament ?? null,
    };
  }

  updateName(playerId: string, name: string): void {
    const entrant = this.entrants.get(playerId);
    if (!entrant || entrant.name === name) return;
    entrant.name = name;
    this.standingsCache = null;
    if (entrant.registration) {
      entrant.registration = { ...entrant.registration, name };
      this.persistRegistration(entrant, []);
    }
    this.broadcast();
  }

  /** Socket loss moves a queued player into server-owned waiting. */
  detach(client: TournamentClient, retire = true): void {
    if (retire) this.supersededClients.add(client);
    const playerId = this.playerByClient.get(client);
    if (!playerId) return;
    this.playerByClient.delete(client);
    if (this.clientsByPlayer.get(playerId) !== client) return;
    this.clientsByPlayer.delete(playerId);
    const entrant = this.entrants.get(playerId);
    if (!entrant) return;
    entrant.presenceSeq += 1;
    if (entrant.status === 'queued' || entrant.status === 'preparing') {
      this.startBackground(entrant, entrant.lease?.destination ?? null);
      this.broadcast();
      return;
    }
    if (entrant.status === 'countdown' && entrant.matchId) {
      const match = this.matches.get(entrant.matchId);
      this.markLeft(entrant, 'disconnect');
      if (match) this.cancelBeforeStart(match, new Set([playerId]));
    } else if (entrant.status === 'playing' && entrant.matchId) {
      const match = this.matches.get(entrant.matchId);
      if (match && match.status === 'playing') {
        this.startGrace(match, this.sideOf(match, playerId));
        this.sendSnapshot(this.otherPlayerId(match, playerId));
      }
    } else if (entrant.status === 'result') {
      this.markLeft(entrant, 'disconnect');
    }
  }

  async handle(client: TournamentClient, identity: TournamentIdentity | null, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return this.error(client, 'INVALID_MESSAGE');
    const message = raw as Record<string, unknown>;
    if (message.protocolVersion !== TOURNAMENT_PROTOCOL_VERSION) return this.error(client, 'UPDATE_REQUIRED');
    if (!identity) return this.error(client, 'NOT_AUTHENTICATED');
    if (this.closed) return this.error(client, 'SERVER_ERROR');
    if (this.supersededClients.has(client)) return this.error(client, 'SUPERSEDED');
    if (!this.isEligible(identity)) return this.error(client, 'NOT_ELIGIBLE');
    this.expireLeases(Date.now());
    this.bind(client, identity);
    const playerId = identity.playerId;
    switch (message.type) {
      case 'TOURNAMENT_STATUS':
        return this.sendSnapshot(playerId);
      case 'TOURNAMENT_REGISTER':
        return this.register(client, identity);
      case 'TOURNAMENT_UNREGISTER':
        return this.unregister(client, identity);
      case 'TOURNAMENT_JOIN':
        return this.join(client, identity);
      case 'TOURNAMENT_NEXT':
        return this.next(client, identity);
      case 'TOURNAMENT_PAUSE':
        return this.pause(client, playerId);
      case 'TOURNAMENT_READY':
        return this.markReady(client, playerId, message);
      case 'TOURNAMENT_PRESENCE':
        return this.updatePresence(client, identity, message);
      case 'TOURNAMENT_MOVE':
        return this.move(client, playerId, message);
      case 'TOURNAMENT_RESIGN':
        return this.resign(client, playerId, message);
      default:
        return this.error(client, 'INVALID_MESSAGE');
    }
  }

  snapshotFor(playerId: string | null): TournamentSnapshot {
    const entrant = playerId ? this.entrants.get(playerId) : undefined;
    const rows = this.standingRows();
    const views = rows.map((row) => this.standingView(row, entrant));
    const mine = entrant ? views.find((view) => view.isMe) ?? null : null;
    const registered = Boolean(entrant && this.isRegistered(entrant));
    const identity = playerId ? this.identities.get(playerId) : undefined;
    return {
      protocolVersion: TOURNAMENT_PROTOCOL_VERSION,
      config: this.configView(),
      phase: this.phase(),
      serverNow: Date.now(),
      eligible: Boolean(this.enabled && identity && this.isEligible(identity)),
      registered,
      joined: registered,
      registrationCount: this.registrationCount(),
      nextTournament: this.settings?.nextTournament ?? null,
      status: entrant?.status ?? 'idle',
      queuedAt: entrant?.status === 'queued' ? entrant.queuedAt : null,
      meId: entrant && (registered || entrant.games > 0) ? entrant.key : null,
      match: entrant ? this.matchView(entrant) : null,
      standings: views.slice(0, this.settings?.standingsLimit ?? 100),
      standingsTotal: views.length,
      myStanding: mine,
      activeHumans: this.activeHumans(),
      presence: entrant?.presence ?? 'foreground',
      background: entrant ? this.backgroundView(entrant) : null,
      pausedReason: entrant?.pausedReason ?? null,
    };
  }

  /** REST 상태 조회용 읽기 전용 요약 */
  backgroundStatus(playerId: string): TournamentBackgroundStatus | null {
    if (!this.settings) return null;
    const entrant = this.entrants.get(playerId);
    return {
      tournamentId: this.settings.id,
      status: entrant?.status ?? 'idle',
      presence: entrant?.presence ?? 'foreground',
      background: entrant ? this.backgroundView(entrant) : null,
      pausedReason: entrant?.pausedReason ?? null,
    };
  }

  /**
   * 인증된 경로의 대기 취소. 여러 번 불러도 같다. 대기·시작 전 경기만 취소하고
   * 진행 중인 인간전은 기권시키지 않는다. 실제로 대기를 멈췄으면 true.
   */
  cancelWaiting(playerId: string): boolean {
    const entrant = this.entrants.get(playerId);
    if (!entrant) return false;
    if (entrant.status === 'queued') {
      entrant.status = 'idle';
      entrant.queuedAt = null;
      entrant.pausedReason = 'cancelled';
      this.endLease(entrant);
      this.markLeft(entrant, 'pause');
      this.broadcast();
      return true;
    }
    if (PRE_START.has(entrant.status) && entrant.matchId) {
      const match = this.matches.get(entrant.matchId);
      this.markLeft(entrant, 'pause');
      if (match) this.cancelBeforeStart(match, new Set([playerId]), 'cancelled');
      return true;
    }
    if (entrant.lease) {
      this.endLease(entrant);
      this.sendSnapshot(playerId);
    }
    return false;
  }

  // ─── 앱 밖 대기 ─────────────────────────────────────────────────────────

  private hasLease(entrant: Entrant, now = Date.now()): boolean {
    const deadline = entrant.status === 'preparing' && entrant.matchId
      ? this.matches.get(entrant.matchId)?.readyDeadline : entrant.lease?.expiresAt;
    return Boolean(entrant.lease && entrant.presence === 'background' && deadline != null && deadline > now);
  }

  private canQueue(entrant: Entrant): boolean {
    return !entrant.isBot && ((entrant.presence === 'foreground' && this.clientsByPlayer.has(entrant.playerId)) || this.hasLease(entrant));
  }

  private backgroundView(entrant: Entrant): TournamentBackgroundView | null {
    const lease = entrant.lease;
    if (!lease) return null;
    if (entrant.status === 'preparing' && entrant.matchId) {
      const match = this.matches.get(entrant.matchId);
      return { state: 'matched', queuedAt: lease.queuedAt, expiresAt: match?.readyDeadline ?? lease.expiresAt, matchId: entrant.matchId };
    }
    return { state: 'waiting', queuedAt: lease.queuedAt, expiresAt: lease.expiresAt, matchId: null };
  }

  private notifyBackground(entrant: Entrant, change: Omit<TournamentBackgroundChange, 'playerId' | 'tournamentId' | 'title'>): void {
    entrant.backgroundActive = change.state !== 'ended';
    const sink = this.options.onBackgroundChange;
    const settings = this.settings;
    if (!sink || !settings) return;
    const payload: TournamentBackgroundChange = { playerId: entrant.playerId, tournamentId: settings.id, title: settings.title, ...change };
    this.backgroundChanges = this.track(this.backgroundChanges.then(() => sink(payload))
      .catch(() => { this.logger.error('[tournament] 앱 밖 대기 알림 전달 실패'); }));
  }

  /** 앱 밖 대기를 끝내고 표시 종료를 알린다. 대기열 상태는 호출한 쪽이 정한다 */
  private endLease(entrant: Entrant, force = false, notify = true): void {
    entrant.presenceSeq += 1;
    if (!entrant.lease && !entrant.backgroundActive && !force) return;
    entrant.lease = null;
    if (notify) this.notifyBackground(entrant, { state: 'ended', queuedAt: null, expiresAt: null });
  }

  private updatePresence(client: TournamentClient, identity: TournamentIdentity, message: Record<string, unknown>): void {
    const state = message.state;
    if (!isPresence(state)) return this.error(client, 'INVALID_MESSAGE');
    const destination = state === 'background' && message.destination !== undefined ? parseBackgroundDestination(message.destination) : null;
    if (state === 'background' && message.destination !== undefined && !destination) return this.error(client, 'INVALID_MESSAGE');
    if (!this.isEligible(identity)) return this.error(client, 'NOT_ELIGIBLE');
    const entrant = this.ensureEntrant(identity.playerId, identity.name);
    const existingMatch = entrant.matchId ? this.matches.get(entrant.matchId) : undefined;
    if (existingMatch?.status === 'preparing' && existingMatch.readyDeadline !== null && Date.now() >= existingMatch.readyDeadline) this.expirePreparation(existingMatch);
    if (state === 'foreground') {
      entrant.presence = 'foreground';
      this.endLease(entrant);
      return this.sendPresenceSnapshots(entrant);
    }
    this.startBackground(entrant, destination);
    this.sendPresenceSnapshots(entrant);
  }

  private startBackground(entrant: Entrant, destination: TournamentBackgroundDestination | null): void {
    const priorLease = entrant.lease;
    entrant.presence = 'background';
    if (entrant.status !== 'queued' && entrant.status !== 'preparing') return;
    const match = entrant.matchId ? this.matches.get(entrant.matchId) : undefined;
    const queuedAt = entrant.status === 'queued'
      ? entrant.queuedAt ?? Date.now()
      : (match ? this.participant(match, this.sideOf(match, entrant.playerId)).queuedAt : Date.now());
    entrant.lease = priorLease ? { ...priorLease, destination: destination ?? priorLease.destination } :
      { destination, queuedAt, expiresAt: this.settings!.endsAt };
    if (match?.status === 'preparing') {
      match.ready.delete(this.sideOf(match, entrant.playerId));
      this.armReadyTimer(match, Math.max(match.readyDeadline ?? 0, match.preparedAt + this.backgroundReadyTimeout()));
    }
    if (priorLease) return;
    if (entrant.status === 'queued') {
      this.notifyBackground(entrant, { state: 'waiting', queuedAt, expiresAt: entrant.lease.expiresAt });
    } else if (match) {
      this.notifyBackground(entrant, { state: 'matched', queuedAt, expiresAt: match.readyDeadline, matchId: match.id });
    }
  }

  private sendPresenceSnapshots(entrant: Entrant): void {
    const match = entrant.matchId ? this.matches.get(entrant.matchId) : undefined;
    if (match) this.sendMatchSnapshots(match);
    else this.sendSnapshot(entrant.playerId);
  }

  /** 대기 중 유효 기간이 끝난 앱 밖 대기자를 뺀다. 매칭 준비 중인 사람은 준비 제한 시간이 처리한다 */
  private expireLeases(now: number): void {
    let changed = false;
    for (const entrant of this.entrants.values()) {
      if (!entrant.lease || entrant.lease.expiresAt > now || entrant.status === 'preparing') continue;
      if (entrant.status === 'queued' && !(entrant.presence === 'foreground' && this.clientsByPlayer.has(entrant.playerId))) {
        entrant.status = 'idle';
        entrant.queuedAt = null;
        entrant.pausedReason = now >= this.settings!.endsAt ? 'ended' : 'background_expired';
        this.markLeft(entrant, 'background');
      }
      this.endLease(entrant);
      changed = true;
    }
    if (changed) this.broadcast();
  }

  // ─── 신청과 입장 ─────────────────────────────────────────────────────────

  private async register(client: TournamentClient, identity: TournamentIdentity): Promise<void> {
    const settings = this.settings;
    if (!settings) return this.error(client, 'DISABLED');
    if (!this.isEligible(identity)) return this.error(client, 'NOT_ELIGIBLE');
    const phase = this.phase();
    if (phase === 'scheduled') return this.error(client, 'REGISTRATION_CLOSED');
    if (phase === 'cancelled') return this.error(client, 'CANCELLED');
    if (phase === 'finishing' || phase === 'finished') return this.error(client, 'ENDED');
    const entrant = this.ensureEntrant(identity.playerId, identity.name);
    entrant.platform = identity.platform;
    if (this.isRegistered(entrant)) return this.sendSnapshot(identity.playerId);
    const previous = entrant.registration;
    const now = Date.now();
    entrant.registration = {
      playerId: entrant.playerId,
      name: entrant.name,
      registeredAt: iso(now),
      firstEnteredAt: previous?.firstEnteredAt,
      late: now >= settings.registrationEndsAt,
    };
    this.standingsCache = null;
    const events = [this.event('register', [entrant.playerId], { late: entrant.registration.late, platform: identity.platform })];
    try {
      await this.store!.saveRegistration(entrant.registration, events);
    } catch (error) {
      this.logger.error('[tournament] 참가 신청 저장 실패:', error);
      entrant.registration = previous;
      this.standingsCache = null;
      return this.error(client, 'SERVER_ERROR');
    }
    this.dispatcher?.enqueue(events);
    this.broadcast();
  }

  private async unregister(client: TournamentClient, identity: TournamentIdentity): Promise<void> {
    if (!this.settings) return this.error(client, 'DISABLED');
    const phase = this.phase();
    if (phase === 'cancelled') return this.error(client, 'CANCELLED');
    if (phase !== 'recruiting') return this.error(client, 'REGISTRATION_CLOSED');
    const entrant = this.entrants.get(identity.playerId);
    if (!entrant || !this.isRegistered(entrant)) return this.sendSnapshot(identity.playerId);
    const previous = entrant.registration!;
    entrant.registration = { ...previous, withdrawnAt: iso(Date.now()) };
    this.standingsCache = null;
    const events = [this.event('unregister', [entrant.playerId], {})];
    try {
      await this.store!.saveRegistration(entrant.registration, events);
    } catch (error) {
      this.logger.error('[tournament] 신청 취소 저장 실패:', error);
      entrant.registration = previous;
      this.standingsCache = null;
      return this.error(client, 'SERVER_ERROR');
    }
    this.dispatcher?.enqueue(events);
    this.broadcast();
  }

  private checkEntry(client: TournamentClient, identity: TournamentIdentity): boolean {
    if (!this.settings) {
      this.error(client, 'DISABLED');
      return false;
    }
    if (!this.isEligible(identity)) {
      this.error(client, 'NOT_ELIGIBLE');
      return false;
    }
    const phase = this.phase();
    if (phase === 'active') return true;
    this.error(client, phase === 'cancelled' ? 'CANCELLED' : phase === 'finishing' || phase === 'finished' ? 'ENDED' : 'NOT_STARTED');
    return false;
  }

  /** 대회 입장. 진행 중에 처음 온 사람은 그 자리에서 늦은 신청으로 기록한다 */
  private join(client: TournamentClient, identity: TournamentIdentity): void {
    const existing = this.entrants.get(identity.playerId);
    if (existing?.presence === 'background') return this.error(client, 'FOREGROUND_REQUIRED');
    if (existing?.status === 'queued') return this.sendSnapshot(identity.playerId);
    if (existing && (PRE_START.has(existing.status) || existing.status === 'playing')) return this.error(client, 'IN_MATCH');
    if (!this.checkEntry(client, identity)) return;
    if (this.options.isPlayerBusyElsewhere?.(identity.playerId)) return this.error(client, 'BUSY_ELSEWHERE');
    const entrant = this.ensureEntrant(identity.playerId, identity.name);
    entrant.platform = identity.platform;
    const events: TournamentServiceEvent[] = [];
    let changed = false;
    if (!this.isRegistered(entrant)) {
      entrant.registration = {
        playerId: entrant.playerId,
        name: entrant.name,
        registeredAt: iso(Date.now()),
        firstEnteredAt: entrant.registration?.firstEnteredAt,
        late: true,
      };
      this.standingsCache = null;
      events.push(this.event('register', [entrant.playerId], { late: true, platform: identity.platform }));
      changed = true;
    }
    if (!entrant.present) {
      const first = !entrant.registration!.firstEnteredAt;
      if (first) {
        entrant.registration = { ...entrant.registration!, firstEnteredAt: iso(Date.now()) };
        changed = true;
      }
      entrant.present = true;
      events.push(this.event(first ? 'enter' : 'reenter', [entrant.playerId], { platform: identity.platform }));
    }
    if (changed) this.persistRegistration(entrant, events);
    else this.emit(events);
    this.enqueue(entrant);
  }

  private next(client: TournamentClient, identity: TournamentIdentity): void {
    const entrant = this.entrants.get(identity.playerId);
    if (!entrant || !this.isRegistered(entrant)) return this.error(client, 'NOT_JOINED');
    if (entrant.presence === 'background') return this.error(client, 'FOREGROUND_REQUIRED');
    if (PRE_START.has(entrant.status) || entrant.status === 'playing') return this.error(client, 'IN_MATCH');
    if (entrant.status === 'queued') return this.sendSnapshot(identity.playerId);
    if (this.phase() !== 'active') {
      this.leaveResult(entrant);
      this.sendSnapshot(identity.playerId);
      return;
    }
    if (!this.checkEntry(client, identity)) return;
    if (this.options.isPlayerBusyElsewhere?.(identity.playerId)) return this.error(client, 'BUSY_ELSEWHERE');
    if (!entrant.present) {
      entrant.present = true;
      this.emit([this.event('reenter', [entrant.playerId], { platform: identity.platform })]);
    }
    this.enqueue(entrant);
  }

  private pause(client: TournamentClient, playerId: string): void {
    const entrant = this.entrants.get(playerId);
    if (!entrant || (!this.isRegistered(entrant) && !entrant.matchId)) return this.error(client, 'NOT_JOINED');
    if (entrant.status === 'playing') return this.error(client, 'IN_MATCH');
    if (this.cancelWaiting(playerId)) return;
    this.markLeft(entrant, 'pause');
    this.leaveResult(entrant);
    entrant.status = 'idle';
    entrant.queuedAt = null;
    entrant.pausedReason = 'cancelled';
    this.endLease(entrant);
    this.broadcast();
  }

  private markLeft(entrant: Entrant, reason: 'pause' | 'disconnect' | 'not_ready' | 'ended' | 'background'): void {
    if (!entrant.present) return;
    entrant.present = false;
    if (reason !== 'ended') this.emit([this.event('leave', [entrant.playerId], { reason })]);
  }

  // ─── 매칭과 시작 준비 ───────────────────────────────────────────────────

  private enqueue(entrant: Entrant, queuedAt = Date.now()): void {
    this.leaveResult(entrant);
    entrant.status = 'queued';
    entrant.queuedAt = queuedAt;
    entrant.pausedReason = null;
    this.tryPair();
    this.broadcast();
  }

  /** 주기 점검: 생명주기 전이, 단계 변화 알림, 대기자 매칭 */
  tick(): void {
    if (this.closed) return;
    this.expireLeases(Date.now());
    const phase = this.phase();
    if (phase !== this.lastPhase) this.onPhaseChange(phase);
    else if (phase === 'active' && this.tryPair()) this.broadcast();
    void this.advanceLifecycle();
  }

  /** 사람끼리 우선 매칭하고, 혼자 waitMs 이상 기다린 사람에게만 유휴 공식 봇을 붙인다. */
  private tryPair(): boolean {
    if (!this.settings || this.phase() !== 'active') return false;
    this.expireLeases(Date.now());
    let changed = false;
    const queued = () => [...this.entrants.values()]
      .filter((entrant) => entrant.status === 'queued' && this.canQueue(entrant))
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || a.playerId.localeCompare(b.playerId));
    let waiting = queued();
    while (waiting.length >= 2) {
      const first = waiting[0]!;
      const others = waiting.slice(1);
      const second = others.find((candidate) => candidate.playerId !== first.lastOpponentId && candidate.lastOpponentId !== first.playerId) ?? others[0]!;
      this.createMatch(first, second);
      changed = true;
      waiting = queued();
    }
    const loneHuman = waiting[0];
    if (loneHuman && Date.now() - (loneHuman.queuedAt ?? Date.now()) >= this.settings.waitMs) {
      const profile = this.selectAvailableBot(loneHuman);
      const botEntrant = profile ? this.entrants.get(profile.playerId) : undefined;
      if (profile && botEntrant?.status === 'idle' && !botEntrant.matchId) {
        this.createMatch(loneHuman, botEntrant, createRankedBot(profile, this.random));
        changed = true;
      }
    }
    return changed;
  }

  private selectAvailableBot(human: Entrant): StoredProfile | null {
    let available = [...this.botProfiles.values()].filter((profile) =>
      !this.reservedBotIds.has(profile.playerId),
    );
    if (!available.length) return null;
    if (human.lastOpponentId) {
      const alternatives = available.filter((profile) => profile.playerId !== human.lastOpponentId);
      if (alternatives.length) available = alternatives;
    }
    return selectRankedBot(available, 1200, { random: this.random });
  }

  private createMatch(first: Entrant, second: Entrant, botEngine: OfficialBot | null = null): void {
    const firstIsBlack = this.random() < 0.5;
    const blackEntrant = firstIsBlack ? first : second;
    const whiteEntrant = firstIsBlack ? second : first;
    const now = Date.now();
    const side = (entrant: Entrant): Side => ({
      playerId: entrant.playerId,
      name: entrant.isBot ? `${entrant.name} (봇)` : entrant.name,
      platform: entrant.platform,
      isBot: entrant.isBot,
      queuedAt: entrant.queuedAt ?? now,
      matchNumber: null,
    });
    const match: LiveMatch = {
      id: randomBytes(12).toString('hex'),
      black: side(blackEntrant),
      white: side(whiteEntrant),
      state: initialState(this.ruleConfig),
      status: 'preparing',
      ready: new Set(),
      readyTimer: null,
      botTimer: null,
      readyDeadline: null,
      preparedAt: now,
      startsAt: null,
      startTimer: null,
      finishing: false,
      startedAt: null,
      turnDeadline: null,
      turnTimer: null,
      graceTimers: new Map(),
      startPersist: Promise.resolve(),
      ratingsBefore: null,
      deltas: null,
      botEngine,
      winner: null,
      reason: null,
      finishedAt: null,
    };
    this.matches.set(match.id, match);
    for (const entrant of [first, second]) {
      entrant.status = 'preparing';
      entrant.queuedAt = null;
      entrant.matchId = match.id;
    }
    if (botEngine) {
      const botEntrant = first.isBot ? first : second;
      const botSide = botEntrant.playerId === match.black.playerId ? 'BLACK' : 'WHITE';
      botEngine.side = botSide;
      match.ready.add(botSide);
      this.reservedBotIds.add(botEntrant.playerId);
    }
    first.lastOpponentId = second.playerId;
    second.lastOpponentId = first.playerId;
    const background = [first, second].some(e => !e.isBot && e.presence === 'background');
    this.armReadyTimer(match, now + (background ? this.backgroundReadyTimeout() : this.settings!.readyTimeoutMs));
    for (const entrant of [first, second]) {
      if (!entrant.isBot) this.notifyBackground(entrant, { state: 'matched', queuedAt: entrant.lease?.queuedAt ??
        (entrant.playerId === match.black.playerId ? match.black.queuedAt : match.white.queuedAt), expiresAt: match.readyDeadline, matchId: match.id });
    }
    const waitedMs = Object.fromEntries([match.black, match.white].filter((participant) => !participant.isBot)
      .map((participant) => [participant.playerId, now - participant.queuedAt]));
    this.emit([this.event('match_found', this.humanPlayerIds(match), {
      matchId: match.id,
      blackId: match.black.playerId,
      whiteId: match.white.playerId,
      blackKind: match.black.isBot ? 'bot' : 'human',
      whiteKind: match.white.isBot ? 'bot' : 'human',
      waitedMs,
      blackPlatform: match.black.platform,
      whitePlatform: match.white.platform,
      blackWaitMs: match.black.isBot ? null : now - match.black.queuedAt,
      whiteWaitMs: match.white.isBot ? null : now - match.white.queuedAt,
    }, 'match_found:' + match.id)]);
  }

  private backgroundReadyTimeout(): number {
    return Math.max(this.settings!.readyTimeoutMs, this.settings!.backgroundReadyTimeoutMs);
  }

  private armReadyTimer(match: LiveMatch, deadline: number): void {
    if (match.readyTimer) clearTimeout(match.readyTimer);
    match.readyDeadline = deadline;
    match.readyTimer = setTimeout(() => {
      match.readyTimer = null;
      this.expirePreparation(match);
    }, Math.max(0, deadline - Date.now()));
  }

  private expirePreparation(match: LiveMatch): void {
    if (match.status !== 'preparing') return;
    const absent = new Set<string>();
    for (const side of ['BLACK', 'WHITE'] as const) {
      const entrant = this.entrants.get(this.participant(match, side).playerId)!;
      if (entrant.isBot) continue;
      if (match.ready.has(side) && entrant.presence === 'foreground' && this.clientsByPlayer.has(entrant.playerId)) continue;
      absent.add(entrant.playerId);
      this.markLeft(entrant, 'not_ready');
    }
    this.cancelBeforeStart(match, absent, 'not_ready');
  }

  private markReady(client: TournamentClient, playerId: string, message: Record<string, unknown>): void {
    const matchId = typeof message.matchId === 'string' ? message.matchId : null;
    if (!matchId) return this.error(client, 'INVALID_MESSAGE');
    const match = this.matches.get(matchId);
    if (!match || (match.black.playerId !== playerId && match.white.playerId !== playerId)) return this.error(client, 'NO_MATCH');
    if (match.status === 'finished') return this.error(client, 'MATCH_FINISHED');
    const entrant = this.entrants.get(playerId);
    if (entrant?.presence !== 'foreground' || this.clientsByPlayer.get(playerId) !== client) return this.error(client, 'FOREGROUND_REQUIRED');
    if (match.status !== 'preparing') return this.sendSnapshot(playerId);
    if (match.readyDeadline !== null && Date.now() >= match.readyDeadline) {
      this.expirePreparation(match);
      return this.error(client, 'NO_MATCH');
    }
    match.ready.add(this.sideOf(match, playerId));
    if (match.ready.size < 2) return this.sendMatchSnapshots(match);
    if (match.readyTimer) clearTimeout(match.readyTimer);
    match.readyTimer = null;
    match.readyDeadline = null;
    const countdown = this.settings!.matchCountdownMs;
    match.status = 'countdown';
    match.startsAt = Date.now() + countdown;
    for (const participant of [match.black, match.white]) {
      const entrant = this.entrants.get(participant.playerId);
      if (entrant?.matchId === match.id) entrant.status = 'countdown';
    }
    match.startTimer = setTimeout(() => {
      match.startTimer = null;
      this.beginPlay(match);
    }, countdown);
    this.sendMatchSnapshots(match);
  }

  /** 카운트다운이 끝나면 양쪽 연결과 종료 시각을 다시 확인한 뒤 착수 시계를 시작한다 */
  private beginPlay(match: LiveMatch): void {
    if (match.status !== 'countdown' || this.closed) return;
    const settings = this.settings!;
    const now = Date.now();
    if (this.phase(now) !== 'active' || now >= settings.endsAt) {
      return this.cancelBeforeStart(match, new Set([match.black.playerId, match.white.playerId]));
    }
    const absent = new Set([match.black, match.white].filter((side) => {
      const entrant = this.entrants.get(side.playerId);
      return !entrant || (!entrant.isBot && (!this.clientsByPlayer.has(side.playerId) || entrant.presence !== 'foreground'));
    }).map((side) => side.playerId));
    if (absent.size) return this.cancelBeforeStart(match, absent);
    const black = this.entrants.get(match.black.playerId)!;
    const white = this.entrants.get(match.white.playerId)!;
    match.status = 'playing';
    match.startedAt = now;
    match.ratingsBefore = { BLACK: black.points, WHITE: white.points };
    match.black.matchNumber = black.games + 1;
    match.white.matchNumber = white.games + 1;
    black.status = 'playing';
    white.status = 'playing';
    this.endLease(black);
    this.endLease(white);
    this.resetTurnTimer(match);
    const events = [this.event('match_started', this.humanPlayerIds(match), {
      matchId: match.id,
      blackId: black.playerId,
      whiteId: white.playerId,
      blackKind: match.black.isBot ? 'bot' : 'human',
      whiteKind: match.white.isBot ? 'bot' : 'human',
      blackPlatform: match.black.platform,
      whitePlatform: match.white.platform,
    }, 'match_started:' + match.id)];
    match.startPersist = this.track(this.store!.startMatch(this.record(match, 'playing'), events)
      .then(() => this.dispatcher?.enqueue(events))
      .catch((error) => this.logger.error('[tournament] 경기 시작 기록 실패:', error)));
    this.sendMatchSnapshots(match);
    this.scheduleBotMove(match);
  }

  /**
   * 시작 전 경기 취소. 점수·경기 기록 없음. absent에 없는 연결된 사람은 원래 대기 순서로 돌아가고,
   * 빠진 사람은 벌점 없이 idle이 된다.
   */
  private cancelBeforeStart(match: LiveMatch, absent: Set<string>, reason: TournamentPauseReason = 'not_ready'): void {
    if (match.status !== 'preparing' && match.status !== 'countdown') return;
    if (match.readyTimer) clearTimeout(match.readyTimer);
    if (match.startTimer) clearTimeout(match.startTimer);
    match.readyTimer = null;
    match.startTimer = null;
    match.readyDeadline = null;
    match.status = 'finished';
    if (match.botEngine?.playerId) this.reservedBotIds.delete(match.botEngine.playerId);
    this.matches.delete(match.id);
    const active = this.phase() === 'active';
    for (const side of [match.black, match.white]) {
      const entrant = this.entrants.get(side.playerId);
      if (!entrant || entrant.matchId !== match.id) continue;
      entrant.matchId = null;
      // A preparation deadline ends every background lease. Only an actually ready,
      // connected foreground participant is returned by expirePreparation.
      if (!entrant.isBot && active && !absent.has(side.playerId) && this.canQueue(entrant)) {
        entrant.status = 'queued';
        entrant.queuedAt = side.queuedAt;
        entrant.lastOpponentId = null;
        entrant.pausedReason = null;
        this.notifyBackground(entrant, { state: 'waiting', queuedAt: side.queuedAt,
          expiresAt: entrant.lease?.expiresAt ?? this.settings!.endsAt });
      } else {
        entrant.status = 'idle';
        entrant.queuedAt = null;
        entrant.pausedReason = active ? reason : 'ended';
        this.endLease(entrant);
      }
    }
    this.tryPair();
    this.broadcast();
  }

  // ─── 경기 진행 ───────────────────────────────────────────────────────────

  private move(client: TournamentClient, playerId: string, message: Record<string, unknown>): void {
    const matchId = typeof message.matchId === 'string' ? message.matchId : null;
    const move = parseTournamentMove(message.move);
    if (!matchId || !move || !isInt(message.ply)) return this.error(client, 'INVALID_MESSAGE');
    const located = this.locateOwnMatch(client, playerId, matchId);
    if (!located) return;
    const { match, side } = located;
    if (match.state.turn !== side) return this.error(client, 'NOT_YOUR_TURN');
    if (message.ply !== match.state.history.length) return this.error(client, 'STALE_MOVE');
    const legal = legalMoves(match.state, this.ruleConfig).find((candidate) => sameMove(candidate, move));
    if (!legal) return this.error(client, 'ILLEGAL_MOVE');
    this.applyMatchMove(match, legal);
  }

  private resign(client: TournamentClient, playerId: string, message: Record<string, unknown>): void {
    const matchId = typeof message.matchId === 'string' ? message.matchId : null;
    if (!matchId) return this.error(client, 'INVALID_MESSAGE');
    const located = this.locateOwnMatch(client, playerId, matchId);
    if (!located) return;
    void this.finishMatch(located.match, opponent(located.side), 'resign');
  }

  private locateOwnMatch(client: TournamentClient, playerId: string, matchId: string): { match: LiveMatch; side: Player } | null {
    const match = this.matches.get(matchId);
    if (!match || (match.black.playerId !== playerId && match.white.playerId !== playerId)) {
      this.error(client, 'NO_MATCH');
      return null;
    }
    if (match.status === 'preparing' || match.status === 'countdown') {
      this.error(client, 'NOT_READY');
      return null;
    }
    if (match.status !== 'playing' || match.finishing) {
      this.error(client, 'MATCH_FINISHED');
      return null;
    }
    // 타이머 콜백보다 늦은 요청이 먼저 처리되어도 마감이 지난 차례는 시간 초과로 끝낸다.
    if (match.turnDeadline !== null && Date.now() >= match.turnDeadline) {
      void this.finishMatch(match, opponent(match.state.turn), 'timeout');
      this.error(client, 'MATCH_FINISHED');
      return null;
    }
    return { match, side: this.sideOf(match, playerId) };
  }

  private applyMatchMove(match: LiveMatch, move: Move): void {
    match.state = applyMove(match.state, move);
    const result = getResult(match.state, this.ruleConfig);
    if (result) {
      void this.finishMatch(match, result.winner, result.reason);
      return;
    }
    this.resetTurnTimer(match);
    this.sendMatchSnapshots(match);
    this.scheduleBotMove(match);
  }

  private resetTurnTimer(match: LiveMatch): void {
    if (match.turnTimer) clearTimeout(match.turnTimer);
    const moveTimeMs = this.settings!.moveTimeMs;
    match.turnDeadline = Date.now() + moveTimeMs;
    const ply = match.state.history.length;
    match.turnTimer = setTimeout(() => {
      if (match.status !== 'playing' || match.finishing || match.state.history.length !== ply) return;
      const current = this.entrants.get(this.participant(match, match.state.turn).playerId);
      if (current?.isBot) void this.finishMatch(match, null, 'abandoned');
      else void this.finishMatch(match, opponent(match.state.turn), 'timeout');
    }, moveTimeMs);
  }

  private scheduleBotMove(match: LiveMatch): void {
    const bot = match.botEngine;
    if (!bot || match.status !== 'playing' || match.finishing || match.state.turn !== bot.side) return;
    if (match.botTimer) clearTimeout(match.botTimer);
    const ply = match.state.history.length;
    const turn = match.state.turn;
    match.botTimer = setTimeout(() => {
      match.botTimer = null;
      if (this.matches.get(match.id) !== match || match.status !== 'playing' || match.finishing ||
        match.state.history.length !== ply || match.state.turn !== turn || turn !== bot.side) return;
      if (match.turnDeadline !== null && Date.now() >= match.turnDeadline) {
        void this.finishMatch(match, null, 'abandoned');
        return;
      }
      try {
        const move = chooseOfficialBotMove(bot, match.state, this.ruleConfig);
        if (!move || this.matches.get(match.id) !== match || match.status !== 'playing' || match.finishing ||
          match.state.history.length !== ply || match.state.turn !== turn) {
          if (!move) void this.finishMatch(match, null, 'abandoned');
          return;
        }
        const legal = legalMoves(match.state, this.ruleConfig).find((candidate) => sameMove(candidate, move));
        if (!legal) {
          void this.finishMatch(match, null, 'abandoned');
          return;
        }
        this.applyMatchMove(match, legal);
      } catch (error) {
        this.logger.error('[tournament] 공식 봇 착수 실패:', error);
        void this.finishMatch(match, null, 'abandoned');
      }
    }, officialBotMoveDelayMs(bot));
    match.botTimer.unref?.();
  }

  private startGrace(match: LiveMatch, side: Player): void {
    if (match.graceTimers.has(side) || match.status !== 'playing') return;
    const timer = setTimeout(() => {
      match.graceTimers.delete(side);
      const participant = this.participant(match, side);
      if (match.status !== 'playing' || match.finishing || this.clientsByPlayer.has(participant.playerId)) return;
      void this.finishMatch(match, opponent(side), 'disconnect');
    }, this.settings!.reconnectGraceMs);
    match.graceTimers.set(side, timer);
  }

  private clearMatchTimers(match: LiveMatch): void {
    for (const timer of [match.turnTimer, match.readyTimer, match.startTimer, match.botTimer]) if (timer) clearTimeout(timer);
    for (const timer of match.graceTimers.values()) clearTimeout(timer);
    match.turnTimer = null;
    match.readyTimer = null;
    match.startTimer = null;
    match.botTimer = null;
    match.graceTimers.clear();
  }

  /**
   * 한 경기의 결과는 한 번만 반영된다. 변화량은 시작 시점 점수로 계산해 경기 기록과 함께 저장하고,
   * 저장이 확인된 뒤에만 메모리 점수에 더한다. 저장에 실패하면 점수 없이 끝낸다.
   */
  private finishMatch(match: LiveMatch, winner: Player | null, reason: TournamentEndReason): Promise<void> {
    return this.track(this.completeMatch(match, winner, reason));
  }

  private async completeMatch(match: LiveMatch, winner: Player | null, reason: TournamentEndReason): Promise<void> {
    if (match.status !== 'playing' || match.finishing) return;
    match.finishing = true;
    this.clearMatchTimers(match);
    match.turnDeadline = null;
    const endedAt = Date.now();
    const settings = this.settings!;
    let deltas: Record<Player, number> | null = null;
    if (winner && match.ratingsBefore) {
      const loser = opponent(winner);
      const delta = eloDelta(match.ratingsBefore[winner], match.ratingsBefore[loser], { k: settings.eloK, scale: settings.eloScale });
      deltas = winner === 'BLACK' ? { BLACK: delta, WHITE: -delta } : { BLACK: -delta, WHITE: delta };
    }
    const status = winner && deltas ? 'completed' : 'abandoned';
    const record = this.record(match, status, winner, reason, endedAt, deltas);
    const events = [this.event('match_complete', this.humanPlayerIds(match), {
      matchId: match.id,
      blackId: match.black.playerId,
      whiteId: match.white.playerId,
      blackKind: match.black.isBot ? 'bot' : 'human',
      whiteKind: match.white.isBot ? 'bot' : 'human',
      status,
      reason,
      winnerId: winner ? this.participant(match, winner).playerId : null,
      blackPlatform: match.black.platform,
      whitePlatform: match.white.platform,
      blackRatingBefore: record.blackRatingBefore ?? null,
      whiteRatingBefore: record.whiteRatingBefore ?? null,
      blackDelta: record.blackDelta ?? 0,
      whiteDelta: record.whiteDelta ?? 0,
      blackRatingAfter: record.blackRatingAfter ?? null,
      whiteRatingAfter: record.whiteRatingAfter ?? null,
    }, 'match_complete:' + match.id)];
    let recorded = false;
    try {
      await match.startPersist;
      recorded = await this.store!.finishMatch(record, events);
    } catch (error) {
      this.logger.error('[tournament] 경기 결과 저장 실패:', error);
    }
    match.status = 'finished';
    match.finishedAt = endedAt;
    if (recorded) {
      this.dispatcher?.enqueue(events);
      match.winner = winner;
      match.reason = reason;
      if (winner && deltas) {
        match.deltas = deltas;
        this.applyResult(match.black.playerId, match.white.playerId, winner, deltas);
      }
    } else {
      match.winner = null;
      match.reason = 'store-error';
    }
    for (const participant of [match.black, match.white]) {
      const entrant = this.entrants.get(participant.playerId);
      if (entrant?.matchId === match.id) {
        if (entrant.isBot) {
          entrant.status = 'idle';
          entrant.matchId = null;
        } else entrant.status = 'result';
      }
    }
    if (match.botEngine?.playerId) this.reservedBotIds.delete(match.botEngine.playerId);
    this.pruneMatch(match);
    const phase = this.phase();
    if (phase !== this.lastPhase) this.onPhaseChange(phase);
    else {
      if (phase === 'active') this.tryPair();
      this.broadcast();
    }
    void this.advanceLifecycle();
  }

  private applyResult(blackId: string, whiteId: string, winner: Player, deltas: Record<Player, number>): void {
    const black = this.entrants.get(blackId)!;
    const white = this.entrants.get(whiteId)!;
    const won = winner === 'BLACK' ? black : white;
    const lost = winner === 'BLACK' ? white : black;
    black.points += deltas.BLACK;
    white.points += deltas.WHITE;
    won.wins += 1;
    lost.losses += 1;
    black.games += 1;
    white.games += 1;
    if (!black.isBot && !white.isBot) this.headToHead.push({ winnerId: won.playerId, loserId: lost.playerId });
    this.standingsCache = null;
  }

  private record(
    match: LiveMatch,
    status: TournamentMatchRecord['status'],
    winner: Player | null = null,
    reason?: TournamentEndReason,
    endedAt?: number,
    deltas: Record<Player, number> | null = null,
  ): TournamentMatchRecord {
    const before = match.ratingsBefore;
    return {
      matchId: match.id,
      blackId: match.black.playerId,
      whiteId: match.white.playerId,
      blackKind: match.black.isBot ? 'bot' : 'human',
      whiteKind: match.white.isBot ? 'bot' : 'human',
      blackName: match.black.name,
      whiteName: match.white.name,
      status,
      winner: winner ?? undefined,
      reason,
      startedAt: iso(match.startedAt ?? Date.now()),
      endedAt: endedAt ? iso(endedAt) : undefined,
      moves: status === 'playing' ? undefined : match.state.history,
      scoring: TOURNAMENT_SCORING_VERSION,
      blackRatingBefore: before?.BLACK,
      whiteRatingBefore: before?.WHITE,
      blackDelta: deltas?.BLACK,
      whiteDelta: deltas?.WHITE,
      blackRatingAfter: before && deltas ? before.BLACK + deltas.BLACK : undefined,
      whiteRatingAfter: before && deltas ? before.WHITE + deltas.WHITE : undefined,
      blackPlatform: match.black.platform,
      whitePlatform: match.white.platform,
    };
  }

  /** 결과 화면에서 벗어나면 참조가 끊긴 경기 메모리를 정리한다 */
  private leaveResult(entrant: Entrant): void {
    if (entrant.status !== 'result' || !entrant.matchId) return;
    const match = this.matches.get(entrant.matchId);
    entrant.matchId = null;
    entrant.status = 'idle';
    if (match) this.pruneMatch(match);
  }

  private pruneMatch(match: LiveMatch): void {
    if (match.status !== 'finished') return;
    const referenced = [match.black, match.white].some((participant) => this.entrants.get(participant.playerId)?.matchId === match.id);
    if (!referenced) this.matches.delete(match.id);
  }

  private hasPlayingMatch(): boolean {
    for (const match of this.matches.values()) if (match.status === 'playing') return true;
    return false;
  }

  // ─── 생명주기 ────────────────────────────────────────────────────────────

  private isRegistered(entrant: Entrant): boolean {
    return !entrant.isBot && Boolean(entrant.registration && !entrant.registration.withdrawnAt);
  }

  /** 모집 마감 전에 신청하고 철회하지 않은 사람 수. 마감 뒤 늦은 신청은 개최 판단에 넣지 않는다 */
  private decisionCount(): number {
    const deadline = this.settings!.registrationEndsAt;
    let count = this.botProfiles.size;
    for (const entrant of this.entrants.values()) {
      if (!entrant.isBot && this.isRegistered(entrant) && Date.parse(entrant.registration!.registeredAt) < deadline) count += 1;
    }
    return count;
  }

  private humanPlayerIds(match: LiveMatch): string[] {
    return [match.black, match.white].filter((side) => !side.isBot).map((side) => side.playerId);
  }

  private decisionStatus(): 'confirmed' | 'cancelled' | null {
    if (this.lifecycle.decision) return this.lifecycle.decision.status;
    if (!this.settings || Date.now() < this.settings.registrationEndsAt) return null;
    return this.decisionCount() >= this.settings.minimumParticipants ? 'confirmed' : 'cancelled';
  }

  private registrantIds(): string[] {
    return [...this.entrants.values()].filter((entrant) => !entrant.isBot && this.isRegistered(entrant)).map((entrant) => entrant.playerId).sort();
  }

  private advanceLifecycle(): Promise<void> {
    this.lifecycleChain = this.lifecycleChain
      .then(() => this.runLifecycle())
      .catch((error) => this.logger.error('[tournament] 대회 상태 전이 실패:', error));
    return this.lifecycleChain;
  }

  private async runLifecycle(): Promise<void> {
    const settings = this.settings;
    const store = this.store;
    if (!settings || !store || this.closed) return;
    const now = Date.now();
    if (!this.lifecycle.decision && now >= settings.registrationEndsAt) {
      const registrationCount = this.decisionCount();
      const status = registrationCount >= settings.minimumParticipants ? 'confirmed' : 'cancelled';
      const decision = { status, decidedAt: iso(now), registrationCount } as const;
      const humanRegistrationCount = registrationCount - this.botProfiles.size;
      const data: Record<string, unknown> = {
        registrationCount,
        humanRegistrationCount,
        botCount: this.botProfiles.size,
        minimumParticipants: settings.minimumParticipants,
        startsAt: settings.startsAt,
        endsAt: settings.endsAt,
      };
      if (status === 'cancelled' && settings.nextTournament) data.nextTournament = { ...settings.nextTournament };
      const events = [this.event(status, this.registrantIds(), data, 'decision')];
      if (await store.setLifecycle('decision', decision, events)) {
        this.lifecycle.decision = decision;
        this.dispatcher?.enqueue(events);
        this.broadcast();
      }
    }
    if (this.lifecycle.decision?.status !== 'confirmed') return;
    const lead = settings.reminderLeadMs;
    // 확정 알림 자체가 시작 1시간 이내라면 따로 알리지 않는다.
    if (
      lead > 0 && !this.lifecycle.reminderAt &&
      settings.registrationEndsAt < settings.startsAt - lead &&
      now >= settings.startsAt - lead && now < settings.startsAt
    ) {
      const events = [this.event('reminder', this.registrantIds(), { startsAt: settings.startsAt, endsAt: settings.endsAt }, 'reminder')];
      if (await store.setLifecycle('reminderAt', iso(now), events)) {
        this.lifecycle.reminderAt = iso(now);
        this.dispatcher?.enqueue(events);
      }
    }
    if (!this.lifecycle.startedAt && now >= settings.startsAt && now < settings.endsAt) {
      const events = [this.event('started', this.registrantIds(), { startsAt: settings.startsAt, endsAt: settings.endsAt }, 'started')];
      if (await store.setLifecycle('startedAt', iso(now), events)) {
        this.lifecycle.startedAt = iso(now);
        this.dispatcher?.enqueue(events);
      }
    }
    if (!this.lifecycle.finalized && now >= settings.endsAt && !this.hasPlayingMatch()) await this.finalize();
  }

  /** 최종 순위와 우승자(공동 포함)를 한 번만 확정한다. 자격자가 없으면 우승자도 없다 */
  private async finalize(): Promise<void> {
    const settings = this.settings!;
    const rows = this.standingRows();
    const champions = rows.filter((row) => row.rank === 1).map((row) => ({
      playerId: row.entrant.playerId,
      name: row.entrant.name,
      points: row.entrant.points,
      title: settings.championTitle,
    }));
    const record: TournamentFinalRecord = {
      finalizedAt: iso(Date.now()),
      standings: rows.map((row) => ({
        playerId: row.entrant.playerId,
        name: row.entrant.name,
        points: row.entrant.points,
        wins: row.entrant.wins,
        losses: row.entrant.losses,
        games: row.entrant.games,
        rank: row.rank,
      })),
      champions,
    };
    const participants = rows.filter((row) => !row.entrant.isBot).map((row) => row.entrant.playerId).sort();
    const events = [
      this.event('finished', participants, {
        championPlayerIds: champions.map((champion) => champion.playerId),
        qualifiedCount: rows.filter((row) => row.qualified).length,
        standingsTotal: rows.length,
        isInaugural: settings.isInaugural,
      }, 'finished'),
      ...champions.map((champion) => this.event('champion', [champion.playerId], {
        championTitle: champion.title,
        points: champion.points,
        shared: champions.length > 1,
        isInaugural: settings.isInaugural,
      }, 'champion:' + champion.playerId)),
    ];
    if (await this.store!.setLifecycle('finalized', record, events)) {
      this.lifecycle.finalized = record;
      this.dispatcher?.enqueue(events);
      this.standingsCache = null;
      this.lastPhase = this.phase();
      this.broadcast();
    }
  }

  private onPhaseChange(phase: TournamentPhase): void {
    this.lastPhase = phase;
    if (phase !== 'active') {
      for (const match of [...this.matches.values()]) {
        if (match.status === 'preparing' || match.status === 'countdown') {
          this.cancelBeforeStart(match, new Set([match.black.playerId, match.white.playerId]));
        }
      }
      for (const entrant of this.entrants.values()) {
        if (entrant.status === 'queued') {
          entrant.status = 'idle';
          entrant.queuedAt = null;
          entrant.pausedReason = 'ended';
          this.endLease(entrant);
          this.markLeft(entrant, 'ended');
        }
      }
    } else {
      this.tryPair();
    }
    this.broadcast();
  }

  /** 점수 규칙은 처음 저장된 값으로 고정한다. 재시작 때 환경 변수가 바뀌어도 기존 점수가 흔들리지 않는다 */
  private lockScoring(stored: Record<string, unknown> | null): void {
    const settings = this.settings!;
    if (!stored) return;
    for (const key of ['startingScore', 'eloK', 'eloScale'] as const) {
      const value = stored[key];
      if (typeof value === 'number' && value !== settings[key]) {
        this.logger.warn('[tournament] 저장된 점수 규칙을 유지합니다: ' + key);
        settings[key] = value;
      }
    }
  }

  // ─── 사건 ────────────────────────────────────────────────────────────────

  private event(kind: TournamentEventKind, playerIds: string[], data: Record<string, unknown>, suffix?: string): TournamentServiceEvent {
    const settings = this.settings!;
    return {
      id: tournamentEventId(settings.id, kind, suffix),
      tournamentId: settings.id,
      title: settings.title,
      kind,
      occurredAt: Date.now(),
      playerIds,
      data,
    };
  }

  /** 지표 사건: 저장 후 전달. 저장 실패는 대국 진행을 막지 않는다 */
  private emit(events: TournamentServiceEvent[]): void {
    if (!events.length || !this.store) return;
    this.track(this.store.appendEvents(events)
      .then(() => this.dispatcher?.enqueue(events))
      .catch((error) => this.logger.error('[tournament] 사건 저장 실패:', error)));
  }

  private persistRegistration(entrant: Entrant, events: TournamentServiceEvent[]): void {
    if (!entrant.registration || !this.store) return;
    this.track(this.store.saveRegistration({ ...entrant.registration }, events)
      .then(() => this.dispatcher?.enqueue(events))
      .catch((error) => this.logger.error('[tournament] 참가 기록 저장 실패:', error)));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pendingWrites.add(promise);
    void promise.finally(() => this.pendingWrites.delete(promise));
    return promise;
  }

  // ─── 스냅샷 ──────────────────────────────────────────────────────────────

  private configView(): TournamentConfigView | null {
    const s = this.settings;
    if (!s || !this.store) return null;
    return {
      id: s.id,
      title: s.title,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      registrationStartsAt: s.registrationStartsAt,
      registrationEndsAt: s.registrationEndsAt,
      minimumParticipants: s.minimumParticipants,
      minimumRankedMatches: s.minimumRankedMatches,
      startingScore: s.startingScore,
      eloK: s.eloK,
      eloScale: s.eloScale,
      matchCountdownMs: s.matchCountdownMs,
      moveTimeMs: s.moveTimeMs,
      reconnectGraceMs: s.reconnectGraceMs,
      isInaugural: s.isInaugural,
      rewardDescription: s.rewardDescription,
      resultCountdownMs: s.resultCountdownMs,
      waitMs: s.waitMs,
      backgroundLeaseMs: s.backgroundLeaseMs,
      backgroundReadyTimeoutMs: s.backgroundReadyTimeoutMs,
      ...(this.botProfiles.size ? { botCount: this.botProfiles.size } : {}),
    };
  }

  /** 자격자는 공식 순위 순(공동 순위는 이름순 표시), 미자격자는 점수·경기 수 순으로 뒤에 둔다 */
  private standingRows(): StandingRow[] {
    if (this.standingsCache) return this.standingsCache;
    const settings = this.settings;
    if (!settings) return (this.standingsCache = []);
    const pool = [...this.entrants.values()].filter((entrant) => !entrant.isBot && (this.isRegistered(entrant) || entrant.games > 0));
    const ranks = rankEntrants(
      pool.map((entrant) => ({ id: entrant.playerId, points: entrant.points, wins: entrant.wins, games: entrant.games })),
      this.headToHead,
      settings.minimumRankedMatches,
    );
    const rows = pool.map((entrant) => {
      const rank = ranks.get(entrant.playerId) ?? null;
      return { entrant, rank, qualified: rank !== null };
    });
    rows.sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank || a.entrant.name.localeCompare(b.entrant.name, 'ko') || a.entrant.key.localeCompare(b.entrant.key);
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return b.entrant.points - a.entrant.points || b.entrant.games - a.entrant.games
        || a.entrant.name.localeCompare(b.entrant.name, 'ko') || a.entrant.key.localeCompare(b.entrant.key);
    });
    return (this.standingsCache = rows);
  }

  private standingView(row: StandingRow, me: Entrant | undefined): TournamentStandingView {
    const { entrant } = row;
    const champion = this.lifecycle.finalized?.champions.find((candidate) => candidate.playerId === entrant.playerId);
    return {
      entrantKey: entrant.key,
      name: entrant.name,
      points: entrant.points,
      wins: entrant.wins,
      losses: entrant.losses,
      games: entrant.games,
      scoredGames: entrant.games,
      qualified: row.qualified,
      rank: row.rank,
      isMe: Boolean(me && me.playerId === entrant.playerId),
      championTitle: champion?.title ?? null,
    };
  }

  private matchView(entrant: Entrant): TournamentMatchView | null {
    const match = entrant.matchId ? this.matches.get(entrant.matchId) : undefined;
    if (!match) return null;
    const side = this.sideOf(match, entrant.playerId);
    const mine = this.participant(match, side);
    const rival = this.participant(match, opponent(side));
    const finished = match.status === 'finished';
    const scored = finished ? Boolean(match.deltas) : true;
    let result: TournamentMatchView['result'] = null;
    if (finished) {
      const reason = match.reason && END_REASONS.has(match.reason) ? match.reason : 'abandoned';
      const outcome = match.winner && match.deltas ? (match.winner === side ? 'win' : 'loss') : 'abandoned';
      result = { outcome, winner: match.winner, reason, pointsAwarded: match.deltas?.[side] ?? 0 };
    }
    const upcoming = (e: Entrant | undefined) => (e ? e.games + 1 : null);
    return {
      id: match.id,
      side,
      opponentName: rival.name,
      status: match.status,
      state: match.state,
      startsAt: match.status === 'preparing' ? null : match.startedAt ?? match.startsAt,
      ready: match.ready.has(side),
      opponentReady: match.ready.has(opponent(side)),
      readyDeadline: match.status === 'preparing' ? match.readyDeadline : null,
      opponentPresence: this.entrants.get(rival.playerId)?.presence ?? 'foreground',
      ...(rival.isBot ? { opponentIsBot: true } : {}),
      countsForScore: scored,
      opponentCountsForScore: scored,
      scoredMatchNumber: finished ? (scored ? mine.matchNumber : null) : mine.matchNumber ?? upcoming(entrant),
      turnDeadline: match.status === 'playing' ? match.turnDeadline : null,
      opponentConnected: rival.isBot || this.clientsByPlayer.has(rival.playerId),
      result,
      finishedAt: match.finishedAt,
    };
  }

  private sendSnapshot(playerId: string | null): void {
    if (!playerId) return;
    const client = this.clientsByPlayer.get(playerId);
    if (!client) return;
    this.safeSend(client, { type: 'TOURNAMENT_SNAPSHOT', snapshot: this.snapshotFor(playerId) });
  }

  private sendMatchSnapshots(match: LiveMatch): void {
    this.sendSnapshot(match.black.playerId);
    this.sendSnapshot(match.white.playerId);
  }

  private broadcast(): void {
    for (const playerId of this.clientsByPlayer.keys()) this.sendSnapshot(playerId);
  }

  private error(client: TournamentClient, code: TournamentErrorCode): void {
    this.safeSend(client, { type: 'TOURNAMENT_ERROR', code, message: ERROR_MESSAGES[code] });
    const playerId = this.playerByClient.get(client);
    if (playerId && code !== 'SUPERSEDED' && code !== 'UPDATE_REQUIRED') this.sendSnapshot(playerId);
  }

  private safeSend(client: TournamentClient, message: TournamentServerMessage): void {
    try {
      client.send(message);
    } catch (error) {
      this.logger.warn('[tournament] 메시지 전송 실패:', error);
    }
  }

  // ─── 연결/참가자 ─────────────────────────────────────────────────────────

  private bind(client: TournamentClient, identity: TournamentIdentity): void {
    const playerId = identity.playerId;
    this.identities.set(playerId, identity);
    const previousPlayer = this.playerByClient.get(client);
    if (previousPlayer && previousPlayer !== playerId) this.detach(client, false);
    const current = this.clientsByPlayer.get(playerId);
    if (current && current !== client) {
      this.supersededClients.add(current);
      this.playerByClient.delete(current);
      this.safeSend(current, { type: 'TOURNAMENT_ERROR', code: 'SUPERSEDED', message: ERROR_MESSAGES.SUPERSEDED });
    }
    this.clientsByPlayer.set(playerId, client);
    this.playerByClient.set(client, playerId);
    const entrant = this.entrants.get(playerId);
    if (!entrant) return;
    entrant.platform = identity.platform;
    if (identity.name && entrant.name !== identity.name) this.updateName(playerId, identity.name);
    if (current === client) return;
    const match = entrant.matchId ? this.matches.get(entrant.matchId) : undefined;
    if (match && match.status === 'playing') {
      const side = this.sideOf(match, playerId);
      const grace = match.graceTimers.get(side);
      if (grace) {
        clearTimeout(grace);
        match.graceTimers.delete(side);
      }
      this.sendSnapshot(this.otherPlayerId(match, playerId));
    }
  }

  /** 공식 경기는 사람끼리만. 플랫폼으로 제한하지 않는다 */
  private isEligible(identity: TournamentIdentity): boolean {
    return !isRankedBotId(identity.playerId);
  }

  private sideOf(match: LiveMatch, playerId: string): Player {
    return match.black.playerId === playerId ? 'BLACK' : 'WHITE';
  }

  private participant(match: LiveMatch, side: Player): Side {
    return side === 'BLACK' ? match.black : match.white;
  }

  private otherPlayerId(match: LiveMatch, playerId: string): string {
    return match.black.playerId === playerId ? match.white.playerId : match.black.playerId;
  }

  private ensureEntrant(playerId: string, name: string): Entrant {
    let entrant = this.entrants.get(playerId);
    if (!entrant) {
      entrant = {
        playerId,
        name,
        key: createHash('sha256').update((this.settings?.id ?? '') + ':' + playerId).digest('hex').slice(0, 16),
        isBot: this.botProfiles.has(playerId),
        registration: null,
        platform: 'unknown',
        points: this.botProfiles.has(playerId) ? 0 : this.settings?.startingScore ?? 0,
        wins: 0,
        losses: 0,
        games: 0,
        status: 'idle',
        queuedAt: null,
        matchId: null,
        lastOpponentId: null,
        present: false,
        presence: 'foreground',
        presenceSeq: 0,
        lease: null,
        backgroundActive: false,
        pausedReason: null,
      };
      this.entrants.set(playerId, entrant);
      this.standingsCache = null;
    }
    return entrant;
  }
}

export async function createTournamentService(options: TournamentServiceOptions): Promise<TournamentService> {
  const service = new TournamentService(options);
  await service.init();
  return service;
}
