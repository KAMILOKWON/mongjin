import { describe, expect, it } from 'vitest';
import type { StrategyEntry } from '../../bot/learning/types';
import { applyMove } from '../core/apply';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState } from '../core/rules';
import { evalStrategyBonus } from './hints';

const CENTER_STRATEGY: StrategyEntry = {
  id: 'test-center',
  title: '중앙 장악',
  phase: 'opening',
  summary: '중앙 호위를 활용한다',
  mgnPattern: '',
  tags: ['center-control'],
  lessons: [],
  sourceGames: [],
  confidence: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('전략 힌트', () => {
  it('현재 차례가 바뀌어도 봇 관점 평가값은 같다', () => {
    const initial = initialState(DEFAULT_CONFIG);
    const state = applyMove(initial, { kind: 'PLACE', to: { r: 7, c: 4 } });
    const blackTurn = { ...state, turn: 'BLACK' as const };

    const onWhiteTurn = evalStrategyBonus(
      state,
      DEFAULT_CONFIG,
      'BLACK',
      [CENTER_STRATEGY],
    );
    const onBlackTurn = evalStrategyBonus(
      blackTurn,
      DEFAULT_CONFIG,
      'BLACK',
      [CENTER_STRATEGY],
    );

    expect(onWhiteTurn).toBeGreaterThan(0);
    expect(onWhiteTurn).toBe(onBlackTurn);
  });
});
