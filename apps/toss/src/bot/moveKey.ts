import type { Move } from '../core/types';

/** 수를 맵 키·비교용 문자열로 직렬화 */
export function moveKey(m: Move): string {
  if (m.kind === 'PLACE') return `P:${m.to.r},${m.to.c}`;
  return `M:${m.from.r},${m.from.c}>${m.to.r},${m.to.c}`;
}

export function movesEqual(a: Move, b: Move): boolean {
  return moveKey(a) === moveKey(b);
}

export function historyKey(moves: Move[]): string {
  return moves.map(moveKey).join('|');
}
