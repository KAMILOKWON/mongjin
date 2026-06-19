import { describe, expect, it } from 'vitest';
import type { GameState, Piece, Player } from '../core/types';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState, legalMoves, positionKey } from '../core/rules';
import { applyMove } from '../core/apply';
import { getResult } from '../core/result';
import { chooseMove } from './ai';

const CFG = { ...DEFAULT_CONFIG };

function makeState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  hands: { BLACK: number; WHITE: number },
): GameState {
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => null),
  );
  for (const [r, c, player, type] of pieces) board[r][c] = { player, type };
  const state: GameState = { board, turn, guardsInHand: { ...hands }, history: [], positionCounts: {} };
  state.positionCounts[positionKey(state)] = 1;
  return state;
}

describe('AI (미니맥스)', () => {
  it('초기 국면에서 합법 수를 둔다', () => {
    const s = initialState(CFG);
    const m = chooseMove(s, CFG, { maxMs: 500, maxDepth: 6 });
    expect(m).not.toBeNull();
    const legal = legalMoves(s, CFG).some((x) => JSON.stringify(x) === JSON.stringify(m));
    expect(legal).toBe(true);
  });

  it('한 수 승리(목적지 진입)를 놓치지 않는다', () => {
    // 백 왕이 e2 — d1/e1/f1 진입 즉시 승리
    const s = makeState(
      [
        [7, 4, 'WHITE', 'KING'],
        [0, 0, 'BLACK', 'KING'],
      ],
      'WHITE',
      { BLACK: 0, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 300, maxDepth: 8 })!;
    const next = applyMove(s, m);
    expect(getResult(next, CFG)).toEqual({ winner: 'WHITE', reason: 'goal' });
  });

  it('한 수 포위 승리(외통수)를 찾는다', () => {
    // 흑 왕 a9 구석: (0,1)에 백 호위, (2,0)의 백 호위가 (1,0)으로 가면 포위 완성
    const s = makeState(
      [
        [0, 0, 'BLACK', 'KING'],
        [0, 1, 'WHITE', 'GUARD'],
        [2, 0, 'WHITE', 'GUARD'],
        [5, 8, 'WHITE', 'KING'],
      ],
      'WHITE',
      { BLACK: 0, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 300, maxDepth: 8 })!;
    const next = applyMove(s, m);
    // 왕 잡기 규칙상 (0,1) 호위가 왕을 바로 잡는 것도 정답 — 어느 쪽이든 한 수 승리
    const result = getResult(next, CFG);
    expect(result?.winner).toBe('WHITE');
    expect(['surround', 'capture']).toContain(result?.reason);
  });

  it('시간 한도 내에 응답한다', () => {
    const s = initialState(CFG);
    const t0 = performance.now();
    chooseMove(s, CFG, { maxMs: 200, maxDepth: 12 });
    expect(performance.now() - t0).toBeLessThan(900);
  });

  it('방치된 호위 잡기를 놓치지 않는다', () => {
    const s = makeState(
      [
        [4, 4, 'BLACK', 'GUARD'],
        [5, 4, 'WHITE', 'GUARD'],
        [8, 4, 'BLACK', 'KING'],
        [0, 4, 'WHITE', 'KING'],
      ],
      'WHITE',
      { BLACK: 0, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 100, maxDepth: 4 })!;
    expect(m.kind).toBe('MOVE');
    expect(m.to).toEqual({ r: 4, c: 4 });
  });

  it('왕 인접 잡기 한 수 승리를 놓치지 않는다', () => {
    const s = makeState(
      [
        [4, 4, 'BLACK', 'KING'],
        [5, 4, 'WHITE', 'GUARD'],
        [0, 4, 'WHITE', 'KING'],
      ],
      'WHITE',
      { BLACK: 0, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 100, maxDepth: 4 })!;
    const next = applyMove(s, m);
    expect(getResult(next, CFG)?.winner).toBe('WHITE');
    expect(getResult(next, CFG)?.reason).toBe('capture');
  });
});
