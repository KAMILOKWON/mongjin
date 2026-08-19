import { describe, expect, it } from 'vitest';
import { AI_DIFFICULTY_PRESETS, opponentOf, resolveHumanSide } from './settings';

describe('settings', () => {
  it('resolveHumanSide respects fixed choice', () => {
    expect(resolveHumanSide('BLACK')).toBe('BLACK');
    expect(resolveHumanSide('WHITE')).toBe('WHITE');
  });

  it('resolveHumanSide random uses injected rng', () => {
    expect(resolveHumanSide('random', () => 0.1)).toBe('BLACK');
    expect(resolveHumanSide('random', () => 0.9)).toBe('WHITE');
  });

  it('opponentOf', () => {
    expect(opponentOf('BLACK')).toBe('WHITE');
    expect(opponentOf('WHITE')).toBe('BLACK');
  });

  it('난이도가 정확히 3단계다', () => {
    expect(Object.keys(AI_DIFFICULTY_PRESETS)).toEqual(['easy', 'normal', 'hard']);
  });

  it('난이도가 높을수록 더 많이 탐색한다', () => {
    expect(AI_DIFFICULTY_PRESETS.normal.maxMs).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.easy.maxMs,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.maxDepth).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.maxDepth,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.maxMs).toBeGreaterThanOrEqual(
      AI_DIFFICULTY_PRESETS.normal.maxMs,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.maxNodes).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.easy.maxNodes,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.maxNodes).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.maxNodes,
    );
    expect(AI_DIFFICULTY_PRESETS.easy.choiceWindow).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.choiceWindow,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.choiceWindow).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.choiceWindow,
    );
    expect(AI_DIFFICULTY_PRESETS.easy.rootNoise).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.rootNoise!,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.rootNoise).toBeGreaterThanOrEqual(
      AI_DIFFICULTY_PRESETS.hard.rootNoise!,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.planStrength).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.easy.planStrength!,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.planStrength).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.planStrength!,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.strategyLevel).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.easy.strategyLevel!,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.strategyLevel).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.strategyLevel!,
    );
  });

  it('어려움은 5초 안에서 최고 전략과 큰 탐색 예산을 사용한다', () => {
    expect(AI_DIFFICULTY_PRESETS.hard.maxMs).toBeLessThan(5_000);
    expect(AI_DIFFICULTY_PRESETS.hard.maxDepth).toBeGreaterThanOrEqual(12);
    expect(AI_DIFFICULTY_PRESETS.hard.maxNodes).toBeGreaterThanOrEqual(80_000);
    expect(AI_DIFFICULTY_PRESETS.hard.choiceWindow).toBeLessThanOrEqual(2);
    expect(AI_DIFFICULTY_PRESETS.hard.strategyLevel).toBe(3);
    expect(AI_DIFFICULTY_PRESETS.hard.elite).toBe(true);
  });
});
