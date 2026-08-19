import type { GameState } from '../../src/core/types';
import type { RuleConfig } from '../../src/core/config';
import type { GameResult } from '../../src/core/result';
import type { GameSettings } from '../../src/game/settings';
import { gameFromFinished, serializeGame } from '../mgn/format';
import type { GameExportMeta, MgnGame } from '../mgn/types';

export interface RecordGameInput {
  state: GameState;
  result: GameResult;
  config: RuleConfig;
  settings: GameSettings;
  humanSide: 'BLACK' | 'WHITE';
}

function opponentLabel(settings: GameSettings): string {
  switch (settings.mode) {
    case 'ai':
      return 'Mongjin-AI';
    case 'ghost':
      return 'Mongjin-Ghost';
    case 'online':
      return 'Online-Opponent';
    case 'local':
      return 'Local-Opponent';
  }
}

function buildMeta(input: RecordGameInput): GameExportMeta {
  const botSide = input.settings.mode === 'ai' || input.settings.mode === 'ghost'
    ? (input.humanSide === 'BLACK' ? 'WHITE' : 'BLACK')
    : undefined;
  const humanName = 'Human';
  const opponentName = opponentLabel(input.settings);

  return {
    black: input.humanSide === 'BLACK' ? humanName : opponentName,
    white: input.humanSide === 'WHITE' ? humanName : opponentName,
    botSide,
    opponentId: input.settings.mode === 'online' ? 'online-peer' : opponentName.toLowerCase(),
    event: input.settings.mode === 'ai' || input.settings.mode === 'ghost' ? 'Human vs Mongjin' : input.settings.mode,
    site: typeof location !== 'undefined' ? location.hostname : 'mongjin',
  };
}

/** 종료된 대국을 MGN 기보 객체로 변환한다 */
export function recordFinishedGame(input: RecordGameInput): MgnGame {
  return gameFromFinished({
    moves: input.state.history,
    result: input.result,
    config: input.config,
    meta: buildMeta(input),
  });
}

/** MGN 텍스트와 파일명용 ID를 반환한다 */
export function exportGameMgn(input: RecordGameInput): { id: string; mgn: string; game: MgnGame } {
  const game = recordFinishedGame(input);
  const date = game.headers.date?.replace(/\./g, '-') ?? new Date().toISOString().slice(0, 10);
  const id = `${date}_${game.headers.result}_${game.moves.length}m`;
  return { id, mgn: serializeGame(game), game };
}
