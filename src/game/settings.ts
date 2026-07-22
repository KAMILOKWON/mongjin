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
  /** 전략서 힌트 배율 (기본 1). 올마이트만 강화. */
  hintScale?: number;
  /** elite 탐색(보수적 LMR·반복 억제·포위 압력). 올마이트 전용. */
  elite?: boolean;
}

/**
 * 완료 깊이·노드 예산으로 강도를 고정하고 maxMs는 기기별 안전 한계로만 쓴다.
 * 올마이트는 1.5초 이내에 깊이 7·30,000노드를 탐색하는 최고 난이도다.
 */
export const AI_DIFFICULTY_PRESETS: Record<AiDifficulty, AiDifficultyPreset> = {
  normal: {
    label: '보통',
    description: '빠르게 두며 공격 기회를 노린다',
    maxMs: 200,
    maxDepth: 4,
    maxNodes: 2_000,
    rootNoise: 90,
  },
  hard: {
    label: '어려움',
    description: '수비와 반격을 깊게 읽는다',
    maxMs: 350,
    maxDepth: 5,
    maxNodes: 5_000,
    rootNoise: 35,
  },
  expert: {
    label: '고수',
    description: '깊게 탐색해 추격과 포위를 노린다',
    maxMs: 800,
    maxDepth: 6,
    maxNodes: 14_000,
    rootNoise: 12,
  },
  allMight: {
    label: '올마이트',
    description: '최고 수를 1.5초 안에 읽는다',
    maxMs: 1500,
    maxDepth: 7,
    maxNodes: 30_000,
    rootNoise: 0,
    hintScale: 1.7,
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
