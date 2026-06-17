#!/usr/bin/env npx tsx
/**
 * AI vs AI 셀프플레이 → MGN 기보 + generated.json 전략서 생성
 * 사용: npm run bot:selfplay [게임수]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config';
import { runSelfPlayBatch, validateSelfPlayQuality } from '../bot/selfplay/play';
import { extractStrategies } from '../bot/learning/extractStrategies';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAMES_DIR = join(ROOT, 'bot/games/selfplay');
const OUT_JSON = join(ROOT, 'bot/strategies/generated.json');

const count = Number.parseInt(process.argv[2] ?? '60', 10);
if (!Number.isFinite(count) || count < 10) {
  console.error('게임 수는 10 이상의 정수여야 합니다.');
  process.exit(1);
}

console.log(`셀프플레이 ${count}판 시작…`);
const t0 = performance.now();
const batch = runSelfPlayBatch(count, DEFAULT_CONFIG);
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

console.log(
  `완료 ${batch.stats.finished}/${batch.stats.played}판, 평균 ${batch.stats.avgPlies.toFixed(0)}수, ${elapsed}s`,
);
console.log('종료 사유:', batch.stats.byReason);

if (!validateSelfPlayQuality(batch)) {
  console.warn('경고: 셀프플레이 품질이 낮습니다. 게임 수를 늘려 다시 실행하세요.');
}

mkdirSync(GAMES_DIR, { recursive: true });
const sampleCap = Math.min(batch.games.length, 12);
for (let i = 0; i < sampleCap; i++) {
  const id = `game-${String(i + 1).padStart(3, '0')}`;
  writeFileSync(join(GAMES_DIR, `${id}.mgn`), batch.mgns[i]!);
}

const strategies = extractStrategies(batch.games, DEFAULT_CONFIG);
writeFileSync(OUT_JSON, `${JSON.stringify(strategies, null, 2)}\n`);

console.log(`전략 ${strategies.length}개 → ${OUT_JSON}`);
console.log(`샘플 기보 ${sampleCap}개 → ${GAMES_DIR}/`);
