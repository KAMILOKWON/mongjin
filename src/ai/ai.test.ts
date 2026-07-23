import { describe, expect, it } from 'vitest';
import type { GameState, Move, Piece, Player } from '../core/types';
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
  const state: GameState = {
    board,
    turn,
    guardsInHand: { ...hands },
    history: [],
    positionCounts: {},
  };
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

  it('다른 합법 수가 있으면 세 번째 동형 국면을 만드는 수를 피한다', () => {
    const s = makeState(
      [
        [8, 4, 'BLACK', 'KING'],
        [0, 4, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const moves = legalMoves(s, CFG);
    const allowed = moves[0]!;
    for (const move of moves.slice(1)) {
      const next = applyMove(s, move);
      s.positionCounts[positionKey(next)] = 2;
    }

    const chosen = chooseMove(s, CFG, { maxMs: 100, maxDepth: 4 });
    expect(chosen).toEqual(allowed);
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

  it('벤치용 노드 상한을 지킨다', () => {
    const s = initialState(CFG);
    let stats: { nodes: number; aborted: boolean } | null = null;
    chooseMove(s, CFG, {
      maxMs: 5_000,
      maxDepth: 32,
      maxNodes: 512,
      onSearchComplete: (out) => {
        stats = out;
      },
    });
    expect(stats).not.toBeNull();
    expect(stats!.nodes).toBe(512);
    expect(stats!.aborted).toBe(true);
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

  it('상대 왕이 가만히 있으면 호위로 거리를 좁혀 공격한다', () => {
    // 백 왕이 목적지 쪽으로 움직이지 않는 상황. 흑 호위는 한 칸 전진하면
    // 다음 수에 왕을 잡을 수 있으므로 자기 왕의 단순 전진보다 추격을 택해야 한다.
    const s = makeState(
      [
        [8, 8, 'BLACK', 'KING'],
        [3, 4, 'WHITE', 'KING'],
        [5, 4, 'BLACK', 'GUARD'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 500, maxDepth: 4, maxNodes: 2_000 });
    expect(m).toEqual({
      kind: 'MOVE',
      from: { r: 5, c: 4 },
      to: { r: 4, c: 4 },
    });
  });

  it('기보의 왕 정지 횟수가 탐색 최선수를 강제로 덮어쓰지 않는다', () => {
    let s = initialState(CFG);
    const setup: Move[] = [
      { kind: 'PLACE', to: { r: 7, c: 4 } },
      { kind: 'PLACE', to: { r: 1, c: 4 } },
      { kind: 'MOVE', from: { r: 7, c: 4 }, to: { r: 7, c: 3 } },
      { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 2, c: 4 } },
      { kind: 'MOVE', from: { r: 7, c: 3 }, to: { r: 7, c: 4 } },
    ];
    for (const move of setup) s = applyMove(s, move);

    const hardOpts = {
      maxMs: 5_000,
      maxDepth: 5,
      maxNodes: 5_000,
    };
    const withStationaryHistory = chooseMove(s, CFG, hardOpts);
    const withoutHistory = chooseMove({ ...s, history: [] }, CFG, hardOpts);

    expect(withStationaryHistory).toEqual(withoutHistory);
    expect(withStationaryHistory).not.toEqual({
      kind: 'MOVE',
      from: { r: 2, c: 4 },
      to: { r: 3, c: 4 },
    });
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

  it('상대의 즉시 승리를 막을 수 있으면 자살수를 두지 않는다', () => {
    // 백 왕(c2)은 다음 수 d1에 도달한다. 흑 왕이 d1을 선점해야만 방어된다.
    const s = makeState(
      [
        [7, 3, 'BLACK', 'KING'],
        [7, 2, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 1, WHITE: 0 },
    );
    const m = chooseMove(s, CFG, { maxMs: 80, maxDepth: 1 })!;
    expect(m).toEqual({ kind: 'MOVE', from: { r: 7, c: 3 }, to: { r: 8, c: 3 } });
  });
});
