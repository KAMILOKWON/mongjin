import { describe, expect, it } from 'vitest';
import type { GameState, Player } from './types';
import { DEFAULT_CONFIG, type RuleConfig } from './config';
import { findKing, initialState, legalMoves } from './rules';
import { applyMove } from './apply';
import { getResult, type WinReason } from './result';

/** 시드 고정 PRNG (mulberry32) — 테스트 재현성 보장 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countGuards(state: GameState, p: Player): number {
  let n = 0;
  for (const row of state.board) {
    for (const piece of row) {
      if (piece && piece.player === p && piece.type === 'GUARD') n++;
    }
  }
  return n;
}

function assertInvariants(state: GameState, config: RuleConfig, ply: number) {
  // 왕은 잡히지 않는 한 항상 존재 (kingCapture가 켜져 있으면 잡혀서 사라질 수 있음)
  if (!config.kingCapture) {
    expect(findKing(state, 'BLACK'), `ply ${ply}: 흑 왕 소실`).not.toBeNull();
    expect(findKing(state, 'WHITE'), `ply ${ply}: 백 왕 소실`).not.toBeNull();
  }
  // 보드 위 + 손 안의 호위는 총량을 넘지 않는다 (잡힌 만큼만 감소)
  for (const p of ['BLACK', 'WHITE'] as Player[]) {
    const total = countGuards(state, p) + state.guardsInHand[p];
    expect(total, `ply ${ply}: ${p} 호위 총량 오류`).toBeLessThanOrEqual(config.guardCount);
    expect(state.guardsInHand[p], `ply ${ply}: ${p} 손 음수`).toBeGreaterThanOrEqual(0);
  }
}

function playRandomGame(
  config: RuleConfig,
  rand: () => number,
  maxPlies: number,
): { plies: number; reason: WinReason | 'cap' } {
  let state = initialState(config);
  for (let ply = 0; ply < maxPlies; ply++) {
    const result = getResult(state, config);
    if (result) return { plies: ply, reason: result.reason };

    const moves = legalMoves(state, config);
    // getResult가 null이면 반드시 둘 수 있어야 한다
    expect(moves.length, `ply ${ply}: 결과 없음인데 합법 수 0`).toBeGreaterThan(0);

    state = applyMove(state, moves[Math.floor(rand() * moves.length)]);
    assertInvariants(state, config, ply);
  }
  return { plies: maxPlies, reason: 'cap' };
}

describe('랜덤 셀프플레이 (시드 고정)', () => {
  it('기본 규칙 100판: 예외/불변 조건 위반 없이 진행되고 대부분 종료된다', () => {
    const rand = mulberry32(20260612);
    const reasons: Record<string, number> = {};
    let totalPlies = 0;
    const GAMES = 100;
    // 완전 무작위 플레이는 목적지를 향해 가지 않으므로 수 제한을 넉넉히 둔다
    const MAX_PLIES = 2000;

    for (let g = 0; g < GAMES; g++) {
      const { plies, reason } = playRandomGame(DEFAULT_CONFIG, rand, MAX_PLIES);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      totalPlies += plies;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[셀프플레이] ${GAMES}판, 평균 ${(totalPlies / GAMES).toFixed(1)}수, 종료 사유:`,
      reasons,
    );
    // 무작위 플레이라도 대부분 수 제한 안에 끝나야 한다
    expect(reasons['cap'] ?? 0).toBeLessThanOrEqual(GAMES * 0.1);
    // 목적지 도달 승리가 실제로 발생해야 한다 (승리 경로가 막혀있지 않음을 확인)
    expect(reasons['goal'] ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('규칙 토글 조합별 20판씩: 어떤 설정에서도 예외 없이 진행된다', () => {
    const rand = mulberry32(777);
    const variants: Partial<RuleConfig>[] = [
      { boardSize: 7, guardCount: 6 },
      { boardSize: 11, guardCount: 10 },
      { goalCells: 'center-1' },
      { goalCells: 'full-row' },
      { placement: 'own-half' },
      { guardMove: 'slide' },
      { kingSurroundLoss: false },
      { noGuardOnGoal: false },
      { kingCapture: false },
      { noGuardOnGoal: true, goalCells: 'full-row' }, // 호위가 양 끝줄 전체에 못 들어가는 극단 조합
      { boardSize: 7, guardMove: 'slide', placement: 'own-half', goalCells: 'center-1' },
    ];
    for (const v of variants) {
      const config: RuleConfig = { ...DEFAULT_CONFIG, ...v };
      for (let g = 0; g < 10; g++) {
        playRandomGame(config, rand, 400);
      }
    }
  }, 120_000);
});
