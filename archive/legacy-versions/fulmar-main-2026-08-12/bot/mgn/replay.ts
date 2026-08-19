import { applyMove } from '../../src/core/apply';
import type { RuleConfig } from '../../src/core/config';
import { getResult } from '../../src/core/result';
import { initialState } from '../../src/core/rules';
import type { GameState, Move } from '../../src/core/types';
import type { MgnGame } from './types';

/** MGN 기보를 처음부터 재생해 최종 국면과 승패를 반환한다 */
export function replayGame(
  game: MgnGame,
): { states: GameState[]; result: ReturnType<typeof getResult> } {
  const config: RuleConfig = game.headers.config;
  const states: GameState[] = [initialState(config)];
  const moves: Move[] = game.moves.map((e) => e.move);

  for (const move of moves) {
    const next = applyMove(states[states.length - 1]!, move);
    states.push(next);
  }

  return {
    states,
    result: getResult(states[states.length - 1]!, config),
  };
}
