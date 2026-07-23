# 몽진 봇 (bot/)

몽진의 **지능·학습·전략**을 담당하는 폴더입니다. 런타임 응수(`src/ai/`)와 분리되어, Fable 기반 분석 파이프라인과 MGN 기보 체계를 제공합니다.

## 구조

```
bot/
├── CLAUDE-FABLE-5.md     # Fable 시스템 프롬프트 (기반 모델 행동)
├── prompts/
│   └── mongjin-bot.md    # 몽진 전용 역할·학습 지침
├── mgn/                  # MGN 기보 형식 (PGN 차용)
│   ├── format.ts         # 직렬화·파싱
│   └── replay.ts         # 기보 재생
├── learning/
│   ├── gameRecord.ts     # 종료 대국 → MGN
│   ├── strategyBook.ts   # 전략서·상대 프로필
│   └── prompts.ts        # Fable 분석 프롬프트 생성
├── games/                # 저장된 .mgn 기보
└── strategies/           # 도출된 전략 JSON
```

## 웹 런타임 (`src/bot/`)

- **미니맥스**가 항상 최종 수를 결정 (합법 수·무오류 보장)
- **전략서**는 수 정렬·평가 보정만 (검색 생략 없음)
- `seed.json` + `generated.json` + localStorage 학습

### 셀프플레이로 전략 갱신

```bash
npm run bot:selfplay              # 60판 (fast, 기본)
npm run bot:selfplay 120          # 120판 fast
npm run bot:selfplay -- 100 --strong          # strong + 전략 merge
npm run bot:selfplay -- 100 --strong --replace
npm run bot:bench                 # 보통 vs 어려움 20판 페어 벤치
npm run bot:bench -- 20 --full    # 실제 시간 프리셋(매우 느림)
```

→ `bot/strategies/generated.json` + `bot/games/selfplay/*.mgn`

벤치는 10개의 강제 오프닝을 흑·백 교차 배정하고, 무승부를 승리로 계산하지 않는다. 어려움이 전체 20판 중 18승(90%) 미만이면 종료 코드 2를 반환한다.

## MGN (Mongjin Game Notation)

체스 PGN에서 차용한 몽진 전용 기보입니다.

```mgn
[MGN "1"]
[Event "Human vs Mongjin"]
[Black "Human"]
[White "Mongjin-AI"]
[Result "BLACK"]
[termination "goal"]
[boardSize "9"]
...

1. @e2 @e8 2. @d2 @d8 {측면 벽} 3. Ke1-e2 Ge8xe3!
```

- **착수**: `@파일랭크` (예: `@e4`)
- **이동**: `K`/`G` + 출발 + `-`/`x` + 도착
- **헤더**: PGN과 같이 `[Key "Value"]` — 규칙 설정·상대 ID·봇 진영 포함

## 학습 파이프라인

```
대국 종료 → gameRecord.exportGameMgn()
         → bot/games/*.mgn 저장
         → prompts.buildGameAnalysisPrompt() + Fable API
         → JSON 분석 결과
         → strategyBook.addStrategy()
         → bot/strategies/*.json
```

### Fable 호출 예시 (Node)

```ts
import { exportGameMgn } from './bot/learning/gameRecord';
import { buildGameAnalysisPrompt, toApiMessages } from './bot/learning/prompts';
import { StrategyBook } from './bot/learning/strategyBook';

const book = new StrategyBook();
const { id, game } = exportGameMgn({ state, result, config, settings, humanSide });
const prompt = buildGameAnalysisPrompt({
  gameId: id,
  game,
  existingStrategies: book.exportJson(),
  opponentProfile: book.getOpponent(game.headers.opponentId!),
});
// Anthropic API: system + messages from toApiMessages(prompt)
```

## 테스트

```bash
npm test -- bot/mgn/format.test.ts
```

## 다음 단계 (제안)

- [ ] 대국 종료 시 MGN 자동 저장 (브라우저 localStorage 또는 서버)
- [ ] `scripts/analyze-game.mjs` — CLI로 Fable 분석 실행
- [ ] 전략서 → 미니맥스 평가 가중치 반영
- [ ] 상대별 오프닝 북
