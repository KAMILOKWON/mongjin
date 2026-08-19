import type { StrategyEntry } from '../../bot/learning/types';

const STORAGE_KEY = 'mongjin-bot-memory';
const MAX_STRATEGIES = 32;

export interface BotMemory {
  version: 1;
  strategies: StrategyEntry[];
  humanTendencies: string[];
  gamesPlayed: number;
}

export function loadMemory(): BotMemory | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as BotMemory;
    if (data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveMemory(memory: BotMemory): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const trimmed: BotMemory = {
      ...memory,
      strategies: memory.strategies
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_STRATEGIES),
      humanTendencies: memory.humanTendencies.slice(-20),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota — 무시 */
  }
}

export function clearMemory(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
