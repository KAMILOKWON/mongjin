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
  });
});
