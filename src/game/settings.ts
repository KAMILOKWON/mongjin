import type { Player } from '../core/types';

export type OpponentMode = 'ai' | 'local' | 'online' | 'ghost';
export type HumanColorChoice = 'BLACK' | 'WHITE' | 'random';
/** 화면에 노출하는 쉬움 · 보통 · 어려움 3단계 */
export type AiDifficulty = 'easy' | 'normal' | 'hard';

export interface AiDifficultyPreset {
  label: string;
  description: string;
  maxMs: number;
  maxDepth: number;
  /** 시계 속도와 무관하게 난이도를 유지하는 탐색 노드 상한. */
  maxNodes: number;
  /** 수 선택 평가 오차 폭. 낮을수록 정확하고, 어려움은 0이다. */
  rootNoise?: number;
  /** 순수 탐색 최선점수에서 무작위 선택 후보로 인정할 점수 차이. */
  choiceWindow: number;
  /** 왕 전진·호위·마무리 계획을 루트 선택에 반영하는 강도. */
  planStrength?: number;
  /** 정적 평가 수준: 1 기본, 2 왕 안전, 3 포위·정밀 탐색. */
  strategyLevel?: 1 | 2 | 3;
  /** 전략서 힌트 배율 (기본 1). */
  hintScale?: number;
  /** 선택적 보수적 LMR·반복 억제·포위 압력. 어려움 전용. */
  elite?: boolean;
}

/**
 * 완료 깊이·노드 예산으로 강도를 고정하고 maxMs는 기기별 안전 한계로만 쓴다.
 * 각 프리셋은 제한 시간 안에 반복 심화를 끝낼 수 있는 노드 예산을 쓴다.
 * 쉬움은 기본 전술 안전장치를 갖춘 입문용, 보통은 전략 평가와 함께
 * 중급 수준의 읽기를 제공한다. 어려움은 5초 제한에 여유를 둔 4.3초 동안
 * 반복 심화를 계속하며, 순수 탐색 최선수와 거의 같은 수만 섞는다.
 */
export const AI_DIFFICULTY_PRESETS: Record<AiDifficulty, AiDifficultyPreset> = {
  easy: {
    label: '쉬움',
    description: '규칙에 맞는 기본 수를 차분히 둔다',
    maxMs: 300,
    maxDepth: 4,
    maxNodes: 1_500,
    rootNoise: 80,
    choiceWindow: 80,
    planStrength: 0.85,
    strategyLevel: 1,
  },
  normal: {
    label: '보통',
    description: '전술과 기본 수비를 읽고 계획적으로 둔다',
    maxMs: 1_400,
    maxDepth: 5,
    maxNodes: 10_000,
    rootNoise: 28,
    choiceWindow: 28,
    planStrength: 1.1,
    strategyLevel: 2,
  },
  hard: {
    label: '어려움',
    description: '최선 수를 깊게 읽어 빈틈을 놓치지 않는다',
    maxMs: 4300,
    maxDepth: 14,
    maxNodes: 100_000,
    rootNoise: 0,
    choiceWindow: 2,
    planStrength: 1.7,
    strategyLevel: 3,
    elite: true,
  },
};

export interface GameSettings {
  mode: OpponentMode;
  humanColor: HumanColorChoice;
  aiDifficulty: AiDifficulty;
}

export function resolveHumanSide(choice: HumanColorChoice, rand = Math.random): Player {
  if (choice === 'BLACK') return 'BLACK';
  if (choice === 'WHITE') return 'WHITE';
  return rand() < 0.5 ? 'BLACK' : 'WHITE';
}

export function opponentOf(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}
