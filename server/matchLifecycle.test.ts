import { describe, expect, it } from 'vitest';
import { hasPlayerTakenTurn } from './matchLifecycle';

describe('대국 연결 종료 판정', () => {
  it('흑은 첫 수를 둔 뒤에만 플레이한 것으로 본다', () => {
    expect(hasPlayerTakenTurn(0, 'BLACK')).toBe(false);
    expect(hasPlayerTakenTurn(1, 'BLACK')).toBe(true);
  });

  it('백은 흑의 첫 수만 진행된 상태에서는 아직 플레이하지 않은 것으로 본다', () => {
    expect(hasPlayerTakenTurn(1, 'WHITE')).toBe(false);
    expect(hasPlayerTakenTurn(2, 'WHITE')).toBe(true);
  });
});
