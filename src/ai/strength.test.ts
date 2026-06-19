import { describe, expect, it } from 'vitest';
import type { GameState, Move, Player } from '../core/types';
import { DEFAULT_CONFIG } from '../core/config';
import { findKing, goalCellsFor, initialState, legalMoves } from '../core/rules';
import { applyMove } from '../core/apply';
import { getResult } from '../core/result';
import { chooseMove } from './ai';

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

/** 사용자가 발견했던 필승 전략: 왕 단독 돌진 (호위 미사용) */
function rushBot(state: GameState, rand: () => number): Move {
  const moves = legalMoves(state, CFG);
  const me = state.turn;
  const king = findKing(state, me)!;
  const goals = goalCellsFor(me, CFG);
  const dist = (r: number, c: number) =>
    Math.min(...goals.map((g) => Math.max(Math.abs(g.r - r), Math.abs(g.c - c))));
  const kingMoves = moves.filter(
    (m): m is Extract<Move, { kind: 'MOVE' }> =>
      m.kind === 'MOVE' && m.from.r === king.r && m.from.c === king.c,
  );
  if (kingMoves.length) {
    const best = Math.min(...kingMoves.map((m) => dist(m.to.r, m.to.c)));
    const bests = kingMoves.filter((m) => dist(m.to.r, m.to.c) === best);
    return bests[Math.floor(rand() * bests.length)];
  }
  return moves[Math.floor(rand() * moves.length)];
}

function randomBot(state: GameState, rand: () => number): Move {
  const moves = legalMoves(state, CFG);
  return moves[Math.floor(rand() * moves.length)];
}

function playMatch(
  aiSide: Player,
  bot: (s: GameState, rand: () => number) => Move,
  rand: () => number,
  maxPlies = 400,
): Player | 'cap' {
  let state = initialState(CFG);
  for (let ply = 0; ply < maxPlies; ply++) {
    const result = getResult(state, CFG);
    if (result) return result.winner;
    const move =
      state.turn === aiSide
        ? chooseMove(state, CFG, { maxMs: 200, maxDepth: 8 })!
        : bot(state, rand);
    state = applyMove(state, move);
  }
  return 'cap';
}

describe('AI 강함 회귀 테스트', () => {
  it(
    '백 AI는 "왕 단독 돌진" 전략을 3판 중 2판 이상 응징한다',
    () => {
      const rand = mulberry32(42);
      let wins = 0;
      for (let g = 0; g < 3; g++) {
        if (playMatch('WHITE', rushBot, rand) === 'WHITE') wins++;
      }
      expect(wins).toBeGreaterThanOrEqual(2);
    },
    30_000,
  );

  it(
    '흑 AI는 무작위 봇을 3판 중 2판 이상 이긴다',
    () => {
      const rand = mulberry32(7);
      let wins = 0;
      for (let g = 0; g < 3; g++) {
        if (playMatch('BLACK', randomBot, rand) === 'BLACK') wins++;
      }
      expect(wins).toBeGreaterThanOrEqual(2);
    },
    90_000,
  );
});
