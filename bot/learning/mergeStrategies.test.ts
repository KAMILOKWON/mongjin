import { describe, expect, it } from 'vitest';
import { mergeStrategies } from './mergeStrategies';
import type { StrategyEntry } from './types';

function entry(partial: Partial<StrategyEntry> & Pick<StrategyEntry, 'id' | 'mgnPattern'>): StrategyEntry {
  return {
    title: partial.title ?? partial.id,
    phase: partial.phase ?? 'opening',
    summary: partial.summary ?? '',
    tags: partial.tags ?? ['selfplay'],
    lessons: partial.lessons ?? [],
    sourceGames: partial.sourceGames ?? [],
    confidence: partial.confidence ?? 0.6,
    updatedAt: partial.updatedAt ?? '2026-07-19T00:00:00.000Z',
    ...partial,
  };
}

describe('mergeStrategies', () => {
  it('같은 패턴은 confidence와 근거 기보를 누적한다', () => {
    const prev = [
      entry({
        id: 'a',
        mgnPattern: '1. Ke1-e2 @e8',
        confidence: 0.7,
        sourceGames: ['g1', 'g2'],
      }),
    ];
    const next = [
      entry({
        id: 'b',
        mgnPattern: '1. Ke1-e2 @e8',
        confidence: 0.8,
        sourceGames: ['g3'],
        updatedAt: '2026-07-19T12:00:00.000Z',
      }),
      entry({
        id: 'c',
        mgnPattern: '1. Ke1-d2 @d8',
        confidence: 0.65,
        sourceGames: ['g4'],
      }),
    ];

    const merged = mergeStrategies(prev, next);
    expect(merged).toHaveLength(2);
    const shared = merged.find((s) => s.mgnPattern === '1. Ke1-e2 @e8')!;
    expect(shared.sourceGames).toEqual(expect.arrayContaining(['g1', 'g2', 'g3']));
    expect(shared.confidence).toBeGreaterThan(0.8);
  });
});
