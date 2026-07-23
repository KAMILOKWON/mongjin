import type { RuleConfig } from '../../src/core/config';
import { DEFAULT_CONFIG } from '../../src/core/config';
import type { GameState, Move } from '../../src/core/types';
import { initialState, legalMoves } from '../../src/core/rules';
import { applyMove } from '../../src/core/apply';
import { getResult, type GameResult } from '../../src/core/result';
import { chooseMove, type AiOptions } from '../../src/ai/ai';
import { gameFromFinished, serializeGame } from '../mgn/format';
import type { MgnGame } from '../mgn/types';

/** 빠른 회귀·스모크용 — 배치 생성 시간 우선 */
export const SELFPLAY_AI_OPTIONS: AiOptions = {
  maxMs: 150,
  maxDepth: 8,
};

/**
 * 올마이트 학습용 — fast보다 깊게 두되 대량 배치가 가능한 예산.
 * 다양성은 rootNoise가 아니라 강제 오프닝 분기로 확보한다.
 */
export const SELFPLAY_STRONG_AI_OPTIONS: AiOptions = {
  maxMs: 400,
  maxDepth: 9,
  maxNodes: 3_000,
  planStrength: 1.7,
  strategyLevel: 3,
  elite: true,
};

export type SelfPlayStrength = 'fast' | 'strong';

export function selfPlayOptionsFor(strength: SelfPlayStrength): AiOptions {
  return strength === 'strong' ? { ...SELFPLAY_STRONG_AI_OPTIONS } : { ...SELFPLAY_AI_OPTIONS };
}

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

/** 게임 인덱스마다 다른 초반 수를 강제해 동일 기보 반복을 막는다. */
export function forcedOpeningMove(
  state: GameState,
  config: RuleConfig,
  gameIndex: number,
): Move | null {
  if (state.history.length >= 2) return null;
  const legal = legalMoves(state, config);
  if (!legal.length) return null;

  const kingMoves = legal.filter((m) => {
    if (m.kind !== 'MOVE') return false;
    return state.board[m.from.r][m.from.c]?.type === 'KING';
  });
  const places = legal.filter((m) => m.kind === 'PLACE');
  const pool = state.history.length === 0
    ? (kingMoves.length ? kingMoves : legal)
    : (places.length ? places : legal);

  return pool[gameIndex % pool.length]!;
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

    const forced = forcedOpeningMove(state, config, gameIndex);
    const move =
      forced ??
      chooseMove(state, config, opts);
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
  maxPlies = 220,
): SelfPlayResult | null {
  return playOne(config, opts, gameIndex, maxPlies);
}

export interface SelfPlayBatchOptions {
  /** 오프닝 분기용 시작 인덱스 (누적 배치에서 겹침 방지) */
  startIndex?: number;
  onProgress?: (info: {
    index: number;
    count: number;
    finished: number;
    plies: number | null;
    reason: string | null;
  }) => void;
}

export function runSelfPlayBatch(
  count: number,
  config: RuleConfig = DEFAULT_CONFIG,
  opts: AiOptions = SELFPLAY_AI_OPTIONS,
  batchOpts: SelfPlayBatchOptions = {},
): SelfPlayBatchResult {
  const games: MgnGame[] = [];
  const mgns: string[] = [];
  const byReason: Record<string, number> = {};
  let totalPlies = 0;
  let finished = 0;
  const startIndex = batchOpts.startIndex ?? 0;

  for (let i = 0; i < count; i++) {
    const out = playAiVsAi(config, opts, startIndex + i);
    if (!out) {
      batchOpts.onProgress?.({
        index: i + 1,
        count,
        finished,
        plies: null,
        reason: null,
      });
      continue;
    }
    finished++;
    games.push(out.game);
    mgns.push(out.mgn);
    byReason[out.result.reason] = (byReason[out.result.reason] ?? 0) + 1;
    totalPlies += out.plies;
    batchOpts.onProgress?.({
      index: i + 1,
      count,
      finished,
      plies: out.plies,
      reason: out.result.reason,
    });
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
