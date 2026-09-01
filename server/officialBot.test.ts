import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, legalMoves } from '../src/core/rules';
import { createOfficialBot, chooseOfficialBotMove } from './officialBot';

describe('서버 공식 봇', () => {
  it('이용자 Elo와 가장 가까운 번들 기보를 선택한다', () => {
    expect(createOfficialBot(1200, '플레이어', () => 0).rating).toBe(1180);
    expect(createOfficialBot(1290, '플레이어', () => 0).rating).toBe(1260);
    expect(createOfficialBot(1800, '플레이어', () => 0).rating).toBe(1340);
  });

  it('봇 차례에는 서버 규칙에 맞는 합법 수만 고른다', () => {
    const state = initialState(DEFAULT_CONFIG);
    const bot = createOfficialBot(1200, '플레이어', () => 0);
    const move = chooseOfficialBotMove(bot, state, DEFAULT_CONFIG);
    expect(move).not.toBeNull();
    expect(legalMoves(state, DEFAULT_CONFIG)).toContainEqual(move);
  });
});
