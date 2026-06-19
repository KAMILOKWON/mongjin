import type { RuleConfig } from '../core/config';
import type { GameState, Move, Player } from '../core/types';
import { findKing, goalRow } from '../core/rules';
import type { StrategyEntry } from '../../bot/learning/types';
import { moveKey } from './moveKey';

const CENTER_FILES = new Set([3, 4, 5]); // d, e, f (0-indexed c)

function isOpening(state: GameState): boolean {
  return state.history.length < 20;
}

function escortCount(state: GameState, p: Player): number {
  const k = findKing(state, p);
  if (!k) return 0;
  const n = state.board.length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = k.r + dr;
      const c = k.c + dc;
      if (r < 0 || r >= n || c < 0 || c >= n) continue;
      const piece = state.board[r][c];
      if (piece?.player === p && piece.type === 'GUARD') count++;
    }
  }
  return count;
}

function kingAdvance(state: GameState, p: Player, config: RuleConfig): number {
  const k = findKing(state, p);
  if (!k) return 0;
  const home = p === 'BLACK' ? config.boardSize - 1 : 0;
  return Math.abs(k.r - home);
}

/** 전략서 기반 수 정렬·평가 보너스 (순수 산술, 검색 비용 없음) */
export function buildStrategyBonuses(
  state: GameState,
  config: RuleConfig,
  botSide: Player,
  strategies: StrategyEntry[],
  bookWeights: Map<string, number>,
): Map<string, number> {
  const bonuses = new Map<string, number>(bookWeights);
  const me = state.turn;
  if (me !== botSide) return bonuses;

  const opp = me === 'BLACK' ? 'WHITE' : 'BLACK';
  const opening = isOpening(state);

  let centerWeight = 0;
  let punishWeight = 0;
  for (const s of strategies) {
    if (s.tags.includes('center-control') || s.tags.includes('defense')) {
      centerWeight = Math.max(centerWeight, s.confidence);
    }
    if (s.tags.includes('punish') || s.tags.includes('king-capture')) {
      punishWeight = Math.max(punishWeight, s.confidence);
    }
  }

  const oppEscort = escortCount(state, opp);
  const oppAdvanced = kingAdvance(state, opp, config);
  const nakedKing = config.kingCapture && oppEscort <= 1 && oppAdvanced >= 2;

  for (const row of state.board) {
    for (const piece of row) {
      if (!piece || piece.player !== me) continue;
      // noop — bonuses applied per candidate move in chooseMove path via legal moves iteration
    }
  }

  // store meta on bonuses map under special keys consumed by ai.ts
  if (opening && centerWeight > 0) {
    bonuses.set('__center__', centerWeight * 40);
  }
  if (nakedKing && punishWeight > 0) {
    bonuses.set('__punish__', punishWeight * 80);
  }

  return bonuses;
}

export function moveStrategyBonus(
  state: GameState,
  move: Move,
  config: RuleConfig,
  botSide: Player,
  bonuses: Map<string, number>,
): number {
  if (state.turn !== botSide) return 0;

  let bonus = bonuses.get(moveKey(move)) ?? 0;
  const centerW = bonuses.get('__center__') ?? 0;
  const punishW = bonuses.get('__punish__') ?? 0;

  if (centerW > 0 && move.kind === 'PLACE' && CENTER_FILES.has(move.to.c)) {
    // 중앙 호위는 2개까지만 보너스 (이후 과전개 방지)
    let centerCount = 0;
    for (const fc of CENTER_FILES) {
      for (let r = 0; r < config.boardSize; r++) {
        const p = state.board[r]?.[fc];
        if (p?.player === botSide && p.type === 'GUARD') centerCount++;
      }
    }
    if (centerCount < 2) bonus += centerW;
  }

  if (punishW > 0 && move.kind === 'MOVE') {
    const target = state.board[move.to.r][move.to.c];
    if (target?.type === 'KING') bonus += punishW;
    const opp = botSide === 'BLACK' ? 'WHITE' : 'BLACK';
    const oppKing = findKing(state, opp);
    if (oppKing) {
      const dist =
        Math.abs(move.to.r - oppKing.r) + Math.abs(move.to.c - oppKing.c);
      if (dist <= 2) bonus += punishW * 0.4;
    }
  }

  if (move.kind === 'MOVE') {
    const piece = state.board[move.from.r][move.from.c];
    if (piece?.type === 'KING') {
      const goalR = goalRow(botSide, config.boardSize);
      const closer = Math.abs(move.from.r - goalR) - Math.abs(move.to.r - goalR);
      if (closer > 0 && escortCount(state, botSide) >= 2) {
        bonus += 15;
      }
      if (closer > 0 && escortCount(state, botSide) <= 1) {
        bonus -= 25;
      }
    }
  }

  return bonus;
}

export function evalStrategyBonus(
  state: GameState,
  config: RuleConfig,
  botSide: Player,
  strategies: StrategyEntry[],
): number {
  const me = state.turn;
  if (me !== botSide) return 0;

  let score = 0;
  const opening = isOpening(state);

  for (const s of strategies) {
    if (!opening && s.phase === 'opening') continue;
    const w = s.confidence;

    if (s.tags.includes('center-control') && opening) {
      const n = config.boardSize;
      let centerCount = 0;
      for (const c of CENTER_FILES) {
        if (c >= n) continue;
        for (let r = 0; r < n; r++) {
          const p = state.board[r][c];
          if (p?.player === me && p.type === 'GUARD') centerCount++;
        }
      }
      // 중앙 호위 2개까지만 평가 보너스 (과전개 방지)
      score += 8 * w * Math.min(centerCount, 2);
    }

    if (s.tags.includes('punish')) {
      const opp = me === 'BLACK' ? 'WHITE' : 'BLACK';
      if (escortCount(state, opp) <= 1 && kingAdvance(state, opp, config) >= 2) {
        score += 120 * w;
      }
    }
  }

  return Math.round(score);
}
