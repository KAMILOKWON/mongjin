export interface ValidatedLegacyProfileClaim {
  name: string;
  wins: number;
  losses: number;
  rating: number;
}

export const DEFAULT_LEGACY_MIGRATION_DEADLINE = '2026-12-01T00:00:00.000Z';

function integerInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

export function validateLegacyProfileClaim(
  value: unknown,
  now = new Date(),
  deadline = process.env.LEGACY_PROFILE_MIGRATION_DEADLINE ?? DEFAULT_LEGACY_MIGRATION_DEADLINE,
): ValidatedLegacyProfileClaim {
  if (now.getTime() > new Date(deadline).getTime()) {
    throw new Error('기존 기기 Elo 승계 기간이 종료되었습니다');
  }
  if (!value || typeof value !== 'object') throw new Error('승계할 기기 기록이 필요합니다');
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
  const wins = integerInRange(raw.wins, 0, 100_000);
  const losses = integerInRange(raw.losses, 0, 100_000);
  const rating = integerInRange(raw.rating, 100, 3_000);
  if (name.length < 2 || name.length > 12 || /[<>\u0000-\u001f]/.test(name)) {
    throw new Error('승계할 닉네임이 올바르지 않습니다');
  }
  if (wins === null || losses === null || rating === null) {
    throw new Error('승계할 Elo 또는 전적이 올바르지 않습니다');
  }
  const games = wins + losses;
  if (Math.abs(rating - 1200) > games * 24) {
    throw new Error('승계 Elo가 기기 전적 범위를 벗어났습니다');
  }
  return { name, wins, losses, rating };
}
