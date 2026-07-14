import type { Player } from '../core/types';

export type OpponentMode = 'ai' | 'local' | 'online';
export type HumanColorChoice = 'BLACK' | 'WHITE' | 'random';
export type AiDifficulty = 'normal' | 'hard' | 'expert';

export interface AiDifficultyPreset {
  label: string;
  description: string;
  maxMs: number;
  maxDepth: number;
}

/**
 * 제한 시간이 늘어날수록 반복 심화가 더 깊게 완료된다.
 * 어려움을 기본으로 두어 기존 기본값(1.8초/20수)보다 강하게 설정한다.
 */
export const AI_DIFFICULTY_PRESETS: Record<AiDifficulty, AiDifficultyPreset> = {
  normal: {
    label: '보통',
    description: '빠르게 둔다',
    maxMs: 800,
    maxDepth: 12,
  },
  hard: {
    label: '어려움',
    description: '수비와 반격을 깊게 읽는다',
    maxMs: 2400,
    maxDepth: 24,
  },
  expert: {
    label: '고수',
    description: '최대 탐색으로 도전한다',
    maxMs: 3800,
    maxDepth: 32,
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
