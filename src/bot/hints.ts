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

// Returns distance from king to its goal row (lower = closer to winning).
function kingAdvance(state: GameState, p: Player, config: RuleConfig): number {
  const k = findKing(state, p);
  if (!k) return 0;
  const g = goalRow(p, config.boardSize);
  return Math.abs(k.r - g);
}

function isEndgame(state: GameState, config: RuleConfig): boolean {
  for (const p of ['BLACK', 'WHITE'] as Player[]) {
    if (kingAdvance(state, p, config) <= 3) return true;
  }
  return false;
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
  const endgame = isEndgame(state, config);

  const myDist = kingAdvance(state, me, config);
  const oppDist = kingAdvance(state, opp, config);
  const raceBehind = myDist > oppDist + 1;
  const myEscort = escortCount(state, me);

  let centerWeight = 0;
  let punishWeight = 0;
  let endgameGoalWeight = 0;
  let raceBehindWeight = 0;
  let guardBeltWeight = 0;

  for (const s of strategies) {
    if (s.tags.includes('center-control') || s.tags.includes('defense')) {
      centerWeight = Math.max(centerWeight, s.confidence);
    }
    if (s.tags.includes('punish') || s.tags.includes('king-capture')) {
      punishWeight = Math.max(punishWeight, s.confidence);
    }
    if (s.tags.includes('endgame-goal-row') && endgame) {
      endgameGoalWeight = Math.max(endgameGoalWeight, s.confidence);
    }
    if (s.tags.includes('race-behind') && raceBehind) {
      raceBehindWeight = Math.max(raceBehindWeight, s.confidence);
    }
    if (s.tags.includes('guard-belt') && myEscort < 2) {
      guardBeltWeight = Math.max(guardBeltWeight, s.confidence);
    }
  }

  const oppEscort = escortCount(state, opp);
  const nakedKing = config.kingCapture && oppEscort <= 1 && oppDist >= 2;

  // store meta on bonuses map under special keys consumed by ai.ts
  if (opening && centerWeight > 0) {
    bonuses.set('__center__', centerWeight * 40);
  }
  if (nakedKing && punishWeight > 0) {
    bonuses.set('__punish__', punishWeight * 80);
  }
  if (endgameGoalWeight > 0) {
    bonuses.set('__endgame-goal__', endgameGoalWeight * 50);
  }
  if (raceBehindWeight > 0) {
    bonuses.set('__race-behind__', raceBehindWeight * 25);
  }
  if (guardBeltWeight > 0) {
    bonuses.set('__guard-belt__', guardBeltWeight * 20);
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
  const endgameGoalW = bonuses.get('__endgame-goal__') ?? 0;
  const raceBehindW = bonuses.get('__race-behind__') ?? 0;
  const guardBeltW = bonuses.get('__guard-belt__') ?? 0;

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

  // Endgame goal row: bonus for moves to opponent's goal approach rows
  if (endgameGoalW > 0) {
    const opp = botSide === 'BLACK' ? 'WHITE' : 'BLACK';
    const oppGoalR = goalRow(opp, config.boardSize);
    const dist = Math.abs(move.to.r - oppGoalR);
    if (dist >= 1 && dist <= 2) bonus += endgameGoalW;
  }

  // Race behind: extra bonus for any blocking PLACE
  if (raceBehindW > 0 && move.kind === 'PLACE') {
    bonus += raceBehindW;
  }

  // Guard belt: bonus for PLACE adjacent to own king when escort count is low
  if (guardBeltW > 0 && move.kind === 'PLACE') {
    const myKing = findKing(state, botSide);
    if (myKing) {
      const d = Math.max(
        Math.abs(move.to.r - myKing.r),
        Math.abs(move.to.c - myKing.c),
      );
      if (d <= 1) bonus += guardBeltW;
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
  const endgame = isEndgame(state, config);

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
      score += 8 * w * Math.min(centerCount, 2);
    }

    if (s.tags.includes('punish')) {
      const opp = me === 'BLACK' ? 'WHITE' : 'BLACK';
      if (escortCount(state, opp) <= 1 && kingAdvance(state, opp, config) >= 2) {
        score += 120 * w;
      }
    }

    if (s.tags.includes('endgame-goal-row') && endgame) {
      // Bonus for guards controlling opponent's goal approach rows
      const opp = me === 'BLACK' ? 'WHITE' : 'BLACK';
      const oppGoalR = goalRow(opp, config.boardSize);
      const n = config.boardSize;
      let count = 0;
      for (let dr = 1; dr <= 2; dr++) {
        const r = oppGoalR === 0 ? oppGoalR + dr : oppGoalR - dr;
        if (r < 0 || r >= n) continue;
        for (let c = 0; c < n; c++) {
          const p = state.board[r]?.[c];
          if (p?.player === me && p.type === 'GUARD') count++;
        }
      }
      score += 12 * w * Math.min(count, 3);
    }
  }

  return Math.round(score);
}
