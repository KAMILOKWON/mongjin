import type { RuleConfig } from '../../src/core/config';
import { DEFAULT_CONFIG } from '../../src/core/config';
import type { Move } from '../../src/core/types';
import { parseGame } from './format';
import type { MgnMoveEntry } from './types';

/** MGN 패턴 문자열(부분 수술)에서 수 목록을 추출한다 */
export function parsePatternMoves(pattern: string, config: RuleConfig = DEFAULT_CONFIG): Move[] {
  const movetext = pattern.replace(/\d+\./g, ' ').trim();
  if (!movetext) return [];

  const headers = [
    '[MGN "1"]',
    '[Black "Pattern"]',
    '[White "Pattern"]',
    '[Result "BLACK"]',
    `[boardSize "${config.boardSize}"]`,
    `[guardCount "${config.guardCount}"]`,
    `[goalCells "${config.goalCells}"]`,
    `[placement "${config.placement}"]`,
    `[guardMove "${config.guardMove}"]`,
    `[kingSurroundLoss "${config.kingSurroundLoss}"]`,
    `[noGuardOnGoal "${config.noGuardOnGoal}"]`,
    `[kingCapture "${config.kingCapture}"]`,
  ].join('\n');

  const game = parseGame(`${headers}\n\n${movetext}`);
  return game.moves.map((e: MgnMoveEntry) => e.move);
}
