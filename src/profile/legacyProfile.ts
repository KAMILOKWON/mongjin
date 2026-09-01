export interface LegacyProfileStats {
  name: string;
  wins: number;
  losses: number;
  rating: number;
}

const DEFAULT_LOCAL_NAMES = new Set(['나그네', '플레이어']);

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100_000, Math.trunc(value))) : 0;
}

function validName(value: string): string | null {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return name.length >= 2 && name.length <= 12 && !/[<>\u0000-\u001f]/.test(name) ? name : null;
}

/**
 * 웹의 기존 로컬 Elo와 새 서버 identity에 이미 쌓인 전적을 하나의 승계 요청으로 합친다.
 * Elo는 두 구간의 1200 대비 증감을 더하며 서버 검증 범위 안으로 제한한다.
 */
export function buildLegacyProfileClaim(
  local: LegacyProfileStats,
  remote: LegacyProfileStats,
): LegacyProfileStats {
  const localWins = nonNegativeInteger(local.wins);
  const localLosses = nonNegativeInteger(local.losses);
  const remoteWins = nonNegativeInteger(remote.wins);
  const remoteLosses = nonNegativeInteger(remote.losses);
  const wins = Math.min(100_000, localWins + remoteWins);
  const losses = Math.min(100_000, localLosses + remoteLosses);
  const games = wins + losses;

  const localRating = Number.isFinite(local.rating) ? Math.max(100, Math.min(3_000, Math.round(local.rating))) : 1200;
  const remoteRating = Number.isFinite(remote.rating) ? Math.max(100, Math.min(3_000, Math.round(remote.rating))) : 1200;
  const combinedRating = 1200 + (localRating - 1200) + (remoteRating - 1200);
  const rating = Math.max(
    Math.max(100, 1200 - games * 24),
    Math.min(Math.min(3_000, 1200 + games * 24), combinedRating),
  );

  const localName = validName(local.name);
  const remoteName = validName(remote.name);
  const name = localName && !DEFAULT_LOCAL_NAMES.has(localName)
    ? localName
    : remoteName ?? localName ?? '나그네';

  return { name, wins, losses, rating };
}
