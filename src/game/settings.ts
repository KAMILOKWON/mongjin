import type { Player } from '../core/types';

export type OpponentMode = 'ai' | 'local' | 'online';
export type HumanColorChoice = 'BLACK' | 'WHITE' | 'random';
export type AiDifficulty = 'normal' | 'hard' | 'expert' | 'allMight';

export interface AiDifficultyPreset {
  label: string;
  description: string;
  maxMs: number;
  maxDepth: number;
  /** 수 선택 평가 오차 폭. 낮을수록 정확하고, 올마이트는 0이다. */
  rootNoise?: number;
  /** 전략서 힌트 배율 (기본 1). 올마이트만 강화. */
  hintScale?: number;
  /** elite 탐색(보수적 LMR·반복 억제·포위 압력). 올마이트 전용. */
  elite?: boolean;
}

/**
 * 제한 시간이 늘어날수록 반복 심화가 더 깊게 완료된다.
 * 어려움을 기본으로 두어 기존 기본값(1.8초/20수)보다 강하게 설정한다.
 * 올마이트는 고수 위의 4단계다.
 */
export const AI_DIFFICULTY_PRESETS: Record<AiDifficulty, AiDifficultyPreset> = {
  normal: {
    label: '보통',
    description: '빠르게 둔다',
    maxMs: 800,
    maxDepth: 12,
    rootNoise: 160,
  },
  hard: {
    label: '어려움',
    description: '수비와 반격을 깊게 읽는다',
    maxMs: 2400,
    maxDepth: 24,
    rootNoise: 70,
  },
  expert: {
    label: '고수',
    description: '깊게 탐색해 도전한다',
    maxMs: 3800,
    maxDepth: 32,
    rootNoise: 28,
  },
  allMight: {
    label: '올마이트',
    description: '극한 탐색으로 도전한다',
    maxMs: 12000,
    maxDepth: 64,
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
