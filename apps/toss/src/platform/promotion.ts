import { Promotion } from '@apps-in-toss/web-framework';

const DEFAULT_DAILY_PLAY_CODE = '01M1ATZT5780P7V9200S2EXZW7';
const DEFAULT_DAILY_PLAY_AMOUNT = 100;
const DEFAULT_DAILY_FIVE_GAMES_CODE = '01M1B15W0XHRZ7H0YMEX11KKWS';
const DEFAULT_DAILY_FIVE_GAMES_AMOUNT = 10;
const DAILY_FIVE_GAMES_TARGET = 5;
const CLAIM_MARKER_PREFIX = 'mongjin.ait.promotion-claim.v1';
const DAILY_GAME_PROGRESS_KEY = 'mongjin.ait.daily-game-progress.v1';

export interface PromotionReward {
  id: 'daily-play' | 'daily-five-games';
  label: string;
  code: string;
  amount: number;
}

export const dailyPlayPromotion: PromotionReward = {
  id: 'daily-play',
  label: '하루 첫 대국',
  code: import.meta.env.VITE_TOSS_PROMOTION_CODE?.trim() || DEFAULT_DAILY_PLAY_CODE,
  amount: Number(import.meta.env.VITE_TOSS_PROMOTION_AMOUNT || DEFAULT_DAILY_PLAY_AMOUNT),
};

export const dailyFiveGamesPromotion: PromotionReward = {
  id: 'daily-five-games',
  label: '하루 5판',
  code:
    import.meta.env.VITE_TOSS_FIVE_GAME_PROMOTION_CODE?.trim() ||
    DEFAULT_DAILY_FIVE_GAMES_CODE,
  amount: Number(
    import.meta.env.VITE_TOSS_FIVE_GAME_PROMOTION_AMOUNT ||
      DEFAULT_DAILY_FIVE_GAMES_AMOUNT,
  ),
};

export const promotionAmount = dailyPlayPromotion.amount;
export const promotionTestRewards = [dailyPlayPromotion, dailyFiveGamesPromotion].filter(
  (reward) => reward.code.startsWith('TEST_'),
);
export const isPromotionTestBuild = promotionTestRewards.length > 0;

export type PromotionClaimResult =
  | { status: 'success'; key: string }
  | { status: 'already-claimed' }
  | { status: 'unsupported' }
  | { status: 'error'; code: string | null; message: string };

interface DailyGameProgress {
  date: string;
  count: number;
}

const inFlight = new Map<string, Promise<PromotionClaimResult>>();
let memoryProgress: DailyGameProgress | null = null;

function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function claimMarkerKey(code: string): string {
  return `${CLAIM_MARKER_PREFIX}.${code}`;
}

function claimedToday(reward: PromotionReward): boolean {
  try {
    return localStorage.getItem(claimMarkerKey(reward.code)) === localDateKey();
  } catch {
    return false;
  }
}

function markClaimedToday(reward: PromotionReward): void {
  try {
    localStorage.setItem(claimMarkerKey(reward.code), localDateKey());
  } catch {
    // 저장소가 막혀도 토스의 사용자별 일일 지급 한도가 최종 방어선으로 남는다.
  }
}

function readDailyGameProgress(): DailyGameProgress {
  const today = localDateKey();
  try {
    const stored = JSON.parse(localStorage.getItem(DAILY_GAME_PROGRESS_KEY) || 'null') as
      | DailyGameProgress
      | null;
    if (stored?.date === today && Number.isInteger(stored.count) && stored.count >= 0) {
      memoryProgress = stored;
      return stored;
    }
  } catch {
    if (memoryProgress?.date === today) return memoryProgress;
  }
  return { date: today, count: 0 };
}

function recordCompletedGame(): number {
  const current = readDailyGameProgress();
  const next = { date: current.date, count: current.count + 1 };
  memoryProgress = next;
  try {
    localStorage.setItem(DAILY_GAME_PROGRESS_KEY, JSON.stringify(next));
  } catch {
    // 저장소를 쓸 수 없는 세션에서도 메모리 기준으로 5판을 셀 수 있다.
  }
  return next.count;
}

function toPromotionError(error: unknown): PromotionClaimResult {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return {
    status: 'error',
    code: typeof candidate?.code === 'string' ? candidate.code : null,
    message:
      typeof candidate?.message === 'string'
        ? candidate.message
        : '토스 포인트 지급 요청에 실패했어요.',
  };
}

/** 성공한 프로모션은 해당 기기에서 같은 날 다시 요청하지 않는다. */
export function claimPromotionReward(reward: PromotionReward): Promise<PromotionClaimResult> {
  if (claimedToday(reward)) return Promise.resolve({ status: 'already-claimed' });
  const pending = inFlight.get(reward.code);
  if (pending) return pending;
  if (!Promotion.grantReward.isSupported()) {
    return Promise.resolve({ status: 'unsupported' });
  }

  const request = Promotion.grantReward({
    promotionCode: reward.code,
    amount: reward.amount,
  })
    .then((result) => {
      markClaimedToday(reward);
      return { status: 'success', key: result.key } as const;
    })
    .catch(toPromotionError)
    .finally(() => {
      inFlight.delete(reward.code);
    });

  inFlight.set(reward.code, request);
  return request;
}

export function claimDailyPromotionReward(): Promise<PromotionClaimResult> {
  return claimPromotionReward(dailyPlayPromotion);
}

/**
 * 완료된 대국을 하루 단위로 누적하고 해당하는 리워드를 요청한다.
 * 첫 대국은 100원, 다섯 번째 대국부터는 하루 한 번 추가 10원을 요청한다.
 */
export function recordCompletedGameForPromotions(): Promise<PromotionClaimResult[]> {
  const completedGames = recordCompletedGame();
  const claims = [claimDailyPromotionReward()];
  if (completedGames >= DAILY_FIVE_GAMES_TARGET) {
    claims.push(claimPromotionReward(dailyFiveGamesPromotion));
  }
  return Promise.all(claims);
}
