import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState } from '../core/rules';
import { chooseMove, DEFAULT_AI_OPTIONS } from './ai';
import * as tactics from './tactics';

const CFG = { ...DEFAULT_CONFIG };

describe('전술 레이어 부작용', () => {
  it('깊은 탐색 후에는 pickObviousMove 폴백을 호출하지 않는다', () => {
    const spy = vi.spyOn(tactics, 'pickObviousMove');
    chooseMove(initialState(CFG), CFG, DEFAULT_AI_OPTIONS);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBe(0);
  }, 30_000);
});
