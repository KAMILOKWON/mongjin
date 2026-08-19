import type { GhostTape } from './types';

const ADJECTIVES = [
  '고요한', '기민한', '느긋한', '단단한', '맑은', '빠른',
  '용감한', '은빛', '작은', '푸른', '환한', '흐르는',
] as const;

const NOUNS = [
  '구름', '나루', '달빛', '매화', '바람', '별',
  '사슴', '소나무', '여우', '제비', '파도', '호랑이',
] as const;

export interface GhostNicknameOptions {
  previousName?: string | null;
  playerName?: string | null;
  random?: () => number;
}

/** 빠른 대전 폴백 상대에게만 쓰는 일회성 표시 이름을 만든다. */
export function createGhostNickname(options: GhostNicknameOptions = {}): string {
  const random = options.random ?? Math.random;
  const blocked = new Set([options.previousName, options.playerName].filter(Boolean));
  const count = ADJECTIVES.length * NOUNS.length;
  const start = Math.min(count - 1, Math.floor(Math.max(0, random()) * count));

  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    const name = `${ADJECTIVES[Math.floor(index / NOUNS.length)]}${NOUNS[index % NOUNS.length]}`;
    if (!blocked.has(name)) return name;
  }

  return `나그네${String(Date.now()).slice(-4)}`;
}

/** 원본 기보는 보존하고 이번 매칭에서 보일 이름만 교체한다. */
export function withEphemeralGhostNickname(
  tape: GhostTape,
  options: GhostNicknameOptions = {},
): GhostTape {
  return { ...tape, ownerName: createGhostNickname(options) };
}
