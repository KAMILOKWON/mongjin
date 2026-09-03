import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { createOfficialBot, chooseOfficialBotMove, officialBotMoveDelayMs } from './officialBot';

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('서버 공식 봇', () => {
  const balanced = { completed: 3, recentWins: 1, recentLosses: 1 };

  it('첫 3판은 이용자보다 40~80 Elo 낮게 배정한다', () => {
    const easiest = createOfficialBot(1400, '플레이어', () => 0);
    const closest = createOfficialBot(1400, '플레이어', () => 0.999);
    expect(easiest.rating).toBe(1320);
    expect(closest.rating).toBe(1360);
    expect(easiest.searchRating).toBe(1200);
    expect(easiest.difficultyBand).toBe('onboarding');
  });

  it('낮은 Elo 이용자도 기존 800 하한 때문에 더 강한 봇을 만나지 않는다', () => {
    expect(createOfficialBot(300, '플레이어', () => 0).rating).toBe(220);
  });

  it('첫 판부터 수읽기와 후보 선택을 초보자에게 유리하게 완화한다', () => {
    const first = createOfficialBot(1400, '플레이어', () => 0);
    const afterWin = createOfficialBot(
      1400,
      '플레이어',
      () => 0,
      undefined,
      { completed: 1, recentWins: 1, recentLosses: 0 },
    );
    const third = createOfficialBot(
      1400,
      '플레이어',
      () => 0,
      undefined,
      { completed: 2, recentWins: 0, recentLosses: 2 },
    );
    expect(first.searchRating).toBe(afterWin.searchRating);
    expect(first.search.maxNodes).toBeLessThan(afterWin.search.maxNodes);
    expect(first.search.choiceWindow).toBeGreaterThan(afterWin.search.choiceWindow);
    expect(third.searchRating).toBeLessThan(first.searchRating);
    expect(third.search.maxNodes).toBeLessThan(first.search.maxNodes);
    expect(third.search.choiceWindow).toBeGreaterThan(first.search.choiceWindow);
  });

  it('봇의 첫 수만 느리게 두어 상대와 판을 인지할 시간을 준다', () => {
    const bot = createOfficialBot(1200, '플레이어', () => 0);
    expect(officialBotMoveDelayMs(bot)).toBe(650);
    bot.moveCount = 1;
    expect(officialBotMoveDelayMs(bot)).toBe(180);
  });

  it('초보 구간 최근 승률을 40~55% 범위로 되돌리도록 난이도를 조절한다', () => {
    const assisted = createOfficialBot(
      1200,
      '플레이어',
      () => 0,
      undefined,
      { completed: 8, recentWins: 1, recentLosses: 7 },
    );
    const challenged = createOfficialBot(
      1200,
      '플레이어',
      () => 0.999,
      undefined,
      { completed: 8, recentWins: 5, recentLosses: 3 },
    );
    expect(assisted.rating).toBe(1120);
    expect(assisted.searchRating).toBe(1040);
    expect(assisted.difficultyBand).toBe('assist');
    expect(challenged.rating).toBe(1280);
    expect(challenged.searchRating).toBe(1360);
    expect(challenged.difficultyBand).toBe('challenge');
  });

  it('목표 승률 범위 안에서는 이용자 Elo 근처의 상대를 만든다', () => {
    expect(createOfficialBot(1400, '플레이어', () => 0, undefined, balanced).rating).toBe(1360);
    expect(createOfficialBot(1400, '플레이어', () => 0.999, undefined, balanced).rating).toBe(1440);
  });

  it('직전 상대와 같은 성향·진영 조합 및 닉네임을 연속 선택하지 않는다', () => {
    const first = createOfficialBot(1400, '플레이어', () => 0);
    const second = createOfficialBot(1400, '플레이어', () => 0, first);
    expect(second.variantKey).not.toBe(first.variantKey);
    expect(second.name).not.toBe(first.name);
  });

  it('상대 Elo가 높을수록 더 깊고 정밀하게 탐색한다', () => {
    const low = createOfficialBot(1000, '플레이어', () => 0, undefined, balanced);
    const high = createOfficialBot(1900, '플레이어', () => 0, undefined, balanced);
    expect(high.search.maxDepth).toBeGreaterThan(low.search.maxDepth);
    expect(high.search.maxNodes).toBeGreaterThan(low.search.maxNodes);
    expect(high.search.choiceWindow).toBeLessThan(low.search.choiceWindow);
    expect(high.search.strategyLevel).toBeGreaterThan(low.search.strategyLevel);
  });

  it('봇 차례에는 서버 규칙에 맞는 합법 수만 고른다', () => {
    const state = initialState(DEFAULT_CONFIG);
    const bot = createOfficialBot(1200, '플레이어', () => 0);
    const move = chooseOfficialBotMove(bot, state, DEFAULT_CONFIG);
    expect(move).not.toBeNull();
    expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(move);
  });

  it('같은 Elo에서도 난수에 따라 첫 수가 달라질 수 있다', () => {
    const center = createOfficialBot(
      1400,
      '플레이어',
      sequenceRandom([0.5, 0, 0, 0]),
    );
    const side = createOfficialBot(
      1400,
      '플레이어',
      sequenceRandom([0.5, 0, 0, 0.999]),
    );
    const state = initialState(DEFAULT_CONFIG);
    expect(chooseOfficialBotMove(center, state, DEFAULT_CONFIG)).not.toEqual(
      chooseOfficialBotMove(side, state, DEFAULT_CONFIG),
    );
  });
});
