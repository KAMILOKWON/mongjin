/** 전략서에 정리되는 개별 전술·패턴 */
export type StrategyPhase = 'opening' | 'middlegame' | 'endgame' | 'counter';

export interface StrategyEntry {
  id: string;
  title: string;
  phase: StrategyPhase;
  /** 한 줄 요약 */
  summary: string;
  /** MGN 수열 조각 (예: "1. @d4 @d5 2. Ke1-e2") */
  mgnPattern: string;
  /** 상대 유형·스타일 태그 */
  tags: string[];
  /** 학습에서 도출된 교훈 */
  lessons: string[];
  /** 근거가 된 기보 ID 목록 */
  sourceGames: string[];
  /** 0~1 신뢰도 — 같은 패턴이 여러 대국에서 반복될수록 상승 */
  confidence: number;
  updatedAt: string;
}

export interface OpponentProfile {
  opponentId: string;
  displayName: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  /** 자주 쓰는 수술 키워드 */
  tendencies: string[];
  /** 이 상대에게 효과적이었던 전략 ID */
  effectiveStrategies: string[];
  lastPlayedAt?: string;
}

export interface LearningSession {
  gameId: string;
  analyzedAt: string;
  /** Fable 분석 요약 (사람이 읽을 수 있는 메모) */
  analysisSummary: string;
  /** 새로 추가·갱신된 전략 ID */
  strategyIds: string[];
}
