import type { RuleConfig } from '../core/config';
import type { GameState, Move } from '../core/types';
import { legalMoves } from '../core/rules';
import { parsePatternMoves } from '../../bot/mgn/pattern';
import type { StrategyEntry } from '../../bot/learning/types';
import { historyKey, moveKey, movesEqual } from './moveKey';

export interface BookEntry {
  move: Move;
  weight: number;
  strategyId: string;
}

export class OpeningBook {
  private table = new Map<string, BookEntry[]>();

  static fromStrategies(strategies: StrategyEntry[], config: RuleConfig): OpeningBook {
    const book = new OpeningBook();
    for (const s of strategies) {
      if (s.phase !== 'opening' && !s.mgnPattern.includes('@')) continue;
      const patternMoves = parsePatternMoves(s.mgnPattern, config);
      if (patternMoves.length < 2) continue;

      const weight = Math.round(s.confidence * 160);
      for (let i = 0; i < patternMoves.length; i++) {
        const prefix = historyKey(patternMoves.slice(0, i));
        const next = patternMoves[i]!;
        const list = book.table.get(prefix) ?? [];
        const existing = list.find((e) => movesEqual(e.move, next));
        if (existing) {
          existing.weight = Math.max(existing.weight, weight);
        } else {
          list.push({ move: next, weight, strategyId: s.id });
        }
        book.table.set(prefix, list);
      }
    }
    return book;
  }

  /** 현재 수술과 일치하는 오프닝 북 추천 (합법 수만) */
  lookup(state: GameState, config: RuleConfig): Move | null {
    const key = historyKey(state.history);
    const entries = this.table.get(key);
    if (!entries?.length) return null;

    const legal = legalMoves(state, config);
    const ranked = entries
      .filter((e) => legal.some((m) => movesEqual(m, e.move)))
      .sort((a, b) => b.weight - a.weight);

    return ranked[0]?.move ?? null;
  }

  /** 수 정렬용 보너스 맵 */
  moveWeights(state: GameState, config: RuleConfig): Map<string, number> {
    const key = historyKey(state.history);
    const entries = this.table.get(key) ?? [];
    const legal = legalMoves(state, config);
    const weights = new Map<string, number>();

    for (const e of entries) {
      if (!legal.some((m) => movesEqual(m, e.move))) continue;
      const k = moveKey(e.move);
      weights.set(k, Math.max(weights.get(k) ?? 0, e.weight));
    }
    return weights;
  }
}
