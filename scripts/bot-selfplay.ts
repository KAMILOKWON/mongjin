#!/usr/bin/env npx tsx
/**
 * AI vs AI 셀프플레이 → MGN 기보 + generated.json 전략서 생성
 * 사용:
 *   npm run bot:selfplay [게임수]
 *   npm run bot:selfplay -- 100 --strong
 *   npm run bot:selfplay -- 100 --strong --merge
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config';
import {
  runSelfPlayBatch,
  selfPlayOptionsFor,
  validateSelfPlayQuality,
  type SelfPlayStrength,
} from '../bot/selfplay/play';
import { extractStrategies } from '../bot/learning/extractStrategies';
import { mergeStrategies } from '../bot/learning/mergeStrategies';
import type { StrategyEntry } from '../bot/learning/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAMES_DIR = join(ROOT, 'bot/games/selfplay');
const OUT_JSON = join(ROOT, 'bot/strategies/generated.json');

function parseArgs(argv: string[]): {
  count: number;
  strength: SelfPlayStrength;
  merge: boolean;
  offset: number | null;
} {
  let count = 60;
  let strength: SelfPlayStrength = 'fast';
  let merge = false;
  let offset: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--strong' || arg === '-s') {
      strength = 'strong';
      continue;
    }
    if (arg === '--fast' || arg === '-f') {
      strength = 'fast';
      continue;
    }
    if (arg === '--merge' || arg === '-m') {
      merge = true;
      continue;
    }
    if (arg === '--replace') {
      merge = false;
      continue;
    }
    if (arg === '--offset') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error('--offset 은 0 이상 정수여야 합니다.');
        process.exit(1);
      }
      offset = n;
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`알 수 없는 옵션: ${arg}`);
      process.exit(1);
    }
    const n = Number.parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 10) {
      console.error('게임 수는 10 이상의 정수여야 합니다.');
      process.exit(1);
    }
    count = n;
  }
  // strong 기본은 누적 병합
  if (strength === 'strong' && !argv.includes('--replace') && !argv.includes('--merge') && !argv.includes('-m')) {
    merge = true;
  }
  return { count, strength, merge, offset };
}

function loadExisting(): StrategyEntry[] {
  try {
    const raw = JSON.parse(readFileSync(OUT_JSON, 'utf8')) as StrategyEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

const { count, strength, merge, offset } = parseArgs(process.argv.slice(2));
const opts = selfPlayOptionsFor(strength);
const startIndex = offset ?? (merge ? loadExisting().length : 0);

console.log(
  `셀프플레이 ${count}판 시작… (${strength}, maxMs=${opts.maxMs}, maxDepth=${opts.maxDepth}, ${merge ? 'merge' : 'replace'}, offset=${startIndex})`,
);
const t0 = performance.now();
const batch = runSelfPlayBatch(count, DEFAULT_CONFIG, opts, {
  startIndex,
  onProgress: ({ index, count: total, finished, plies, reason }) => {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
    const status = plies == null ? '미종료' : `${plies}수 ${reason}`;
    console.log(`[${index}/${total}] 완료 ${finished} · ${status} · ${elapsed}s`);
  },
});
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

console.log(
  `완료 ${batch.stats.finished}/${batch.stats.played}판, 평균 ${batch.stats.avgPlies.toFixed(0)}수, ${elapsed}s`,
);
console.log('종료 사유:', batch.stats.byReason);

if (!validateSelfPlayQuality(batch)) {
  console.warn('경고: 셀프플레이 품질이 낮습니다. 게임 수를 늘려 다시 실행하세요.');
}

mkdirSync(GAMES_DIR, { recursive: true });
const sampleCap = Math.min(batch.games.length, strength === 'strong' ? 24 : 12);
const sampleOffset = merge ? 24 : 0; // merge 시 기존 샘플을 덮지 않고 뒤에 추가
for (let i = 0; i < sampleCap; i++) {
  const id = `game-${String(sampleOffset + i + 1).padStart(3, '0')}`;
  writeFileSync(join(GAMES_DIR, `${id}.mgn`), batch.mgns[i]!);
}

const extracted = extractStrategies(batch.games, DEFAULT_CONFIG);
const previous = merge ? loadExisting() : [];
const strategies = merge ? mergeStrategies(previous, extracted) : extracted;
writeFileSync(OUT_JSON, `${JSON.stringify(strategies, null, 2)}\n`);

console.log(
  `전략 ${strategies.length}개 → ${OUT_JSON}` +
    (merge ? ` (기존 ${previous.length} + 신규 ${extracted.length})` : ''),
);
console.log(`샘플 기보 ${sampleCap}개 → ${GAMES_DIR}/`);
