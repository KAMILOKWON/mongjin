import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState, legalMoves } from '../core/rules';
import { applyMove } from '../core/apply';
import { OpeningBook } from './openingBook';
import { movesEqual } from './moveKey';
import type { StrategyEntry } from '../../bot/learning/types';

const CENTER_OPENING: StrategyEntry[] = [
  {
    id: 'test-center',
    title: 'test',
    phase: 'opening',
    summary: 'test',
    mgnPattern: '1. @e2 @e8 2. @d2 @d8',
    tags: ['center-control'],
    lessons: [],
    sourceGames: [],
    confidence: 0.8,
    updatedAt: '',
  },
];

describe('OpeningBook', () => {
  it('빈 국면에서 흑 선공 오프닝을 추천한다', () => {
    const book = OpeningBook.fromStrategies(CENTER_OPENING, DEFAULT_CONFIG);
    const state = initialState(DEFAULT_CONFIG);
    const move = book.lookup(state, DEFAULT_CONFIG);
    expect(move).not.toBeNull();
    expect(move?.kind).toBe('PLACE');
    expect(move?.kind === 'PLACE' && move.to.r === 7 && move.to.c === 4).toBe(true);
  });

  it('수술 접두사가 맞으면 다음 수를 추천한다', () => {
    const book = OpeningBook.fromStrategies(CENTER_OPENING, DEFAULT_CONFIG);
    let state = initialState(DEFAULT_CONFIG);
    const first = book.lookup(state, DEFAULT_CONFIG)!;
    state = applyMove(state, first);
    const second = book.lookup(state, DEFAULT_CONFIG);
    expect(second).not.toBeNull();
    expect(second?.kind).toBe('PLACE');
  });

  it('오프닝 북 수가 합법 수에 포함되면 chooseMove 경로에서 사용 가능', () => {
    const book = OpeningBook.fromStrategies(CENTER_OPENING, DEFAULT_CONFIG);
    const state = initialState(DEFAULT_CONFIG);
    const bookMove = book.lookup(state, DEFAULT_CONFIG)!;
    const legal = legalMoves(state, DEFAULT_CONFIG);
    expect(legal.some((m) => movesEqual(m, bookMove))).toBe(true);
  });
});
