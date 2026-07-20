# 몽진 (蒙塵)

왕을 호위하며 상대 진영의 목적지까지 피난시키는 추상 전략 보드게임. 컴퓨터(AI)와 1:1 대결.

**▶ 바로 플레이: https://kamilokwon.github.io/mongjin/**

- 매 턴 **호위 두기** 또는 **말 옮기기** 중 하나를 선택
- 자기 **왕(王)** 을 상대 진영 끝줄 중앙 목적지에 먼저 도달시키면 승리
- 호위는 상대 호위와 **상대 왕**을 잡을 수 있다 — **왕이 잡히면 즉시 패배**, 왕은 호위와 함께 움직여야 안전
- 플레이 화면 상단에서 **컴퓨터·같이 두기·온라인** 대전 모드를 바로 선택 가능
- 컴퓨터전은 **보통·어려움·고수·올마이트** 4단계이며, `올마이트`는 강화된 전술·전략서를 사용하면서도 최대 1.5초 안에 응수하는 최고 난이도

**온라인 대전** (GitHub Pages): 대전 방식 → 온라인 → **입장코드 생성** 후 친구에게 코드 공유, 같은 코드로 **참가**하면 1:1 대전. 온라인 서버는 [Render](https://render.com) `mongjin-api` WebSocket(`wss://mongjin-api.onrender.com`)을 사용합니다. 최초 1회 [Blueprint 배포](https://render.com/deploy?repo=https://github.com/KAMILOKWON/mongjin) 후 GitHub `RENDER_DEPLOY_HOOK` 시크릿을 설정하면 `server/` 변경 시 자동 재배포됩니다.

디자인 문서: [PLAN.md](./PLAN.md)

## 실행

```bash
npm install
npm run dev          # http://localhost:5173
npm run server:dev   # ws://localhost:3001 — 온라인 대전용 (별도 터미널)
npm test
npm run build
```

## 구조

```
src/
├── core/      # 순수 게임 로직 (DOM 의존 없음, 단위 테스트 대상)
│   ├── types.ts    # GameState, Move, Piece
│   ├── config.ts   # RuleConfig — 플레이테스트용 규칙 토글
│   ├── rules.ts    # 합법 수 생성, 초기 국면
│   ├── apply.ts    # 수 적용 (불변 상태)
│   └── result.ts   # 승패 판정 (목적지/왕 잡기/포위/수 없음)
└── main.ts    # 보드 UI, 핫시트 대전, 규칙 설정 패널
```
