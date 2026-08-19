import type { GameState, Move, Player } from '../core/types';
import type { GameResult } from '../core/result';

export type GhostSource = 'seed' | 'local' | 'imported';

/**
 * 고스트 파일의 공통 포맷. iOS의 GhostTape/GhostSharePayload와 JSON 호환된다.
 * 날짜는 ISO-8601 문자열로 저장해 WebView와 Swift Codable 양쪽에서 읽는다.
 */
export interface GhostTape {
  id: string;
  ownerName: string;
  ownerRating: number;
  /** 원래 플레이어가 둔 진영. 도전자는 반대 진영을 맡는다. */
  side: Player;
  /** 해당 진영이 둔 수만 시간순으로 기록한다. */
  moves: Move[];
  result: GameResult;
  plyCount: number;
  createdAt: string;
  source: GhostSource;
  note: string;
}

export interface GhostSharePayload {
  version: 1;
  tape: GhostTape;
}

export interface GhostPlayerCard {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  defenseGhostID: string | null;
}

export interface GhostCatalog {
  profile: GhostPlayerCard;
  tapes: GhostTape[];
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ghostFromFinishedGame(
  state: GameState,
  result: GameResult,
  ownerName: string,
  ownerRating: number,
  side: Player,
  source: GhostSource,
  note = '',
): GhostTape {
  const moves = state.history.filter((_, index) => (index % 2 === 0 ? 'BLACK' : 'WHITE') === side);
  return {
    id: newId(),
    ownerName,
    ownerRating,
    side,
    moves,
    result,
    plyCount: state.history.length,
    createdAt: new Date().toISOString(),
    source,
    note,
  };
}

export function encodeGhost(tape: GhostTape): string {
  const payload: GhostSharePayload = { version: 1, tape };
  return JSON.stringify(payload, null, 2);
}

export function decodeGhost(raw: string): GhostTape {
  const parsed = JSON.parse(raw) as Partial<GhostSharePayload> & Partial<GhostTape>;
  const tape = parsed.version === 1 && parsed.tape ? parsed.tape : parsed;
  if (!tape || !Array.isArray(tape.moves) || !tape.result || !tape.side) {
    throw new Error('invalid ghost tape');
  }
  return {
    ...(tape as GhostTape),
    id: newId(),
    source: 'imported',
  };
}
