import { beforeEach, describe, expect, it, vi } from 'vitest';

const grantReward = Object.assign(
  vi.fn(async ({ promotionCode }: { promotionCode: string }) => ({ key: promotionCode })),
  { isSupported: vi.fn(() => true) },
);

vi.mock('@apps-in-toss/web-framework', () => ({
  Promotion: { grantReward },
}));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});

const {
  dailyFiveGamesPromotion,
  dailyPlayPromotion,
  recordCompletedGameForPromotions,
} = await import('./promotion');

describe('Apps-in-Toss 일일 플레이 프로모션', () => {
  beforeEach(() => {
    storage.clear();
    grantReward.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 31, 12));
  });

  it('첫 대국에 100원, 다섯 번째 대국에 추가 10원을 한 번씩 요청한다', async () => {
    for (let game = 1; game <= 7; game += 1) {
      await recordCompletedGameForPromotions();
    }

    expect(grantReward).toHaveBeenCalledTimes(2);
    expect(grantReward).toHaveBeenNthCalledWith(1, {
      promotionCode: dailyPlayPromotion.code,
      amount: 100,
    });
    expect(grantReward).toHaveBeenNthCalledWith(2, {
      promotionCode: dailyFiveGamesPromotion.code,
      amount: 10,
    });
  });

  it('날짜가 바뀌면 대국 수와 일일 지급 제한을 초기화한다', async () => {
    for (let game = 1; game <= 5; game += 1) await recordCompletedGameForPromotions();

    vi.setSystemTime(new Date(2026, 8, 1, 12));
    for (let game = 1; game <= 5; game += 1) await recordCompletedGameForPromotions();

    expect(grantReward).toHaveBeenCalledTimes(4);
  });
});
