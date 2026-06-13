import { describe, expect, it } from 'vitest';
import { opponentOf, resolveHumanSide } from './settings';

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
});
