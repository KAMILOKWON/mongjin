export interface RuleConfig {
  boardSize: number;
  guardCount: number;
  goalCells: 'full-row' | 'center-3' | 'center-1';
  placement: 'adjacent' | 'own-half';
  guardMove: 'step' | 'slide';
  kingSurroundLoss: boolean;
  /** 호위는 양쪽 목적지 칸에 착수/진입 불가 — 목적지 봉쇄(거북이) 전략 방지 */
  noGuardOnGoal: boolean;
  /** 호위가 상대 왕을 잡으면 즉시 승리 — 알몸 왕 단독 돌진(필승 전략) 차단, 호위 동반 강제 */
  kingCapture: boolean;
}

export const DEFAULT_CONFIG: RuleConfig = {
  boardSize: 9,
  guardCount: 8,
  goalCells: 'center-3',
  placement: 'adjacent',
  guardMove: 'step',
  kingSurroundLoss: true,
  noGuardOnGoal: true,
  kingCapture: true,
};
