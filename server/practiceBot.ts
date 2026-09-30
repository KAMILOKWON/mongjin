import { chooseMove } from '../src/ai/ai';
import { getBotBrain } from '../src/bot/brain';
import { DEFAULT_CONFIG } from '../src/core/config';
import type { GameState, Move } from '../src/core/types';
import { AI_DIFFICULTY_PRESETS } from '../src/game/settings';

export const PRACTICE_BOT_VERSION = 'mongjin-ai-hard-1';

/** The same strongest bot used by the app, with the full repetition history. */
export function choosePracticeMove(state: GameState): Move {
  const preset = AI_DIFFICULTY_PRESETS.hard;
  const move = chooseMove(state, DEFAULT_CONFIG, {
    ...preset,
    botSide: state.turn,
    hints: getBotBrain(DEFAULT_CONFIG).hintsFor(state, state.turn, preset.hintScale ?? 1),
  });
  if (!move) throw new Error('Practice game finished');
  return move;
}
