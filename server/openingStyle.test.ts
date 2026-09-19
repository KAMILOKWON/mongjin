import { describe, expect, it } from 'vitest';
import { chooseMove } from '../src/ai/ai';
import { DEFAULT_CONFIG } from '../src/core/config';
import { applyMove } from '../src/core/apply';
import { initialState, legalMoves, opponent } from '../src/core/rules';
import { getResult } from '../src/core/result';
import type { GameState, Move, Player } from '../src/core/types';
import { openingMovePreference, type OpeningStyle } from './openingStyle';

const config = DEFAULT_CONFIG;
const styles: OpeningStyle[] = ['runner', 'guardian', 'wanderer', 'tactician'];
const budget = { maxMs: 5000, maxNodes: 4000, maxDepth: 4, strategyLevel: 2 as const, choiceWindow: 48 };

function choose(state: GameState, style: OpeningStyle, lane: -1 | 1 = 1) {
  return chooseMove(state, config, {
    ...budget,
    movePreference: (root, move) => openingMovePreference(root, move, config, state.turn, style, lane),
  })!;
}

function replay(moves: Move[]) {
  return moves.reduce((state, move) => {
    expect(legalMoves(state, config)).toContainEqual(move);
    return applyMove(state, move);
  }, initialState(config));
}

function rotate(state: GameState): GameState {
  const side = (player: Player) => opponent(player);
  return {
    ...state,
    board: [...state.board].reverse().map((row) => row.map((piece) => piece ? { ...piece, player: side(piece.player) } : null)),
    turn: side(state.turn),
    guardsInHand: { BLACK: state.guardsInHand.WHITE, WHITE: state.guardsInHand.BLACK },
    positionCounts: {},
  };
}

describe('랭크 봇의 초반 계획', () => {
  it('왕 진출형과 좌우 측면형의 실제 첫 선택이 다르고 양 진영에서 같은 방향성을 유지한다', () => {
    for (const state of [initialState(config), rotate(initialState(config))]) {
      const forwardRow = state.turn === 'BLACK' ? 7 : 1;
      expect(choose(state, 'runner').to).toEqual({ r: forwardRow, c: 4 });
      expect(choose(state, 'wanderer', -1).to).toEqual({ r: forwardRow, c: 3 });
      expect(choose(state, 'wanderer', 1).to).toEqual({ r: forwardRow, c: 5 });
    }
  });

  it('운영 기보의 호위 전개 국면에서 호위형은 호위를, 진출형은 왕 전진을 선택한다', () => {
    // 익명화한 합법 초반 수순. 한 사람의 선택을 정답으로 학습시키는 픽스처는 아니다.
    const state = replay([
      { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 4 } },
      { kind: 'PLACE', to: { r: 1, c: 4 } },
      { kind: 'MOVE', from: { r: 7, c: 4 }, to: { r: 6, c: 3 } },
      { kind: 'PLACE', to: { r: 2, c: 4 } },
      { kind: 'MOVE', from: { r: 6, c: 3 }, to: { r: 5, c: 2 } },
      { kind: 'PLACE', to: { r: 3, c: 4 } },
    ]);
    expect(choose(state, 'guardian')).toEqual({ kind: 'PLACE', to: { r: 4, c: 2 } });
    expect(choose(state, 'runner').kind).toBe('MOVE');
    for (const style of styles) {
      const move = choose(state, style);
      expect(legalMoves(state, config)).toContainEqual(move);
      const next = applyMove(state, move);
      expect(legalMoves(next, config).some((reply) => getResult(applyMove(next, reply), config)?.winner === 'WHITE')).toBe(false);
    }
  });

  it('초반이 끝나면 성향 설정 없이 탐색한 선택으로 돌아온다', () => {
    let state = initialState(config);
    for (let i = 0; i < 12; i++) state = applyMove(state, chooseMove(state, config, budget)!);
    const baseline = chooseMove(state, config, budget);
    for (const style of styles) expect(choose(state, style)).toEqual(baseline);
  }, 15_000);
});
