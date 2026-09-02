import { chooseMove, type AiOptions } from '../src/ai/ai';
import type { RuleConfig } from '../src/core/config';
import { legalMoves } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import { createGhostNickname } from '../src/ghost';

export type OfficialBotPersonality = 'runner' | 'guardian' | 'tactician' | 'wanderer';

export interface OfficialBotSearchProfile {
  maxMs: number;
  maxDepth: number;
  maxNodes: number;
  choiceWindow: number;
  planStrength: number;
  strategyLevel: NonNullable<AiOptions['strategyLevel']>;
  elite: boolean;
}

export interface PreviousOfficialBot {
  name: string;
  variantKey: string;
}

export interface OfficialBotProgress {
  completed: number;
  recentWins: number;
  recentLosses: number;
}

export type OfficialBotDifficultyBand = 'onboarding' | 'assist' | 'balanced' | 'challenge';

export interface OfficialBot {
  name: string;
  rating: number;
  searchRating: number;
  difficultyBand: OfficialBotDifficultyBand;
  side: Player;
  personality: OfficialBotPersonality;
  variantKey: string;
  search: OfficialBotSearchProfile;
  thinking: boolean;
  moveCount: number;
  random: () => number;
}

interface SearchTier extends OfficialBotSearchProfile {
  maxRating: number;
}

interface PersonalityTuning {
  id: OfficialBotPersonality;
  depthOffset: number;
  nodeScale: number;
  choiceScale: number;
  planScale: number;
}

const ONBOARDING_RATING_OFFSETS = [-80, -60, -40] as const;
const BALANCED_RATING_OFFSETS = [-40, -20, 0, 20, 40] as const;
const CHALLENGE_RATING_OFFSETS = [0, 20, 40, 60, 80] as const;

/**
 * 낮은 Elo는 다양한 근접 수를, 높은 Elo는 더 깊고 정밀한 탐색을 사용한다.
 * 서버 이벤트 루프를 오래 점유하지 않도록 최상위도 시간과 노드 수를 제한한다.
 */
const SEARCH_TIERS: SearchTier[] = [
  {
    maxRating: 1099,
    maxMs: 180,
    maxDepth: 3,
    maxNodes: 1_500,
    choiceWindow: 80,
    planStrength: 0.8,
    strategyLevel: 1,
    elite: false,
  },
  {
    maxRating: 1299,
    maxMs: 280,
    maxDepth: 4,
    maxNodes: 4_000,
    choiceWindow: 48,
    planStrength: 1,
    strategyLevel: 2,
    elite: false,
  },
  {
    maxRating: 1499,
    maxMs: 420,
    maxDepth: 5,
    maxNodes: 9_000,
    choiceWindow: 24,
    planStrength: 1.2,
    strategyLevel: 2,
    elite: false,
  },
  {
    maxRating: 1699,
    maxMs: 620,
    maxDepth: 6,
    maxNodes: 18_000,
    choiceWindow: 12,
    planStrength: 1.45,
    strategyLevel: 3,
    elite: true,
  },
  {
    maxRating: 1899,
    maxMs: 780,
    maxDepth: 7,
    maxNodes: 32_000,
    choiceWindow: 5,
    planStrength: 1.65,
    strategyLevel: 3,
    elite: true,
  },
  {
    maxRating: Number.POSITIVE_INFINITY,
    maxMs: 950,
    maxDepth: 9,
    maxNodes: 48_000,
    choiceWindow: 2,
    planStrength: 1.8,
    strategyLevel: 3,
    elite: true,
  },
];

const PERSONALITIES: PersonalityTuning[] = [
  { id: 'runner', depthOffset: 0, nodeScale: 0.95, choiceScale: 1.05, planScale: 1.18 },
  { id: 'guardian', depthOffset: 0, nodeScale: 1.1, choiceScale: 0.95, planScale: 0.9 },
  { id: 'tactician', depthOffset: 1, nodeScale: 1.2, choiceScale: 0.75, planScale: 1 },
  { id: 'wanderer', depthOffset: 0, nodeScale: 0.9, choiceScale: 1.35, planScale: 0.95 },
];

const VARIANTS = PERSONALITIES.flatMap((personality) =>
  (['BLACK', 'WHITE'] as const).map((side) => ({
    personality,
    side,
    key: `${personality.id}:${side}`,
  })),
);

function normalizedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(0.999_999, value));
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(normalizedRandom(random) * items.length)]!;
}

function matchedRating(
  playerRating: number,
  offsets: readonly number[],
  random: () => number,
): number {
  const normalized = Number.isFinite(playerRating) ? playerRating : 1200;
  const rounded = Math.round(normalized / 20) * 20;
  const offset = pick(offsets, random);
  return Math.max(100, Math.min(2400, rounded + offset));
}

function difficultyPolicy(progress: OfficialBotProgress): {
  band: OfficialBotDifficultyBand;
  ratingOffsets: readonly number[];
  searchOffset: number;
} {
  if (progress.completed < 3) {
    const noWinAdjustment = progress.recentWins === 0 ? progress.completed * 40 : 0;
    return {
      band: 'onboarding',
      ratingOffsets: ONBOARDING_RATING_OFFSETS,
      searchOffset: -120 - noWinAdjustment,
    };
  }

  const recentGames = progress.recentWins + progress.recentLosses;
  const recentWinRate = recentGames === 0 ? 0.5 : progress.recentWins / recentGames;
  if (recentGames >= 3 && recentWinRate < 0.4) {
    return { band: 'assist', ratingOffsets: ONBOARDING_RATING_OFFSETS, searchOffset: -80 };
  }
  if (recentGames >= 3 && recentWinRate > 0.55) {
    return { band: 'challenge', ratingOffsets: CHALLENGE_RATING_OFFSETS, searchOffset: 80 };
  }
  return { band: 'balanced', ratingOffsets: BALANCED_RATING_OFFSETS, searchOffset: 0 };
}

function searchProfile(rating: number, tuning: PersonalityTuning): OfficialBotSearchProfile {
  const tier = SEARCH_TIERS.find((candidate) => rating <= candidate.maxRating) ?? SEARCH_TIERS.at(-1)!;
  return {
    maxMs: tier.maxMs,
    maxDepth: tier.maxDepth + tuning.depthOffset,
    maxNodes: Math.round(tier.maxNodes * tuning.nodeScale),
    choiceWindow: Math.max(1, Math.round(tier.choiceWindow * tuning.choiceScale)),
    planStrength: tier.planStrength * tuning.planScale,
    strategyLevel: tier.strategyLevel,
    elite: tier.elite,
  };
}

function onboardingSearchAdjustment(
  search: OfficialBotSearchProfile,
  progress: OfficialBotProgress,
): OfficialBotSearchProfile {
  if (progress.completed >= 3 || progress.recentWins > 0 || progress.completed === 0) return search;
  const step = Math.min(2, progress.completed);
  return {
    ...search,
    maxMs: Math.max(80, search.maxMs - step * 40),
    maxDepth: Math.max(2, search.maxDepth - (step === 2 ? 1 : 0)),
    maxNodes: Math.max(600, Math.round(search.maxNodes * (1 - step * 0.2))),
    choiceWindow: search.choiceWindow + step * 24,
    planStrength: Math.max(0.5, search.planStrength - step * 0.15),
    elite: false,
  };
}

export function createOfficialBot(
  playerRating: number,
  playerName: string,
  random: () => number = Math.random,
  previous?: PreviousOfficialBot,
  progress: OfficialBotProgress = { completed: 0, recentWins: 0, recentLosses: 0 },
): OfficialBot {
  const policy = difficultyPolicy(progress);
  const rating = matchedRating(playerRating, policy.ratingOffsets, random);
  const searchRating = Math.max(100, Math.min(2400, rating + policy.searchOffset));
  const availableVariants = previous
    ? VARIANTS.filter((candidate) => candidate.key !== previous.variantKey)
    : VARIANTS;
  const variant = pick(availableVariants, random);
  return {
    name: createGhostNickname({ previousName: previous?.name, playerName, random }),
    rating,
    searchRating,
    difficultyBand: policy.band,
    side: variant.side,
    personality: variant.personality.id,
    variantKey: variant.key,
    search: onboardingSearchAdjustment(searchProfile(searchRating, variant.personality), progress),
    thinking: false,
    moveCount: 0,
    random,
  };
}

export function chooseOfficialBotMove(
  bot: OfficialBot,
  state: GameState,
  config: RuleConfig,
): Move | null {
  const legal = legalMoves(state, config);
  if (legal.length === 0) return null;

  try {
    // 첫 세 번은 즉시 패배하지 않는 근접 최선수의 폭을 조금 넓혀
    // 고 Elo에서도 매번 같은 정석 한 수로 시작하지 않게 한다.
    const choiceWindow = bot.moveCount < 3
      ? Math.max(12, bot.search.choiceWindow)
      : bot.search.choiceWindow;
    const move = chooseMove(state, config, {
      ...bot.search,
      choiceWindow,
      rng: bot.random,
      botSide: bot.side,
    }) ?? legal[0]!;
    bot.moveCount += 1;
    return move;
  } catch {
    bot.moveCount += 1;
    return legal[0]!;
  }
}
