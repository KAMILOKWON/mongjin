import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { playAiVsAi } from './play';
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
