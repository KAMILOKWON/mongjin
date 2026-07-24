import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { initialState } from '../../src/core/rules';
import { applyMove } from '../../src/core/apply';
import {
  forcedOpeningMove,
  playAiVsAi,
  SELFPLAY_AI_OPTIONS,
  SELFPLAY_STRONG_AI_OPTIONS,
  selfPlayOptionsFor,
} from './play';
import { extractStrategies } from '../learning/extractStrategies';
import { parseGame } from '../mgn/format';
import generated from '../strategies/generated.json';
import type { StrategyEntry } from '../learning/types';

const SELFPLAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '../games/selfplay');

function loadAllSelfPlayGames() {
  const files = readdirSync(SELFPLAY_DIR).filter((f) => f.endsWith('.mgn'));
  return files.map((f) => parseGame(readFileSync(join(SELFPLAY_DIR, f), 'utf8')));
}

describe('셀프플레이', () => {
  it('strong 프리셋이 fast보다 깊게 탐색한다', () => {
    expect(SELFPLAY_STRONG_AI_OPTIONS.maxMs).toBeGreaterThan(SELFPLAY_AI_OPTIONS.maxMs!);
    expect(SELFPLAY_STRONG_AI_OPTIONS.maxDepth).toBeGreaterThan(SELFPLAY_AI_OPTIONS.maxDepth!);
    expect(SELFPLAY_STRONG_AI_OPTIONS.strategyLevel).toBe(3);
    expect(SELFPLAY_STRONG_AI_OPTIONS.elite).toBe(true);
    expect(selfPlayOptionsFor('strong').maxMs).toBe(SELFPLAY_STRONG_AI_OPTIONS.maxMs);
    expect(selfPlayOptionsFor('fast').maxMs).toBe(SELFPLAY_AI_OPTIONS.maxMs);
  });

  it('게임 인덱스가 다르면 초반 수가 갈라진다', () => {
    const state = initialState(DEFAULT_CONFIG);
    const a = forcedOpeningMove(state, DEFAULT_CONFIG, 0);
    const b = forcedOpeningMove(state, DEFAULT_CONFIG, 1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const a0 = a!;
    const b0 = b!;
    const sameFirst =
      a0.kind === b0.kind &&
      a0.to.r === b0.to.r &&
      a0.to.c === b0.to.c &&
      (a0.kind === 'PLACE' ||
        (b0.kind === 'MOVE' &&
          a0.kind === 'MOVE' &&
          a0.from.r === b0.from.r &&
          a0.from.c === b0.from.c));
    expect(sameFirst).toBe(false);
  });

  it('벤치용 첫 10개 인덱스가 서로 다른 4수 오프닝을 만든다', () => {
    const openings = new Set<string>();
    for (let gameIndex = 0; gameIndex < 10; gameIndex++) {
      let state = initialState(DEFAULT_CONFIG);
      for (let ply = 0; ply < 4; ply++) {
        const move = forcedOpeningMove(state, DEFAULT_CONFIG, gameIndex);
        expect(move).not.toBeNull();
        state = applyMove(state, move!);
      }
      openings.add(JSON.stringify(state.history));
    }
    expect(openings.size).toBe(10);
  });

  it(
    'AI vs AI 1판이 정상 종료된다',
    () => {
      const out = playAiVsAi(DEFAULT_CONFIG, { maxMs: 100, maxDepth: 6 });
      expect(out).not.toBeNull();
      expect(out!.plies).toBeGreaterThan(10);
    },
    30_000,
  );

  it('generated.json에 셀프플레이 전략이 있다', () => {
    const list = generated as StrategyEntry[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.tags).toContain('selfplay');
  });

  it('전체 기보 묶음에서 전략 추출이 동작한다', () => {
    const games = loadAllSelfPlayGames();
    expect(games.length).toBeGreaterThanOrEqual(10);
    const strategies = extractStrategies(games, DEFAULT_CONFIG);
    expect(strategies.length).toBeGreaterThan(0);
  });
});
