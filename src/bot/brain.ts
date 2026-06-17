import type { RuleConfig } from '../core/config';
import type { GameState, Move } from '../core/types';
import { StrategyBook } from '../../bot/learning/strategyBook';
import type { StrategyEntry } from '../../bot/learning/types';
import type { RecordGameInput } from '../../bot/learning/gameRecord';
import seedStrategies from '../../bot/strategies/seed.json';
import generatedStrategies from '../../bot/strategies/generated.json';
import { DEFAULT_CONFIG } from '../core/config';
import { buildStrategyBonuses, evalStrategyBonus, moveStrategyBonus } from './hints';
import {
  applyMemoryToBook,
  emptyMemory,
  learnFromGame,
  mergeSeedWithMemory,
  tendencyBonus,
} from './learn';
import { OpeningBook } from './openingBook';
import { loadMemory, saveMemory } from './storage';
import { moveKey } from './moveKey';

/** 미니맥스에 전달하는 가벼운 힌트 (전략서 → 수 정렬·평가 보정만, 검색은 항상 수행) */
export interface BotHints {
  moveBonus: (state: GameState, move: Move) => number;
  evalBonus: (state: GameState) => number;
}

/**
 * 웹용 봇 두뇌 — 시드 전략 + localStorage 학습.
 * LLM·네트워크 없이 오프닝 북·평가 보정만 적용한다.
 */
export class BotBrain {
  private book = new StrategyBook();
  private memory = loadMemory() ?? emptyMemory();
  private openingBook: OpeningBook;
  private strategies: StrategyEntry[];
  private config: RuleConfig;

  constructor(config: RuleConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.strategies = mergeSeedWithMemory(
      [...(seedStrategies as StrategyEntry[]), ...(generatedStrategies as StrategyEntry[])],
      this.memory,
    );
    this.book.importJson(this.strategies);
    applyMemoryToBook(this.book, this.memory);
    this.openingBook = OpeningBook.fromStrategies(this.book.exportJson(), config);
  }

  /** 규칙 변경 시 오프닝 북 재구성 */
  syncConfig(config: RuleConfig): void {
    if (JSON.stringify(config) === JSON.stringify(this.config)) return;
    this.config = config;
    this.openingBook = OpeningBook.fromStrategies(this.book.exportJson(), config);
  }

  hintsFor(state: GameState, botSide: 'BLACK' | 'WHITE'): BotHints {
    const strategies = this.book.exportJson();
    const bookWeights = this.openingBook.moveWeights(state, this.config);
    const bonuses = buildStrategyBonuses(state, this.config, botSide, strategies, bookWeights);

    return {
      moveBonus: (s, m) => {
        let b = moveStrategyBonus(s, m, this.config, botSide, bonuses);
        b += tendencyBonus(moveKey(m), this.memory);
        return b;
      },
      evalBonus: (s) => evalStrategyBonus(s, this.config, botSide, strategies),
    };
  }

  onGameEnd(input: RecordGameInput, botSide: 'BLACK' | 'WHITE'): void {
    this.memory = learnFromGame(this.book, input, botSide, this.memory);
    saveMemory(this.memory);
    this.openingBook = OpeningBook.fromStrategies(this.book.exportJson(), this.config);
  }

  get gamesLearned(): number {
    return this.memory.gamesPlayed;
  }

  resetLearning(): void {
    this.memory = emptyMemory();
    saveMemory(this.memory);
    this.book = new StrategyBook();
    this.book.importJson([
      ...(seedStrategies as StrategyEntry[]),
      ...(generatedStrategies as StrategyEntry[]),
    ]);
    this.openingBook = OpeningBook.fromStrategies(this.book.exportJson(), this.config);
  }
}

let sharedBrain: BotBrain | null = null;

export function getBotBrain(config?: RuleConfig): BotBrain {
  if (!sharedBrain) sharedBrain = new BotBrain(config);
  else if (config) sharedBrain.syncConfig(config);
  return sharedBrain;
}
