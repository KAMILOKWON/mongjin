#!/usr/bin/env npx tsx
/**
 * 캡 무승부 진단: 1판을 두면서 위치 반복·왕 진행 정체를 기록한다.
 * 사용: npx tsx scripts/diag-draw.ts [scale=0.18] [gameIndex=0]
 */
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState, findKing, goalRow, positionKey } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { chooseMove } from '../src/ai/ai';
import { getBotBrain } from '../src/bot/brain';
import { AI_DIFFICULTY_PRESETS, type AiDifficulty } from '../src/game/settings';
import type { GameState, Player } from '../src/core/types';

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

function optsFor(diff: AiDifficulty, scale: number) {
  const p = AI_DIFFICULTY_PRESETS[diff];
  return {
    maxMs: Math.max(200, Math.round(p.maxMs * scale)),
    maxDepth: Math.max(8, Math.round(p.maxDepth * scale * 2.2)),
    hintScale: p.hintScale ?? 1,
    elite: p.elite ?? false,
  };
}

function progress(state: GameState, p: Player): string {
  const k = findKing(state, p);
  if (!k) return `${p}:captured`;
  const g = goalRow(p, state.board.length);
  return `${p}:행거리${Math.abs(g - k.r)} 열${k.c}`;
}

const scale = Number.parseFloat(process.argv[2] ?? '0.18');
const gameIndex = Number.parseInt(process.argv[3] ?? '0', 10);
const diffA: AiDifficulty = 'normal';
const diffB: AiDifficulty = 'hard';
const brain = getBotBrain(DEFAULT_CONFIG);
let state = initialState(DEFAULT_CONFIG);
const blackOpts = optsFor(diffB, scale); // hard = BLACK
const whiteOpts = optsFor(diffA, scale);
const rng = mulberry32(0x9e3779b9 + gameIndex * 7919);
const seen = new Map<string, number>();
let winner: Player | 'DRAW' = 'DRAW';
let reason = 'cap';

for (let ply = 0; ply < 400; ply++) {
  const result = getResult(state, DEFAULT_CONFIG);
  if (result) {
    winner = result.winner;
    reason = result.reason;
    break;
  }
  const key = positionKey(state);
  seen.set(key, (seen.get(key) ?? 0) + 1);
  if (ply % 20 === 0) {
    console.log(
      `ply ${ply} · ${progress(state, 'BLACK')} · ${progress(state, 'WHITE')} · 호위 B${state.guardsInHand.BLACK}+보드 / W${state.guardsInHand.WHITE}+보드`,
    );
  }
  const side = state.turn;
  const o = side === 'BLACK' ? blackOpts : whiteOpts;
  const hints = brain.hintsFor(state, side, o.hintScale);
  const move = chooseMove(state, DEFAULT_CONFIG, {
    maxMs: o.maxMs,
    maxDepth: o.maxDepth,
    hints,
    botSide: side,
    rng,
    rootNoise: 30,
    elite: o.elite,
  });
  if (!move) {
    winner = 'DRAW';
    reason = 'no-move';
    break;
  }
  state = applyMove(state, move);
}

const repeated = [...seen.values()].filter((c) => c >= 2).length;
const maxRepeat = Math.max(0, ...seen.values());
console.log(
  `결과: ${winner} (${reason}, ${state.history.length}수) · 반복 위치 ${repeated}종 · 최대 반복 ${maxRepeat}회`,
);
console.log('최종 보드:');
for (const row of state.board) {
  console.log(
    row
      .map((cell) =>
        cell
          ? cell.type === 'KING'
            ? cell.player === 'BLACK'
              ? 'K'
              : 'k'
            : cell.player === 'BLACK'
              ? 'G'
              : 'g'
          : '.',
      )
      .join(' '),
  );
}
