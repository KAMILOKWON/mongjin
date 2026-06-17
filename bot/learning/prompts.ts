import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MgnGame } from '../mgn/types';
import { serializeGame } from '../mgn/format';
import type { OpponentProfile, StrategyEntry } from './types';

const BOT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadFableSystemPrompt(): string {
  return readFileSync(join(BOT_ROOT, 'CLAUDE-FABLE-5.md'), 'utf8');
}

export function loadMongjinBotPrompt(): string {
  return readFileSync(join(BOT_ROOT, 'prompts', 'mongjin-bot.md'), 'utf8');
}

export interface AnalysisPromptInput {
  game: MgnGame;
  gameId: string;
  existingStrategies?: StrategyEntry[];
  opponentProfile?: OpponentProfile;
}

/** 대국 종료 후 Fable에 보낼 학습·분석 프롬프트 */
export function buildGameAnalysisPrompt(input: AnalysisPromptInput): {
  system: string;
  user: string;
} {
  const mongjin = loadMongjinBotPrompt();
  const strategies = input.existingStrategies ?? [];

  const strategyBlock =
    strategies.length > 0
      ? strategies
          .map((s) => `- **${s.title}**: ${s.summary} (패턴: ${s.mgnPattern})`)
          .join('\n')
      : '(없음)';

  const opponentBlock = input.opponentProfile
    ? `대국 수: ${input.opponentProfile.gamesPlayed}, 승/패: ${input.opponentProfile.wins}/${input.opponentProfile.losses}\n성향: ${input.opponentProfile.tendencies.join(', ') || '미분류'}`
    : '(첫 대국)';

  const system = `${mongjin}

---

## 현재 전략서
${strategyBlock}

## 상대 프로필 (${input.game.headers.opponentId ?? 'unknown'})
${opponentBlock}`;

  const user = `다음 MGN 기보를 분석하고, 이 대국과 상대로부터 배울 전략을 도출하세요.

기보 ID: ${input.gameId}

\`\`\`mgn
${serializeGame(input.game)}
\`\`\`

다음 JSON 형식으로만 응답하세요:
\`\`\`json
{
  "analysisSummary": "대국 요약 (3~5문장)",
  "opponentTendencies": ["상대 성향 키워드"],
  "strategies": [
    {
      "id": "kebab-case-id",
      "title": "전략 이름",
      "phase": "opening|middlegame|endgame|counter",
      "summary": "한 줄 설명",
      "mgnPattern": "핵심 수술 MGN 조각",
      "tags": ["태그"],
      "lessons": ["교훈 1", "교훈 2"]
    }
  ],
  "annotatedMoves": [
    { "moveIndex": 0, "annotation": "!", "comment": "이유" }
  ]
}
\`\`\``;

  return { system, user };
}

export interface StrategyReviewPromptInput {
  strategies: StrategyEntry[];
  recentGames: MgnGame[];
}

/** 여러 대국을 종합해 전략서를 정리·병합하는 프롬프트 */
export function buildStrategyReviewPrompt(input: StrategyReviewPromptInput): {
  system: string;
  user: string;
} {
  const system = `${loadMongjinBotPrompt()}

당신은 몽진 봇의 전략서 편집자입니다. 중복 전략을 병합하고, 신뢰도를 조정하며, 상대 유형별 대응책을 정리합니다.`;

  const gamesBlock = input.recentGames
    .map((g, i) => `### 대국 ${i + 1}\n\`\`\`mgn\n${serializeGame(g)}\n\`\`\``)
    .join('\n\n');

  const user = `현재 전략 ${input.strategies.length}개와 최근 대국 ${input.recentGames.length}개를 검토해 전략서를 정리하세요.

## 현재 전략
\`\`\`json
${JSON.stringify(input.strategies, null, 2)}
\`\`\`

## 최근 대국
${gamesBlock}

병합·삭제·신규 추가가 반영된 최종 전략 목록을 동일 JSON 스키마(strategies 배열)로 응답하세요.`;

  return { system, user };
}

/** API 호출용 메시지 배열 (Claude Messages API 형식) */
export function toApiMessages(prompt: { system: string; user: string }) {
  return {
    system: prompt.system,
    messages: [{ role: 'user' as const, content: prompt.user }],
  };
}
