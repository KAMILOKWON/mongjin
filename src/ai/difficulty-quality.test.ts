import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../core/config';
import { DEFAULT_CONFIG } from '../core/config';
import { applyMove } from '../core/apply';
import { getResult } from '../core/result';
import { legalMoves, positionKey } from '../core/rules';
import type { GameState, Move, Piece, Player } from '../core/types';
import {
  AI_DIFFICULTY_PRESETS,
} from '../game/settings';
import { chooseMove, type AiOptions } from './ai';
import { captureSwing } from './tactics';

const CFG = { ...DEFAULT_CONFIG };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  turn: Player,
  hands: Record<Player, number> = { BLACK: 0, WHITE: 0 },
  config: RuleConfig = CFG,
): GameState {
  const board: (Piece | null)[][] = Array.from(
    { length: config.boardSize },
    () => Array.from({ length: config.boardSize }, () => null),
  );
  for (const [r, c, player, type] of pieces) {
    board[r]![c] = { player, type };
  }
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

function moveKey(move: Move | null): string {
  return JSON.stringify(move);
}

describe('AI 난이도 품질 계약', () => {
  it('세 프리셋은 모두 5초 이내이며 시간·노드·깊이 예산이 엄격히 분리된다', () => {
    const easy = AI_DIFFICULTY_PRESETS.easy;
    const normal = AI_DIFFICULTY_PRESETS.normal;
    const hard = AI_DIFFICULTY_PRESETS.hard;
    const presets = [easy, normal, hard];

    for (const preset of presets) {
      expect(preset.maxMs).toBeGreaterThan(0);
      expect(preset.maxMs).toBeLessThanOrEqual(5_000);
      expect(preset.maxNodes).toBeGreaterThan(0);
      expect(preset.maxDepth).toBeGreaterThan(0);
      expect(preset.choiceWindow).toEqual(expect.any(Number));
      expect(preset.choiceWindow).toBeGreaterThanOrEqual(0);
    }

    expect(easy.maxMs).toBeLessThan(normal.maxMs);
    expect(normal.maxMs).toBeLessThan(hard.maxMs);
    expect(easy.maxNodes).toBeLessThan(normal.maxNodes);
    expect(normal.maxNodes).toBeLessThan(hard.maxNodes);
    expect(easy.maxDepth).toBeLessThan(normal.maxDepth);
    expect(normal.maxDepth).toBeLessThan(hard.maxDepth);
  });

  it('같은 seed는 같은 수를 고르고, 동급 최선수는 seed에 따라 달라질 수 있다', () => {
    const smallCfg: RuleConfig = { ...CFG, boardSize: 3 };
    // 좌우 대칭인 전진 수들이 같은 평가를 받는 국면이다.
    const state = makeState(
      [
        [2, 1, 'BLACK', 'KING'],
        [0, 1, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 0, WHITE: 0 },
      smallCfg,
    );
    const optionsFor = (seed: number): AiOptions => ({
      maxMs: 500,
      maxDepth: 2,
      maxNodes: 2_000,
      rootNoise: 0,
      planStrength: 1,
      choiceWindow: 0,
      rng: mulberry32(seed),
    });

    const first = chooseMove(state, smallCfg, optionsFor(17));
    const replay = chooseMove(state, smallCfg, optionsFor(17));
    expect(replay).toEqual(first);

    const choices = new Set(
      Array.from({ length: 16 }, (_, seed) =>
        moveKey(chooseMove(state, smallCfg, optionsFor(seed + 1))),
      ),
    );
    expect(choices.size).toBeGreaterThan(1);
    for (const serialized of choices) {
      const move = JSON.parse(serialized) as Move;
      expect(move).toMatchObject({
        kind: 'MOVE',
        from: { r: 2, c: 1 },
        to: { r: 1 },
      });
    }
  });

  it('깊게 탐색한 왕 전진을 단순 +3 호위 캡처 후처리가 덮어쓰지 않는다', () => {
    const state = makeState(
      [
        [4, 4, 'BLACK', 'KING'],
        [6, 0, 'BLACK', 'GUARD'],
        [3, 4, 'WHITE', 'KING'],
        [5, 0, 'WHITE', 'GUARD'],
      ],
      'BLACK',
    );
    const materialCapture: Move = {
      kind: 'MOVE',
      from: { r: 6, c: 0 },
      to: { r: 5, c: 0 },
    };
    expect(captureSwing(state, materialCapture, CFG)).toBe(3);

    let completedDepth = 0;
    const move = chooseMove(state, CFG, {
      maxMs: 1_000,
      maxDepth: 4,
      maxNodes: 4_000,
      planStrength: 1.7,
      strategyLevel: 3,
      elite: true,
      onSearchComplete: (value) => {
        completedDepth = value.completedDepth;
      },
    });

    expect(completedDepth).toBeGreaterThan(1);
    expect(move?.kind).toBe('MOVE');
    if (move?.kind === 'MOVE') {
      expect(move.from).toEqual({ r: 4, c: 4 });
      expect(move.to.r).toBeLessThan(move.from.r);
    }
  });

  it('즉시 승리를 항상 선택한다', () => {
    const state = makeState(
      [
        [1, 4, 'BLACK', 'KING'],
        [7, 4, 'WHITE', 'KING'],
      ],
      'BLACK',
    );
    const move = chooseMove(state, CFG, {
      maxMs: 50,
      maxDepth: 1,
      maxNodes: 16,
      rootNoise: 100,
      choiceWindow: 100,
      rng: mulberry32(1),
    });

    expect(move).not.toBeNull();
    expect(getResult(applyMove(state, move!), CFG)?.winner).toBe('BLACK');
  });

  it('즉시 패배를 피할 합법 수가 하나라도 있으면 그 수를 선택한다', () => {
    // 백 왕은 다음 수 d9에 도달한다. 흑 왕의 d9 선점만 이를 막는다.
    const state = makeState(
      [
        [7, 3, 'BLACK', 'KING'],
        [7, 2, 'WHITE', 'KING'],
      ],
      'BLACK',
      { BLACK: 1, WHITE: 0 },
    );
    const move = chooseMove(state, CFG, {
      maxMs: 50,
      maxDepth: 1,
      maxNodes: 32,
      rootNoise: 100,
      choiceWindow: 100,
      rng: mulberry32(2),
    });

    expect(move).toEqual({
      kind: 'MOVE',
      from: { r: 7, c: 3 },
      to: { r: 8, c: 3 },
    });
    const replyWins = legalMoves(applyMove(state, move!), CFG).filter((reply) => {
      const result = getResult(applyMove(applyMove(state, move!), reply), CFG);
      return result?.winner === 'WHITE';
    });
    expect(replyWins).toHaveLength(0);
  });
});
