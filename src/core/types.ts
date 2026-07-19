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
}
