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

  it('난이도가 높을수록 더 많이 탐색한다', () => {
    expect(AI_DIFFICULTY_PRESETS.hard.maxMs).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.maxMs,
    );
    expect(AI_DIFFICULTY_PRESETS.expert.maxDepth).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.maxDepth,
    );
    expect(AI_DIFFICULTY_PRESETS.allMight.maxMs).toBeGreaterThanOrEqual(
      AI_DIFFICULTY_PRESETS.expert.maxMs,
    );
    expect(AI_DIFFICULTY_PRESETS.allMight.maxDepth).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.expert.maxDepth,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.maxNodes).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.maxNodes,
    );
    expect(AI_DIFFICULTY_PRESETS.expert.maxNodes).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.maxNodes,
    );
    expect(AI_DIFFICULTY_PRESETS.allMight.maxNodes).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.expert.maxNodes,
    );
    expect(AI_DIFFICULTY_PRESETS.normal.maxNodes).toBeGreaterThanOrEqual(700);
    expect(AI_DIFFICULTY_PRESETS.hard.maxNodes).toBeGreaterThanOrEqual(2_250);
    expect(AI_DIFFICULTY_PRESETS.expert.maxNodes).toBeGreaterThanOrEqual(6_000);
    expect(AI_DIFFICULTY_PRESETS.normal.rootNoise).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.rootNoise!,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.rootNoise).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.expert.rootNoise!,
    );
    expect(AI_DIFFICULTY_PRESETS.expert.rootNoise).toBeGreaterThanOrEqual(
      AI_DIFFICULTY_PRESETS.allMight.rootNoise!,
    );
    expect(AI_DIFFICULTY_PRESETS.hard.planStrength).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.normal.planStrength!,
    );
    expect(AI_DIFFICULTY_PRESETS.expert.planStrength).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.planStrength!,
    );
    expect(AI_DIFFICULTY_PRESETS.allMight.planStrength).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.expert.planStrength!,
    );
    expect(AI_DIFFICULTY_PRESETS.expert.strategyLevel).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.hard.strategyLevel!,
    );
    expect(AI_DIFFICULTY_PRESETS.allMight.strategyLevel).toBeGreaterThan(
      AI_DIFFICULTY_PRESETS.expert.strategyLevel!,
    );
  });

  it('올마이트는 3초 예산에서 최고 전략 평가와 깊이 9를 사용한다', () => {
    expect(AI_DIFFICULTY_PRESETS.allMight.maxMs).toBeLessThanOrEqual(3_000);
    expect(AI_DIFFICULTY_PRESETS.allMight.maxDepth).toBe(9);
    expect(AI_DIFFICULTY_PRESETS.allMight.maxNodes).toBe(12_000);
    expect(AI_DIFFICULTY_PRESETS.allMight.strategyLevel).toBe(3);
    expect(AI_DIFFICULTY_PRESETS.allMight.elite).toBe(true);
  });
});
