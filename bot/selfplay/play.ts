import type { RuleConfig } from '../../src/core/config';
import { DEFAULT_CONFIG } from '../../src/core/config';
import type { GameState } from '../../src/core/types';
import { initialState } from '../../src/core/rules';
import { applyMove } from '../../src/core/apply';
import { getResult, type GameResult } from '../../src/core/result';
import { chooseMove, type AiOptions } from '../../src/ai/ai';
import { gameFromFinished, serializeGame } from '../mgn/format';
import type { MgnGame } from '../mgn/types';

/** 셀프플레이용 AI 강도 — 충분히 겨루되 배치 생성 시간 고려 */
export const SELFPLAY_AI_OPTIONS: AiOptions = {
  maxMs: 150,
  maxDepth: 8,
};

export interface SelfPlayResult {
  state: GameState;
  result: GameResult;
  game: MgnGame;
  mgn: string;
  plies: number;
}

export interface SelfPlayBatchResult {
  games: MgnGame[];
  mgns: string[];
  stats: {
    played: number;
    finished: number;
    byReason: Record<string, number>;
    avgPlies: number;
  };
}

function playOne(
  config: RuleConfig,
  opts: AiOptions,
  gameIndex: number,
  maxPlies: number,
): SelfPlayResult | null {
  let state = initialState(config);
  for (let ply = 0; ply < maxPlies; ply++) {
    const result = getResult(state, config);
    if (result) {
      const game = gameFromFinished({
        moves: state.history,
        result,
        config,
        meta: {
          black: 'AI-Black',
          white: 'AI-White',
          event: 'Self-play',
          site: 'mongjin-selfplay',
          opponentId: 'ai-vs-ai',
        },
      });
      game.headers.round = String(gameIndex + 1);
      return {
        state,
        result,
        game,
        mgn: serializeGame(game),
        plies: state.history.length,
      };
    }
    const move = chooseMove(state, config, opts);
    if (!move) return null;
    state = applyMove(state, move);
  }
  return null;
}

/** 미니맥스 AI끼리 1판 — 힌트 없이 순수 엔진으로 기보 생성 */
export function playAiVsAi(
  config: RuleConfig = DEFAULT_CONFIG,
  opts: AiOptions = SELFPLAY_AI_OPTIONS,
  gameIndex = 0,
  maxPlies = 400,
): SelfPlayResult | null {
  return playOne(config, opts, gameIndex, maxPlies);
}

export function runSelfPlayBatch(
  count: number,
  config: RuleConfig = DEFAULT_CONFIG,
  opts: AiOptions = SELFPLAY_AI_OPTIONS,
): SelfPlayBatchResult {
  const games: MgnGame[] = [];
  const mgns: string[] = [];
  const byReason: Record<string, number> = {};
  let totalPlies = 0;
  let finished = 0;

  for (let i = 0; i < count; i++) {
    const out = playAiVsAi(config, opts, i);
    if (!out) continue;
    finished++;
    games.push(out.game);
    mgns.push(out.mgn);
    byReason[out.result.reason] = (byReason[out.result.reason] ?? 0) + 1;
    totalPlies += out.plies;
  }

  return {
    games,
    mgns,
    stats: {
      played: count,
      finished,
      byReason,
      avgPlies: finished ? totalPlies / finished : 0,
    },
  };
}

export function validateSelfPlayQuality(batch: SelfPlayBatchResult): boolean {
  if (batch.stats.finished < batch.stats.played * 0.9) return false;
  if (batch.stats.avgPlies < 20) return false;
  return true;
}
