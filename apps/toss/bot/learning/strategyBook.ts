import type { MgnGame } from '../mgn/types';
import type { OpponentProfile, StrategyEntry } from './types';

/** 메모리 기반 전략서 — 추후 파일·DB로 영속화 가능 */
export class StrategyBook {
  private strategies = new Map<string, StrategyEntry>();
  private opponents = new Map<string, OpponentProfile>();

  addStrategy(entry: StrategyEntry): void {
    const existing = this.strategies.get(entry.id);
    if (existing) {
      const mergedSources = [...new Set([...existing.sourceGames, ...entry.sourceGames])];
      this.strategies.set(entry.id, {
        ...existing,
        ...entry,
        sourceGames: mergedSources,
        confidence: Math.min(1, existing.confidence + entry.confidence * 0.25),
        updatedAt: entry.updatedAt,
      });
      return;
    }
    this.strategies.set(entry.id, entry);
  }

  getStrategy(id: string): StrategyEntry | undefined {
    return this.strategies.get(id);
  }

  listStrategies(filter?: { phase?: StrategyEntry['phase']; tag?: string }): StrategyEntry[] {
    let list = [...this.strategies.values()];
    if (filter?.phase) list = list.filter((s) => s.phase === filter.phase);
    if (filter?.tag) list = list.filter((s) => s.tags.includes(filter.tag!));
    return list.sort((a, b) => b.confidence - a.confidence);
  }

  /** 상대 프로필 갱신 */
  recordGameOutcome(
    opponentId: string,
    displayName: string,
    botWon: boolean,
    tendencies: string[] = [],
  ): OpponentProfile {
    const prev = this.opponents.get(opponentId);
    const profile: OpponentProfile = {
      opponentId,
      displayName,
      gamesPlayed: (prev?.gamesPlayed ?? 0) + 1,
      wins: (prev?.wins ?? 0) + (botWon ? 1 : 0),
      losses: (prev?.losses ?? 0) + (botWon ? 0 : 1),
      tendencies: [...new Set([...(prev?.tendencies ?? []), ...tendencies])],
      effectiveStrategies: prev?.effectiveStrategies ?? [],
      lastPlayedAt: new Date().toISOString(),
    };
    this.opponents.set(opponentId, profile);
    return profile;
  }

  getOpponent(opponentId: string): OpponentProfile | undefined {
    return this.opponents.get(opponentId);
  }

  /** Fable에 넘길 전략서 요약 */
  toPromptContext(maxEntries = 12): string {
    const strategies = this.listStrategies().slice(0, maxEntries);
    if (!strategies.length) return '(아직 축적된 전략 없음)';

    return strategies
      .map(
        (s) =>
          `### ${s.title} (${s.phase}, 신뢰도 ${(s.confidence * 100).toFixed(0)}%)\n` +
          `${s.summary}\n` +
          `패턴: ${s.mgnPattern}\n` +
          `교훈: ${s.lessons.join('; ')}`,
      )
      .join('\n\n');
  }

  importJson(entries: StrategyEntry[]): void {
    for (const e of entries) this.addStrategy(e);
  }

  exportJson(): StrategyEntry[] {
    return this.listStrategies();
  }
}

/** Fable 분석 결과에서 전략 엔트리 초안 생성 (구조화된 JSON 응답 파싱용) */
export function strategyFromAnalysis(
  raw: {
    id: string;
    title: string;
    phase: StrategyEntry['phase'];
    summary: string;
    mgnPattern: string;
    tags?: string[];
    lessons: string[];
  },
  gameId: string,
): StrategyEntry {
  return {
    id: raw.id,
    title: raw.title,
    phase: raw.phase,
    summary: raw.summary,
    mgnPattern: raw.mgnPattern,
    tags: raw.tags ?? [],
    lessons: raw.lessons,
    sourceGames: [gameId],
    confidence: 0.5,
    updatedAt: new Date().toISOString(),
  };
}

export function opponentIdFromGame(game: MgnGame): string {
  return game.headers.opponentId ?? game.headers.black;
}
