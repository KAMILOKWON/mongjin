import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { createOfficialBot, chooseOfficialBotMove } from './officialBot';

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('서버 공식 봇', () => {
  it('이용자 Elo 근처에서 여러 상대 점수를 만든다', () => {
    expect(createOfficialBot(1400, '플레이어', () => 0).rating).toBe(1360);
    expect(createOfficialBot(1400, '플레이어', () => 0.999).rating).toBe(1440);
  });

  it('직전 상대와 같은 성향·진영 조합 및 닉네임을 연속 선택하지 않는다', () => {
    const first = createOfficialBot(1400, '플레이어', () => 0);
    const second = createOfficialBot(1400, '플레이어', () => 0, first);
    expect(second.variantKey).not.toBe(first.variantKey);
    expect(second.name).not.toBe(first.name);
  });

  it('상대 Elo가 높을수록 더 깊고 정밀하게 탐색한다', () => {
    const low = createOfficialBot(1000, '플레이어', () => 0);
    const high = createOfficialBot(1900, '플레이어', () => 0);
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
