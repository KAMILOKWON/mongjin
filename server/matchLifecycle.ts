import type { Player } from '../src/core/types';

/**
 * 흑부터 번갈아 두는 규칙에서 해당 진영이 최소 한 수를 직접 뒀는지 판단한다.
 * 봇이 흑으로 첫 수를 둔 직후 백 이용자가 연결을 잃어도 플레이 전 패배로 기록하지 않는다.
 */
export function hasPlayerTakenTurn(plyCount: number, player: Player): boolean {
  return player === 'BLACK' ? plyCount >= 1 : plyCount >= 2;
}
