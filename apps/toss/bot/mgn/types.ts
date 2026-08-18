import type { RuleConfig } from '../../src/core/config';
import type { GameResult, WinReason } from '../../src/core/result';
import type { Move, Player } from '../../src/core/types';

/** MGN(Mongjin Game Notation) — 체스 PGN에서 차용한 몽진 전용 기보 형식 */
export const MGN_VERSION = '1';

export type MgnResult = Player | 'DRAW';

/** PGN 스타일 수 평가 주석 */
export type MgnAnnotation = '!' | '?' | '!!' | '??' | '!?' | '?!';

export interface MgnMoveEntry {
  move: Move;
  /** 수 직후 코멘트 (학습·전략 메모) */
  comment?: string;
  annotation?: MgnAnnotation;
}

export interface MgnHeaders {
  mgn: string;
  event?: string;
  site?: string;
  date?: string;
  round?: string;
  black: string;
  white: string;
  result: MgnResult;
  /** 대국 종료 사유 */
  termination?: WinReason;
  /** 상대 식별자 — 동일 상대와의 누적 학습용 */
  opponentId?: string;
  /** 봇이 어느 진영이었는지 */
  botSide?: Player;
  config: RuleConfig;
  [key: string]: string | RuleConfig | undefined;
}

export interface MgnGame {
  headers: MgnHeaders;
  moves: MgnMoveEntry[];
}

export interface GameExportMeta {
  black: string;
  white: string;
  opponentId?: string;
  botSide?: Player;
  event?: string;
  site?: string;
}

export interface FinishedGameInput {
  moves: Move[];
  result: GameResult;
  config: RuleConfig;
  meta: GameExportMeta;
}
