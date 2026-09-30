import type {
  TournamentBackgroundDestination,
  TournamentBackgroundView,
  TournamentEntrantStatus,
  TournamentPauseReason,
  TournamentPresence,
} from '../src/net/tournamentProtocol';

export type { TournamentBackgroundDestination, TournamentPauseReason, TournamentPresence } from '../src/net/tournamentProtocol';

/** 앱 밖 대기 유효 기간. 클라이언트 신호로는 연장되지 않는다 */
export const DEFAULT_BACKGROUND_LEASE_MS = 600_000;
export const MIN_BACKGROUND_LEASE_MS = 60_000;
export const MAX_BACKGROUND_LEASE_MS = 3_600_000;
/** 앱 밖에서 매칭된 경기의 준비 제한 시간 */
export const DEFAULT_BACKGROUND_READY_TIMEOUT_MS = 60_000;
export const MIN_BACKGROUND_READY_TIMEOUT_MS = 15_000;
export const MAX_BACKGROUND_READY_TIMEOUT_MS = 120_000;

/**
 * 앱 밖 표시 상태 변화. 메인이 순서대로 영속 발송 작업으로 옮긴다.
 * 토큰·문구는 넣지 않는다. 목적지는 메인이 저장한 대기 기기에서 찾는다.
 */
export interface TournamentBackgroundChange {
  playerId: string;
  tournamentId: string;
  title: string;
  /** 서버 기준 대기 시작 시각. ended이면 null */
  queuedAt: number | null;
  /** waiting: 유효 기간 끝, matched: 준비 마감, ended: null */
  expiresAt: number | null;
  state: 'waiting' | 'matched' | 'ended';
  matchId?: string;
}

/**
 * 메인이 저장된 대기 기기와 실제 발송 가능 여부(설정·자격)로 판정한다.
 * 토큰 형식이나 클라이언트의 알림 가능 신호만으로 참을 돌려주면 안 된다.
 */
export type CanBackgroundWait = (
  playerId: string,
  tournamentId: string,
  destination: TournamentBackgroundDestination,
) => boolean | Promise<boolean>;
export type BackgroundChangeSink = (change: TournamentBackgroundChange) => void | Promise<void>;

/** REST 상태 조회용 읽기 전용 요약 */
export interface TournamentBackgroundStatus {
  tournamentId: string;
  status: TournamentEntrantStatus;
  presence: TournamentPresence;
  background: TournamentBackgroundView | null;
  pausedReason: TournamentPauseReason | null;
}

export interface BackgroundLease {
  destination: TournamentBackgroundDestination | null;
  queuedAt: number;
  expiresAt: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** 형식만 확인한 정규 목적지. 소유·발송 가능 검증은 CanBackgroundWait가 한다 */
export function parseBackgroundDestination(value: unknown): TournamentBackgroundDestination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'expo' && raw.kind !== 'live_activity') return null;
  if (typeof raw.token !== 'string' || !raw.token || raw.token.length > 512 || CONTROL.test(raw.token)) return null;
  if (raw.activityId !== undefined && (typeof raw.activityId !== 'string' || !raw.activityId || raw.activityId.length > 200 || CONTROL.test(raw.activityId))) return null;
  return raw.activityId === undefined
    ? { kind: raw.kind, token: raw.token }
    : { kind: raw.kind, token: raw.token, activityId: raw.activityId };
}

export function isPresence(value: unknown): value is TournamentPresence {
  return value === 'foreground' || value === 'background';
}
