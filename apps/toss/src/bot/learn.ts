import type { RuleConfig } from '../core/config';
import type { Player } from '../core/types';
import { parsePatternMoves } from '../../bot/mgn/pattern';
import { StrategyBook } from '../../bot/learning/strategyBook';
import type { StrategyEntry } from '../../bot/learning/types';
import type { RecordGameInput } from '../../bot/learning/gameRecord';
import { historyKey } from './moveKey';
import type { BotMemory } from './storage';

function patternMatchesHistory(pattern: string, historyKeys: string[], config: RuleConfig): boolean {
  try {
    const moves = parsePatternMoves(pattern, config);
    if (!moves.length) return false;
    const prefix = historyKey(moves);
    return historyKeys.some((h) => h.startsWith(prefix) || prefix.startsWith(h));
  } catch {
    return false;
  }
}

function humanOpeningSquares(input: RecordGameInput, humanSide: Player): string[] {
  const squares: string[] = [];
  const FILES = 'abcdefghi';
  let turn: Player = 'BLACK';
  for (const m of input.state.history) {
    if (turn === humanSide) {
      const c = m.kind === 'PLACE' ? m.to.c : m.to.c;
      const r = m.kind === 'PLACE' ? m.to.r : m.to.r;
      const file = FILES[c] ?? '?';
      const rank = input.config.boardSize - r;
      squares.push(`${file}${rank}`);
    }
    turn = turn === 'BLACK' ? 'WHITE' : 'BLACK';
  }
  return squares.slice(0, 6);
}

/** 대국 종료 후 전략 신뢰도·상대 성향을 가볍게 갱신 (LLM 없음) */
export function learnFromGame(
  book: StrategyBook,
  input: RecordGameInput,
  botSide: Player,
  memory: BotMemory,
): BotMemory {
  const botWon = input.result.winner === botSide;
  const histKey = historyKey(input.state.history);

  const updated: StrategyEntry[] = book.exportJson().map((s) => {
    if (!patternMatchesHistory(s.mgnPattern, [histKey], input.config)) return s;
    const delta = botWon ? 0.04 : -0.015;
    return {
      ...s,
      confidence: Math.min(1, Math.max(0.15, s.confidence + delta)),
      sourceGames: [...new Set([...s.sourceGames, `web-${memory.gamesPlayed + 1}`])],
      updatedAt: new Date().toISOString(),
    };
  });

  for (const s of updated) book.addStrategy(s);

  const humanMoves = humanOpeningSquares(input, input.humanSide);
  const tendencies = humanMoves.length
    ? [`opening:${humanMoves.slice(0, 3).join('-')}`]
    : [];

  return {
    version: 1,
    strategies: book.exportJson(),
    humanTendencies: [...memory.humanTendencies, ...tendencies].slice(-20),
    gamesPlayed: memory.gamesPlayed + 1,
  };
}

export function mergeSeedWithMemory(
  seed: StrategyEntry[],
  memory: BotMemory | null,
): StrategyEntry[] {
  const map = new Map<string, StrategyEntry>();
  for (const s of seed) map.set(s.id, { ...s });
  if (memory) {
    for (const s of memory.strategies) {
      const prev = map.get(s.id);
      if (!prev || s.confidence > prev.confidence) map.set(s.id, s);
    }
  }
  return [...map.values()];
}

/** 상대 성향 기반 수 보너스 (인간이 자주 두는 열 견제) */
export function tendencyBonus(
  moveKeyStr: string,
  memory: BotMemory,
): number {
  if (!memory.humanTendencies.length) return 0;
  const last = memory.humanTendencies[memory.humanTendencies.length - 1];
  if (!last?.startsWith('opening:')) return 0;
  const cols = last.replace('opening:', '').split('-').map((s) => s.charAt(0));
  const centerHeavy = cols.filter((c) => c === 'd' || c === 'e' || c === 'f').length >= 2;
  if (!centerHeavy) return 0;
  // 인간이 중앙 오프닝이면 측면 착수에 소보너스
  if (moveKeyStr.startsWith('P:') && (moveKeyStr.includes(',2') || moveKeyStr.includes(',6'))) {
    return 25;
  }
  return 0;
}

export function emptyMemory(): BotMemory {
  return { version: 1, strategies: [], humanTendencies: [], gamesPlayed: 0 };
}

export function applyMemoryToBook(book: StrategyBook, memory: BotMemory): void {
  book.importJson(memory.strategies);
}
