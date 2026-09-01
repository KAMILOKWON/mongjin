import type { RuleConfig } from '../src/core/config';
import { legalMoves } from '../src/core/rules';
import type { GameState, Move, Player } from '../src/core/types';
import {
  BUILT_IN_GHOSTS,
  GhostController,
  withEphemeralGhostNickname,
} from '../src/ghost';

export interface OfficialBot {
  name: string;
  rating: number;
  side: Player;
  controller: GhostController;
  thinking: boolean;
}

export function createOfficialBot(
  playerRating: number,
  playerName: string,
  random: () => number = Math.random,
): OfficialBot {
  const tape = [...BUILT_IN_GHOSTS]
    .sort((a, b) => Math.abs(a.ownerRating - playerRating) - Math.abs(b.ownerRating - playerRating))[0];
  if (!tape) throw new Error('공식 봇 기보가 없습니다');
  const challenge = withEphemeralGhostNickname(tape, { playerName, random });
  return {
    name: challenge.ownerName,
    rating: challenge.ownerRating,
    side: challenge.side,
    controller: new GhostController(challenge),
    thinking: false,
  };
}

export function chooseOfficialBotMove(
  bot: OfficialBot,
  state: GameState,
  config: RuleConfig,
): Move | null {
  try {
    return bot.controller.choose(state, config)?.move ?? legalMoves(state, config)[0] ?? null;
  } catch {
    return legalMoves(state, config)[0] ?? null;
  }
}
