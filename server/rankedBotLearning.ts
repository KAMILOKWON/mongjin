import type { BotHints } from '../src/bot/brain';
import { moveKey } from '../src/bot/moveKey';
import { DEFAULT_CONFIG, type RuleConfig } from '../src/core/config';
import { initialState, legalMoves, positionKey } from '../src/core/rules';
import { applyMove } from '../src/core/apply';
import { getResult } from '../src/core/result';
import type { GameState, Move, Player } from '../src/core/types';

export interface BotLearning {
  version: 1;
  games: number;
  // Keys contain the bot side, exact rules and resulting opening position. No account information.
  openings: Record<string, { wins: number; losses: number }>;
}
export interface BotLearningGame {
  moves: Move[];
  config: RuleConfig;
  side: Player;
  winner: Player;
  reason: string;
}
const MAX_PLIES = 12;
const MAX_ENTRIES = 512;
const rulesKey = (config: RuleConfig) => JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
const prefix = (config: RuleConfig, side: Player) => `${side}:${rulesKey(config)}:`;
export const emptyBotLearning = (): BotLearning => ({ version: 1, games: 0, openings: {} });

/** Only completed, legally replayed human games teach. Resigns/disconnects do not label openings. */
export function learnBotOpening(memory: BotLearning | undefined, game?: BotLearningGame): BotLearning {
  const previous = memory ?? emptyBotLearning();
  if (!game || !['goal', 'capture', 'surround', 'no-moves'].includes(game.reason) || !game.moves.length) return previous;
  let state = initialState(game.config);
  const observed: string[] = [];
  for (const [ply, move] of game.moves.entries()) {
    if (getResult(state, game.config) || !legalMoves(state, game.config).some((m) => moveKey(m) === moveKey(move))) return previous;
    const botTurn = state.turn === game.side;
    state = applyMove(state, move);
    if (botTurn && ply < MAX_PLIES) observed.push(prefix(game.config, game.side) + positionKey(state));
  }
  const result = getResult(state, game.config);
  if (!result || result.winner !== game.winner || result.reason !== game.reason) return previous;
  const openings = { ...previous.openings };
  for (const key of new Set(observed)) {
    const old = openings[key] ?? { wins: 0, losses: 0 };
    delete openings[key]; // Keep recently observed patterns when pruning.
    openings[key] = { wins: old.wins + Number(game.winner === game.side), losses: old.losses + Number(game.winner !== game.side) };
  }
  return { version: 1, games: previous.games + 1, openings: Object.fromEntries(Object.entries(openings).slice(-MAX_ENTRIES)) };
}

/** Three observations minimum; small Bayesian-smoothed bonus. Search and tactical checks still run. */
export function learnedOpeningHints(memory: BotLearning | undefined, root: GameState, side: Player, config: RuleConfig = DEFAULT_CONFIG): BotHints {
  const base = prefix(config, side);
  if (!memory || root.history.length >= MAX_PLIES || !Object.values(memory.openings).some((s) => s.wins + s.losses >= 3)) {
    return { moveBonus: () => 0, evalBonus: () => 0 };
  }
  const bonus = (state: GameState) => {
    const stats = memory?.openings[base + positionKey(state)];
    if (!stats || stats.wins + stats.losses < 3) return 0;
    return 16 * (stats.wins - stats.losses) / (stats.wins + stats.losses + 4);
  };
  const active = root.history.length < MAX_PLIES;
  return {
    moveBonus: (state, move) => active && state === root && state.turn === side ? bonus(applyMove(state, move)) : 0,
    // Search intentionally drops history; positionKey includes board, turn and guards in hand.
    evalBonus: (state) => active ? bonus(state) : 0,
  };
}
