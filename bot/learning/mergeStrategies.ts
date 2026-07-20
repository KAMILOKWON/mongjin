import type { StrategyEntry } from './types';

const MAX_STRATEGIES = 64;
const MAX_SOURCES = 40;

/** 패턴 키 기준으로 전략서를 합치고 confidence·근거 기보를 누적한다. */
export function mergeStrategies(
  previous: StrategyEntry[],
  incoming: StrategyEntry[],
  limit = MAX_STRATEGIES,
): StrategyEntry[] {
  const byPattern = new Map<string, StrategyEntry>();

  for (const entry of [...previous, ...incoming]) {
    const key = entry.mgnPattern.trim();
    if (!key) continue;
    const prev = byPattern.get(key);
    if (!prev) {
      byPattern.set(key, { ...entry, sourceGames: [...entry.sourceGames] });
      continue;
    }

    const sources = [...new Set([...prev.sourceGames, ...entry.sourceGames])].slice(
      0,
      MAX_SOURCES,
    );
    const lessons = [...new Set([...prev.lessons, ...entry.lessons])].slice(0, 8);
    const tags = [...new Set([...prev.tags, ...entry.tags])];
    const confidence = Math.min(
      0.99,
      Math.max(prev.confidence, entry.confidence) + (sources.length > prev.sourceGames.length ? 0.03 : 0),
    );

    byPattern.set(key, {
      ...entry,
      title: entry.confidence >= prev.confidence ? entry.title : prev.title,
      summary: entry.confidence >= prev.confidence ? entry.summary : prev.summary,
      tags,
      lessons,
      sourceGames: sources,
      confidence,
      updatedAt: entry.updatedAt > prev.updatedAt ? entry.updatedAt : prev.updatedAt,
    });
  }

  return [...byPattern.values()]
    .sort((a, b) => b.confidence - a.confidence || b.sourceGames.length - a.sourceGames.length)
    .slice(0, limit);
}
