/** Shared, server-authoritative tournament contract for every platform. */
import type { GameState, Move, Player } from '../core/types';

export const TOURNAMENT_PROTOCOL_VERSION = 2 as const;
export const TOURNAMENT_STATUS_PATH = '/tournament/status';
export const TOURNAMENT_PRACTICE_MOVE_PATH = '/tournament/practice-move';
export const TOURNAMENT_PRACTICE_RECORD_PATH = '/tournament/practice-record';

export type TournamentPhase = 'disabled' | 'scheduled' | 'recruiting' | 'confirmed' | 'cancelled' | 'active' | 'finishing' | 'finished';
export type TournamentEntrantStatus = 'idle' | 'queued' | 'preparing' | 'countdown' | 'playing' | 'result';
export type TournamentEndReason = 'goal' | 'capture' | 'surround' | 'no-moves' | 'resign' | 'timeout' | 'disconnect' | 'abandoned' | 'store-error';
/** 앱이 화면에 있는지. 보내지 않는 클라이언트는 foreground로 취급한다 */
export type TournamentPresence = 'foreground' | 'background';
/** 앱 밖 대기 알림 목적지. 서버가 등록 기기와 대조해 검증한다 */
export interface TournamentBackgroundDestination {
  kind: 'expo' | 'live_activity';
  token: string;
  activityId?: string;
}
/** 서버가 대기를 멈춘 이유. 다음 입장(JOIN/NEXT)에서 지워진다 */
export type TournamentPauseReason = 'no_background_channel' | 'background_expired' | 'not_ready' | 'cancelled' | 'ended';
export interface TournamentBackgroundView {
  state: 'waiting' | 'matched';
  /** 서버 기준 대기 시작 시각. 경과 시간 표시 기준 */
  queuedAt: number;
  /** waiting: 앱 밖 대기 유효 기간 끝, matched: 준비 마감 */
  expiresAt: number;
  matchId: string | null;
}
export interface TournamentNextEvent {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
}
export interface TournamentConfigView extends TournamentNextEvent {
  /** Configured real official bot profiles in this event; absent for legacy/human-only events. */
  botCount?: number;
  registrationStartsAt: number;
  registrationEndsAt: number;
  minimumParticipants: number;
  minimumRankedMatches: number;
  /** Event Elo resets to zero; every completed human game counts. */
  startingScore: number;
  eloK: number;
  eloScale: number;
  /** No move clock runs before both players are ready and this countdown expires. */
  matchCountdownMs: number;
  moveTimeMs: number;
  reconnectGraceMs: number;

  isInaugural: boolean;
  /** Only operator-configured rewards, never fabricated dates or promises. */
  rewardDescription: string;
  /** Retained for old rendering code during migration; no automatic requeue. */
  resultCountdownMs: number;
  /** Human wait before this event may offer an idle configured bot opponent. */
  waitMs: number;
  /** 앱 밖 대기 유효 기간(ms). 클라이언트 신호로 연장되지 않는다 */
  backgroundLeaseMs?: number;
  /** 앱 밖에서 매칭된 경기의 준비 제한 시간(ms) */
  backgroundReadyTimeoutMs?: number;
}
export interface TournamentMatchResultView {
  outcome: 'win' | 'loss' | 'abandoned';
  winner: Player | null;
  reason: TournamentEndReason;
  pointsAwarded: number;
}
export interface TournamentMatchView {
  id: string;
  side: Player;
  opponentName: string;
  /** Additive server classification; opponents use their existing profile nicknames. */
  opponentIsBot?: boolean;
  status: 'preparing' | 'countdown' | 'playing' | 'finished';
  state: GameState;
  /** Server timestamp. Null until both players acknowledge readiness. */
  startsAt: number | null;
  ready: boolean;
  opponentReady: boolean;
  /** 준비 확인 마감(서버 시각). preparing일 때만 값 */
  readyDeadline?: number | null;
  opponentPresence?: TournamentPresence;
  countsForScore: boolean;
  opponentCountsForScore: boolean;
  scoredMatchNumber: number | null;
  turnDeadline: number | null;
  opponentConnected: boolean;
  result: TournamentMatchResultView | null;
  finishedAt: number | null;
}
export interface TournamentStandingView {
  entrantKey: string;
  name: string;
  points: number;
  /** All completed human games in this event. */
  wins: number;
  losses: number;
  /** All completed human games. Practice and abandoned matches never count. */
  games: number;
  scoredGames: number;
  qualified: boolean;
  /** Unqualified players have no official rank; ties share rank (1,1,3). */
  rank: number | null;
  isMe: boolean;
  championTitle: string | null;
}
export interface TournamentSnapshot {
  protocolVersion: typeof TOURNAMENT_PROTOCOL_VERSION;
  config: TournamentConfigView | null;
  phase: TournamentPhase;
  serverNow: number;
  eligible: boolean;
  /** Registration only, never proof of queue presence. */
  registered: boolean;
  /** Compatibility alias for registered. */
  joined: boolean;
  registrationCount: number;
  nextTournament: TournamentNextEvent | null;
  status: TournamentEntrantStatus;
  queuedAt: number | null;
  meId: string | null;
  match: TournamentMatchView | null;
  standings: TournamentStandingView[];
  standingsTotal: number;
  myStanding: TournamentStandingView | null;
  activeHumans: number;
  presence?: TournamentPresence;
  /** 앱 밖 대기 중일 때만 값 */
  background?: TournamentBackgroundView | null;
  pausedReason?: TournamentPauseReason | null;
}
export interface TournamentPublicStatus {
  protocolVersion: typeof TOURNAMENT_PROTOCOL_VERSION;
  config: TournamentConfigView | null;
  phase: TournamentPhase;
  serverNow: number;
  entrantCount: number;
  registrationCount: number;
  nextTournament: TournamentNextEvent | null;
}
export type TournamentClientMessage = (
  | { type: 'TOURNAMENT_STATUS' }
  | { type: 'TOURNAMENT_REGISTER' }
  | { type: 'TOURNAMENT_UNREGISTER' }
  | { type: 'TOURNAMENT_JOIN' }
  | { type: 'TOURNAMENT_PAUSE' }
  | { type: 'TOURNAMENT_NEXT' }
  | { type: 'TOURNAMENT_READY'; matchId: string }
  | { type: 'TOURNAMENT_PRESENCE'; state: TournamentPresence; destination?: TournamentBackgroundDestination }
  | { type: 'TOURNAMENT_MOVE'; matchId: string; move: Move; ply: number }
  | { type: 'TOURNAMENT_RESIGN'; matchId: string }
) & { protocolVersion?: number; tournamentId?: string };
export type TournamentErrorCode = 'NOT_AUTHENTICATED' | 'DISABLED' | 'NOT_ELIGIBLE' | 'NOT_STARTED' | 'ENDED' | 'NOT_JOINED' | 'BUSY_ELSEWHERE' | 'IN_MATCH' | 'NO_MATCH' | 'STALE_MOVE' | 'NOT_YOUR_TURN' | 'ILLEGAL_MOVE' | 'MATCH_FINISHED' | 'SUPERSEDED' | 'INVALID_MESSAGE' | 'SERVER_ERROR' | 'UPDATE_REQUIRED' | 'REGISTRATION_CLOSED' | 'CANCELLED' | 'NOT_READY' | 'FOREGROUND_REQUIRED';
export type TournamentServerMessage =
  | { type: 'TOURNAMENT_SNAPSHOT'; snapshot: TournamentSnapshot }
  | { type: 'TOURNAMENT_ERROR'; code: TournamentErrorCode; message: string };
export function isTournamentMessageType(type: unknown): type is TournamentClientMessage['type'] {
  return typeof type === 'string' && type.startsWith('TOURNAMENT_');
}
