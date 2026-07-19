import type { Coord, GameState, Move, Piece, Player } from './types';
import type { RuleConfig } from './config';

export const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export const ALL8: ReadonlyArray<readonly [number, number]> = [
  ...ORTHO,
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

export function opponent(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

export function inBoard(n: number, r: number, c: number): boolean {
  return r >= 0 && r < n && c >= 0 && c < n;
}

/** 흑은 아래(r = n-1)에서 시작해 위(r = 0)로, 백은 그 반대로 전진한다. */
export function homeRow(player: Player, n: number): number {
  return player === 'BLACK' ? n - 1 : 0;
}

export function goalRow(player: Player, n: number): number {
  return player === 'BLACK' ? 0 : n - 1;
}

export function goalCellsFor(player: Player, config: RuleConfig): Coord[] {
  const n = config.boardSize;
  const row = goalRow(player, n);
  const mid = Math.floor(n / 2);
  switch (config.goalCells) {
    case 'full-row':
      return Array.from({ length: n }, (_, c) => ({ r: row, c }));
    case 'center-3':
      return [mid - 1, mid, mid + 1].map((c) => ({ r: row, c }));
    case 'center-1':
      return [{ r: row, c: mid }];
  }
}

export function isGoalCell(player: Player, coord: Coord, config: RuleConfig): boolean {
  return goalCellsFor(player, config).some((g) => g.r === coord.r && g.c === coord.c);
}

/** 흑·백 어느 쪽이든 목적지인 칸 (noGuardOnGoal 규칙에서 호위 진입 금지 대상) */
export function isAnyGoalCell(coord: Coord, config: RuleConfig): boolean {
  return isGoalCell('BLACK', coord, config) || isGoalCell('WHITE', coord, config);
}

export function initialState(config: RuleConfig): GameState {
  const n = config.boardSize;
  const board: (Piece | null)[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null),
  );
  const mid = Math.floor(n / 2);
  board[homeRow('BLACK', n)][mid] = { player: 'BLACK', type: 'KING' };
  board[homeRow('WHITE', n)][mid] = { player: 'WHITE', type: 'KING' };
  return {
    board,
    turn: 'BLACK',
    guardsInHand: { BLACK: config.guardCount, WHITE: config.guardCount },
    history: [],
  };
}

export function positionKey(state: GameState): string {
  const cells = state.board
    .map((row) =>
      row
        .map((p) => {
          if (!p) return '.';
          const ch = p.type === 'KING' ? 'k' : 'g';
          return p.player === 'BLACK' ? ch : ch.toUpperCase();
        })
        .join(''),
    )
    .join('/');
  return `${state.turn}|${state.guardsInHand.BLACK},${state.guardsInHand.WHITE}|${cells}`;
}

export function findKing(state: GameState, player: Player): Coord | null {
  const n = state.board.length;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = state.board[r][c];
      if (p && p.type === 'KING' && p.player === player) return { r, c };
    }
  }
  return null;
}

function placementCells(state: GameState, config: RuleConfig): Coord[] {
  const n = state.board.length;
  const me = state.turn;
  const out: Coord[] = [];
  const seen = new Set<string>();

  if (config.placement === 'own-half') {
    const mid = Math.floor(n / 2);
    for (let r = 0; r < n; r++) {
      const inHalf = me === 'BLACK' ? r > mid : r < mid;
      if (!inHalf) continue;
      for (let c = 0; c < n; c++) {
        if (!state.board[r][c]) out.push({ r, c });
      }
    }
  } else {
    // adjacent: 자기 말(왕 포함)과 상하좌우로 인접한 빈 칸
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const p = state.board[r][c];
        if (!p || p.player !== me) continue;
        for (const [dr, dc] of ORTHO) {
          const nr = r + dr;
          const nc = c + dc;
          if (!inBoard(n, nr, nc) || state.board[nr][nc]) continue;
          const key = `${nr},${nc}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ r: nr, c: nc });
        }
      }
    }
  }

  return config.noGuardOnGoal ? out.filter((c) => !isAnyGoalCell(c, config)) : out;
}

function pieceMoves(state: GameState, from: Coord, config: RuleConfig): Move[] {
  const n = state.board.length;
  const piece = state.board[from.r][from.c]!;
  const me = piece.player;
  const out: Move[] = [];

  if (piece.type === 'KING') {
    // 왕: 8방향 1칸, 빈 칸으로만 (잡지 못한다)
    for (const [dr, dc] of ALL8) {
      const r = from.r + dr;
      const c = from.c + dc;
      if (inBoard(n, r, c) && !state.board[r][c]) {
        out.push({ kind: 'MOVE', from, to: { r, c } });
      }
    }
    return out;
  }

  // 호위: 상하좌우. 빈 칸 이동 또는 상대 호위 잡기.
  // kingCapture가 켜져 있으면 상대 왕도 잡을 수 있다 (즉시 승리).
  // noGuardOnGoal이 켜져 있으면 목적지 칸에는 멈출 수 없다 (slide는 통과만 가능).
  // 단, 왕 잡기는 목적지 금지의 예외 — 잡는 순간 게임이 끝나므로.
  const canCapture = (t: Piece) =>
    t.player !== me && (t.type === 'GUARD' || config.kingCapture);
  const guardCanStop = (r: number, c: number) =>
    !config.noGuardOnGoal || !isAnyGoalCell({ r, c }, config);
  const canLand = (r: number, c: number, t: Piece | null) =>
    t ? canCapture(t) && (t.type === 'KING' || guardCanStop(r, c)) : guardCanStop(r, c);

  for (const [dr, dc] of ORTHO) {
    if (config.guardMove === 'step') {
      const r = from.r + dr;
      const c = from.c + dc;
      if (!inBoard(n, r, c)) continue;
      if (canLand(r, c, state.board[r][c])) out.push({ kind: 'MOVE', from, to: { r, c } });
    } else {
      // slide: 빈 칸을 따라 직선 이동, 첫 상대 말에서 잡고 멈춤
      let r = from.r + dr;
      let c = from.c + dc;
      while (inBoard(n, r, c)) {
        const target = state.board[r][c];
        if (canLand(r, c, target)) out.push({ kind: 'MOVE', from, to: { r, c } });
        if (target) break;
        r += dr;
        c += dc;
      }
    }
  }
  return out;
}

export function legalMoves(state: GameState, config: RuleConfig): Move[] {
  const n = state.board.length;
  const me = state.turn;
  const out: Move[] = [];

  if (state.guardsInHand[me] > 0) {
    for (const to of placementCells(state, config)) {
      out.push({ kind: 'PLACE', to });
    }
  }

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = state.board[r][c];
      if (p && p.player === me) {
        out.push(...pieceMoves(state, { r, c }, config));
      }
    }
  }
  return out;
}
