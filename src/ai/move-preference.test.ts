import { describe, expect, it } from 'vitest';
import { chooseMove } from './ai';
import { DEFAULT_CONFIG } from '../core/config';
import { applyMove } from '../core/apply';
import { getResult } from '../core/result';
import { initialState, positionKey } from '../core/rules';
import type { GameState, Piece, Player } from '../core/types';

const config = DEFAULT_CONFIG;
const budget = { maxMs: 5000, maxNodes: 4000, maxDepth: 4, choiceWindow: 0 };

function position(pieces: Array<[number, number, Player, Piece['type']]>, turn: Player): GameState {
  const state = initialState(config);
  state.board = state.board.map((row) => row.map(() => null));
  for (const [r, c, player, type] of pieces) state.board[r]![c] = { player, type };
  state.turn = turn;
  state.guardsInHand = { BLACK: 1, WHITE: 0 };
  state.positionCounts = { [positionKey(state)]: 1 };
  return state;
}

describe('검증된 수 안에서의 성향 선택', () => {
  it('동급 전진 중 선호 방향을 선택하지만 낮게 평가된 호위 배치는 후보로 끌어올리지 않는다', () => {
    const state = initialState(config);
    const flank = chooseMove(state, config, {
      ...budget, movePreference: (_s, move) => move.to.c === 3 ? 1 : 0,
    });
    expect(flank).toEqual({ kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 3 } });
    const guard = chooseMove(state, config, {
      ...budget, movePreference: (_s, move) => move.kind === 'PLACE' ? 1 : 0,
    });
    expect(guard?.kind).toBe('MOVE');
    expect(guard?.to.r).toBe(7);
  });

  it('다른 수를 선호해도 즉시 승리를 놓치지 않는다', () => {
    const state = position([[7, 4, 'WHITE', 'KING'], [0, 0, 'BLACK', 'KING']], 'WHITE');
    const selected = chooseMove(state, config, {
      ...budget, movePreference: (_s, move) => move.to.r < 8 ? 1 : 0,
    })!;
    expect(getResult(applyMove(state, selected), config)?.winner).toBe('WHITE');
  });

  it('성향과 무작위 선택이 유일한 즉시 패배 방어를 덮어쓰지 않는다', () => {
    const state = position([[7, 3, 'BLACK', 'KING'], [7, 2, 'WHITE', 'KING']], 'BLACK');
    for (const rng of [() => 0, () => 0.999]) {
      const selected = chooseMove(state, config, {
        ...budget, maxDepth: 1, rng,
        movePreference: (_s, move) => move.kind === 'PLACE' ? 1 : 0,
      });
      expect(selected).toEqual({ kind: 'MOVE', from: { r: 7, c: 3 }, to: { r: 8, c: 3 } });
    }
  });

  it('선호도를 주지 않거나 유효하지 않은 선호도를 주면 기존 선택을 유지한다', () => {
    const state = initialState(config);
    const options = { ...budget, rng: () => 0.6 };
    const baseline = chooseMove(state, config, options);
    expect(chooseMove(state, config, { ...options, movePreference: () => NaN })).toEqual(baseline);
    expect(chooseMove(state, config, { ...options, movePreference: () => 0 })).toEqual(baseline);
  });
});
