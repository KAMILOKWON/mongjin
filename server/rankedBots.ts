import { randomBytes } from 'node:crypto';
import type { ProfileRepository, StoredProfile } from './profileRepository';

export interface RankedBotDefinition {
  id: string;
  name: string;
  rating: number;
  searchRating?: number;
  personality: 'runner' | 'guardian' | 'tactician' | 'wanderer';
}

export const RANKED_BOTS: readonly RankedBotDefinition[] = [
  { id: 'ranked-bot-may', name: '연세대MAY', rating: 1000, personality: 'guardian' },
  { id: 'ranked-bot-cinnamon', name: '씹다버린계피', rating: 1100, personality: 'wanderer' },
  { id: 'ranked-bot-furnace', name: '용광로불주먹', rating: 1200, personality: 'runner' },
  { id: 'ranked-bot-peers', name: '동년배들몽진한다', rating: 1300, personality: 'guardian' },
  { id: 'ranked-bot-uzumaki', name: 'うずまき', rating: 1400, personality: 'runner' },
  { id: 'ranked-bot-faker', name: 'faker', rating: 1500, personality: 'tactician' },
  { id: 'ranked-bot-astra', name: 'Astra', rating: 1600, personality: 'tactician' },
  { id: 'ranked-bot-moonwalk', name: '나그네2847', rating: 1050, personality: 'wanderer' },
  { id: 'ranked-bot-captain', name: '나그네5931', rating: 1150, personality: 'guardian' },
  { id: 'ranked-bot-stonewall', name: '나그네7068', rating: 1250, personality: 'tactician' },
  { id: 'ranked-bot-windway', name: '나그네9325', rating: 1350, personality: 'runner' },
  { id: 'ranked-bot-slowmove', name: '히어로메이커', rating: 1450, personality: 'wanderer' },
  { id: 'ranked-bot-dawnstar', name: '영일만사나이', rating: 1550, personality: 'tactician' },
  { id: 'ranked-bot-guide', name: '이겜뭐임', rating: 1600, personality: 'guardian' },
  { id: 'ranked-bot-first-place', name: '1등찍고접기', rating: 1600, personality: 'runner' },
  {
    id: 'ranked-bot-jev',
    name: '침착맨이할때까지',
    rating: 1200,
    searchRating: 2400,
    personality: 'tactician',
  },
];
export const isRankedBotId = (id: string) => RANKED_BOTS.some((bot) => bot.id === id);

const RATING_BAND = 250;
const MIN_CANDIDATES = 5;
const RATING_WEIGHT_SCALE = 200;
const RECENT_PENALTIES = [5, 3, 2, 1.5, 1] as const;

export interface RankedBotSelectionOptions {
  /** 최신순. 같은 ID가 반복되면 차단하지 않고 감점만 누적한다. */
  recentBotIds?: readonly string[];
  random?: () => number;
}

export async function ensureRankedBots(repository: ProfileRepository): Promise<StoredProfile[]> {
  const profiles = await repository.loadProfiles();
  const now = new Date().toISOString();
  for (const bot of RANKED_BOTS) {
    if (profiles.some((p) => p.playerId !== bot.id && p.name === bot.name)) {
      throw new Error(`고정 봇 이름이 기존 프로필과 겹칩니다: ${bot.name}`);
    }
  }
  await repository.importProfiles(RANKED_BOTS.map((bot) => ({
    playerId: bot.id, name: bot.name, token: randomBytes(32).toString('hex'),
    rating: bot.rating, wins: 0, losses: 0, createdAt: now, updatedAt: now,
  })));
  return repository.loadProfiles();
}

function normalizedRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999_999, value)) : 0;
}

function recentPenalty(botId: string, recentBotIds: readonly string[]): number {
  return recentBotIds.slice(0, RECENT_PENALTIES.length).reduce(
    (sum, recentId, index) => sum + (recentId === botId ? RECENT_PENALTIES[index]! : 0),
    0,
  );
}

export function selectRankedBot(
  profiles: Iterable<StoredProfile>,
  rating: number,
  options: RankedBotSelectionOptions = {},
): StoredProfile {
  const normalizedRating = Number.isFinite(rating) ? rating : 1200;
  const recentBotIds = (options.recentBotIds ?? []).slice(0, RECENT_PENALTIES.length);
  const ranked = [...profiles]
    .filter((profile) => isRankedBotId(profile.playerId))
    .sort((left, right) =>
      Math.abs(left.rating - normalizedRating) - Math.abs(right.rating - normalizedRating) ||
      left.playerId.localeCompare(right.playerId));
  if (!ranked.length) throw new Error('고정 봇 프로필이 없습니다');

  const closestGap = Math.abs(ranked[0]!.rating - normalizedRating);
  const withinBand = ranked.filter(
    (profile) => Math.abs(profile.rating - normalizedRating) <= closestGap + RATING_BAND,
  );
  const immediatePrevious = recentBotIds[0];
  const excludePrevious = immediatePrevious && ranked.some((candidate) => candidate.playerId !== immediatePrevious);
  const eligibleRanked = excludePrevious
    ? ranked.filter((candidate) => candidate.playerId !== immediatePrevious)
    : ranked;
  const eligibleBand = excludePrevious
    ? withinBand.filter((candidate) => candidate.playerId !== immediatePrevious)
    : withinBand;
  const minimumSize = Math.min(MIN_CANDIDATES, eligibleRanked.length);
  const candidates = eligibleBand.length >= minimumSize
    ? eligibleBand
    : eligibleRanked.slice(0, minimumSize);
  const weighted = candidates.map((profile) => {
    const gap = Math.abs(profile.rating - normalizedRating);
    const ratingWeight = Math.exp(-gap / RATING_WEIGHT_SCALE);
    return { profile, weight: ratingWeight / (1 + recentPenalty(profile.playerId, recentBotIds)) };
  });
  const total = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = normalizedRandom(options.random ?? Math.random) * total;
  for (const candidate of weighted) {
    roll -= candidate.weight;
    if (roll < 0) return candidate.profile;
  }
  return weighted.at(-1)!.profile;
}
