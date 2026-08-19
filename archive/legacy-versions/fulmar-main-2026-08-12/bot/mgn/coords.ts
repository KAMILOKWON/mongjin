import type { Coord } from '../../src/core/types';

const FILES = 'abcdefghijk';

/** 내부 좌표 → 기보 표기 (예: e5). rank 1 = 흑 진영, rank n = 백 진영 */
export function toSquare(coord: Coord, boardSize: number): string {
  const file = FILES[coord.c];
  const rank = boardSize - coord.r;
  return `${file}${rank}`;
}

export function fromSquare(square: string, boardSize: number): Coord {
  const file = square.charAt(0).toLowerCase();
  const rank = Number.parseInt(square.slice(1), 10);
  const c = FILES.indexOf(file);
  if (c < 0 || c >= boardSize || !Number.isFinite(rank) || rank < 1 || rank > boardSize) {
    throw new Error(`잘못된 기보 좌표: ${square} (보드 ${boardSize}×${boardSize})`);
  }
  return { r: boardSize - rank, c };
}
