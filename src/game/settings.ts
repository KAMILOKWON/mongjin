import type { Player } from '../core/types';

export type OpponentMode = 'ai' | 'local' | 'online';
export type HumanColorChoice = 'BLACK' | 'WHITE' | 'random';
export type AiDifficulty = 'normal' | 'hard' | 'expert' | 'allMight';

export interface AiDifficultyPreset {
  label: string;
  description: string;
  maxMs: number;
  maxDepth: number;
  /** 시계 속도와 무관하게 난이도를 유지하는 탐색 노드 상한. */
  maxNodes: number;
  /** 수 선택 평가 오차 폭. 낮을수록 정확하고, 올마이트는 0이다. */
  rootNoise?: number;
  /** 왕 전진·호위·마무리 계획을 루트 선택에 반영하는 강도. */
  planStrength?: number;
  /** 전략서 힌트 배율 (기본 1). */
  hintScale?: number;
  /** 선택적 보수적 LMR·반복 억제·포위 압력. */
  elite?: boolean;
}

/**
 * 완료 깊이·노드 예산으로 강도를 고정하고 maxMs는 기기별 안전 한계로만 쓴다.
 * 각 프리셋은 제한 시간 안에 반복 심화를 끝낼 수 있는 노드 예산을 쓴다.
 * 올마이트는 최대 1.5초·깊이 8로 탐색하는 최고 난이도다.
 */
export const AI_DIFFICULTY_PRESETS: Record<AiDifficulty, AiDifficultyPreset> = {
  normal: {
    label: '보통',
    description: '빠르게 두며 공격 기회를 노린다',
    maxMs: 200,
    maxDepth: 4,
    maxNodes: 700,
    rootNoise: 120,
    planStrength: 0.9,
  },
  hard: {
    label: '어려움',
    description: '수비와 반격을 깊게 읽는다',
    maxMs: 800,
    maxDepth: 6,
    maxNodes: 2_250,
    rootNoise: 35,
    planStrength: 1.15,
  },
  expert: {
    label: '고수',
    description: '깊게 탐색해 추격과 포위를 노린다',
    maxMs: 1500,
    maxDepth: 7,
    maxNodes: 6_000,
    rootNoise: 0,
    planStrength: 2.4,
  },
  allMight: {
    label: '올마이트',
    description: '최고 수를 1.5초 안에 읽는다',
    maxMs: 1500,
    maxDepth: 8,
    maxNodes: 6_500,
    rootNoise: 0,
    planStrength: 3,
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
