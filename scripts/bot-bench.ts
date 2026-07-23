#!/usr/bin/env npx tsx
/**
 * 난이도 헤드투헤드 벤치 (기본: 고수 expert vs 올마이트 allMight)
 * 사용:
 *   npm run bot:bench                     # 빠른 비교 20판
 *   npm run bot:bench -- 40               # 40판
 *   npm run bot:bench -- 20 --scale 0.5   # 제품 노드 예산 비율 조정 (기본 0.25)
 *   npm run bot:bench -- 20 --max-plies 240
 *   npm run bot:bench -- 8 --full         # 실제 프리셋 예산 (느림)
 *   npm run bot:bench -- 20 hard expert   # 대결 조합 지정 (A vs B, B의 승률 표시)
 *   npm run bot:bench -- 2 hard expert --full --trace # 전체 착수 출력
 *
 * 같은 강제 오프닝을 두 번 두되 AI의 흑/백 배정을 바꿔 색 유불리를 상쇄한다.
 * 올마이트는 결정적으로 두고, 낮은 난이도의 제품용 평가 오차는 고정 시드로
 * 재현해 CPU 속도와 실행 순서가 달라져도 같은 대국 조건을 보장한다.
 */
import { DEFAULT_CONFIG } from '../src/core/config';
import { initialState } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import { chooseMove, type AiOptions } from '../src/ai/ai';
import { getBotBrain } from '../src/bot/brain';
import { AI_DIFFICULTY_PRESETS, type AiDifficulty } from '../src/game/settings';
import type { Move, Player } from '../src/core/types';
import { forcedOpeningMove } from '../bot/selfplay/play';

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

const DEFAULT_SCALE = 0.25;
const DEFAULT_MAX_PLIES = 120;

function parseArgs(argv: string[]): {
  games: number;
  full: boolean;
  scale: number;
  maxPlies: number;
  diffA: AiDifficulty;
  diffB: AiDifficulty;
  trace: boolean;
} {
  let games = 20;
  let full = false;
  let scale = DEFAULT_SCALE;
  let maxPlies = DEFAULT_MAX_PLIES;
  const diffs: AiDifficulty[] = [];
  let trace = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--full') {
      full = true;
      continue;
    }
    if (arg === '--trace') {
      trace = true;
      continue;
    }
    if (arg === '--scale') {
      const v = Number.parseFloat(argv[++i] ?? '');
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        console.error('--scale 은 0 초과 1 이하의 숫자여야 합니다.');
        process.exit(1);
      }
      scale = v;
      continue;
    }
    if (arg.startsWith('--scale=')) {
      const v = Number.parseFloat(arg.slice('--scale='.length));
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        console.error('--scale 은 0 초과 1 이하의 숫자여야 합니다.');
        process.exit(1);
      }
      scale = v;
      continue;
    }
    if (arg === '--max-plies') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(v) || v < 40) {
        console.error('--max-plies 은 40 이상 정수여야 합니다.');
        process.exit(1);
      }
      maxPlies = v;
      continue;
    }
    if (arg.startsWith('--max-plies=')) {
      const v = Number.parseInt(arg.slice('--max-plies='.length), 10);
      if (!Number.isFinite(v) || v < 40) {
        console.error('--max-plies 은 40 이상 정수여야 합니다.');
        process.exit(1);
      }
      maxPlies = v;
      continue;
    }
    if (arg in AI_DIFFICULTY_PRESETS) {
      diffs.push(arg as AiDifficulty);
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`알 수 없는 옵션: ${arg}`);
      process.exit(1);
    }
    const n = Number.parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 2) {
      console.error('게임 수는 2 이상의 정수여야 합니다.');
      process.exit(1);
    }
    games = n;
  }
  if (diffs.length > 2) {
    console.error('대결 조합은 최대 2개까지만 지정할 수 있습니다.');
    process.exit(1);
  }
  if (games % 2 !== 0) {
    console.error('공정한 페어 매치를 위해 게임 수는 짝수여야 합니다.');
    process.exit(1);
  }
  return {
    games,
    full,
    scale,
    maxPlies,
    diffA: diffs[0] ?? 'expert',
    diffB: diffs[1] ?? 'allMight',
    trace,
  };
}

function optsFor(
  diff: AiDifficulty,
  full: boolean,
  scale: number,
): AiOptions & { hintScale: number } {
  const p = AI_DIFFICULTY_PRESETS[diff];
  if (full) {
    return {
      maxMs: p.maxMs,
      maxDepth: p.maxDepth,
      maxNodes: p.maxNodes,
      hintScale: p.hintScale ?? 1,
      elite: p.elite ?? false,
      rootNoise: p.rootNoise ?? 0,
      planStrength: p.planStrength ?? 1,
      strategyLevel: p.strategyLevel ?? 1,
    };
  }
  // 양쪽 프리셋에 같은 비율을 적용한 노드 상한으로 시계·CPU 분산을 제거한다.
  // maxMs는 노드 상한에 문제가 있을 때만 작동하는 안전장치다.
  return {
    maxMs: 30_000,
    maxNodes: Math.max(512, Math.round(p.maxNodes * scale)),
    maxDepth: p.maxDepth,
    hintScale: p.hintScale ?? 1,
    elite: p.elite ?? false,
    rootNoise: p.rootNoise ?? 0,
    planStrength: p.planStrength ?? 1,
    strategyLevel: p.strategyLevel ?? 1,
  };
}

function playMatch(
  blackDiff: AiDifficulty,
  whiteDiff: AiDifficulty,
  full: boolean,
  scale: number,
  openingIndex: number,
  maxPlies: number,
): { winner: Player | 'DRAW'; plies: number; reason: string; moves: Move[] } {
  const brain = getBotBrain(DEFAULT_CONFIG);
  let state = initialState(DEFAULT_CONFIG);
  const blackOpts = optsFor(blackDiff, full, scale);
  const whiteOpts = optsFor(whiteDiff, full, scale);
  const blackRng = mulberry32(0x9e3779b9 + openingIndex * 7919);
  const whiteRng = mulberry32(0x85ebca6b + openingIndex * 7919);

  // 서로 다른 합법적 2수 오프닝을 페어마다 강제한다.
  // 각 오프닝은 AI 배정만 바꿔 두 번 두므로 특정 진영 유불리가 상쇄된다.
  for (let ply = 0; ply < 2; ply++) {
    const forced = forcedOpeningMove(state, DEFAULT_CONFIG, openingIndex);
    if (!forced) break;
    state = applyMove(state, forced);
  }

  for (let ply = state.history.length; ply < maxPlies; ply++) {
    const result = getResult(state, DEFAULT_CONFIG);
    if (result) {
      return { winner: result.winner, plies: state.history.length, reason: result.reason, moves: state.history };
    }
    const side = state.turn;
    const o = side === 'BLACK' ? blackOpts : whiteOpts;
    const hints = brain.hintsFor(state, side, o.hintScale);
    const move = chooseMove(state, DEFAULT_CONFIG, {
      maxMs: o.maxMs,
      maxDepth: o.maxDepth,
      maxNodes: o.maxNodes,
      hints,
      botSide: side,
      rng: (o.rootNoise ?? 0) > 0 ? (side === 'BLACK' ? blackRng : whiteRng) : undefined,
      rootNoise: o.rootNoise ?? 0,
      elite: o.elite ?? false,
      planStrength: o.planStrength ?? 1,
      strategyLevel: o.strategyLevel ?? 1,
    });
    if (!move) {
      return { winner: 'DRAW', plies: state.history.length, reason: 'no-move', moves: state.history };
    }
    state = applyMove(state, move);
  }
  return { winner: 'DRAW', plies: state.history.length, reason: 'cap', moves: state.history };
}

const { games, full, scale, maxPlies, diffA, diffB, trace } = parseArgs(process.argv.slice(2));
const aOpts = optsFor(diffA, full, scale);
const bOpts = optsFor(diffB, full, scale);
const budgetText = (name: AiDifficulty, opts: AiOptions & { hintScale: number }) =>
  full
    ? `${name} ${opts.maxMs}ms/d${opts.maxDepth}`
    : `${name} ${opts.maxNodes}n/d${opts.maxDepth}`;

console.log(
  `벤치 ${games}판 (${games / 2}개 페어, ${full ? 'full' : `quick×${scale}`}, ${maxPlies}수 캡) · ${budgetText(diffA, aOpts)} vs ${budgetText(diffB, bOpts)} hint×${bOpts.hintScale}${bOpts.elite ? ' elite' : ''}`,
);

let bWins = 0;
let aWins = 0;
let draws = 0;
const t0 = performance.now();

for (let i = 0; i < games; i++) {
  const bIsBlack = i % 2 === 0;
  const openingIndex = Math.floor(i / 2);
  const black = bIsBlack ? diffB : diffA;
  const white = bIsBlack ? diffA : diffB;
  const out = playMatch(black, white, full, scale, openingIndex, maxPlies);
  if (out.winner === 'DRAW') draws++;
  else if ((out.winner === 'BLACK') === bIsBlack) bWins++;
  else aWins++;
  console.log(
    `[${i + 1}/${games}] opening-${openingIndex + 1} · ${diffB}=${bIsBlack ? 'BLACK' : 'WHITE'} → ${out.winner} (${out.reason}, ${out.plies}수)`,
  );
  if (trace) console.log(JSON.stringify(out.moves));
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
const decided = bWins + aWins;
const decidedRate = decided ? Math.round((bWins / decided) * 100) : 0;
// 무승부는 승리가 아니므로 전체 판수 기준 승률을 판정선으로 사용한다.
const winRate = Math.round((bWins / games) * 100);
console.log(
  `결과: ${diffB} ${bWins} · ${diffA} ${aWins} · draw ${draws} · ${diffB} 승률 ${winRate}% (전체 기준, 결정판만 ${decidedRate}%) · ${elapsed}s`,
);
if (winRate < 90) {
  console.warn(`경고: ${diffB} 승률이 90% 미만입니다. 탐색·전략서를 더 강화하세요.`);
  process.exitCode = 2;
}
