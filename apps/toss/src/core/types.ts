export type Player = 'BLACK' | 'WHITE';
export type PieceType = 'KING' | 'GUARD';

export interface Piece {
  player: Player;
  type: PieceType;
}

export interface Coord {
  r: number;
  c: number;
}

export type Move =
  | { kind: 'PLACE'; to: Coord }
  | { kind: 'MOVE'; from: Coord; to: Coord };

export interface GameState {
  board: (Piece | null)[][];
  turn: Player;
  guardsInHand: Record<Player, number>;
  history: Move[];
  /** AI의 반복 회피용: positionKey → 등장 횟수 (승패 판정에는 사용하지 않음) */
  positionCounts: Record<string, number>;
}
