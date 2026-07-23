# 몽진 (蒙塵)

왕을 호위하며 상대 진영의 목적지까지 피난시키는 추상 전략 보드게임. 컴퓨터(AI)와 1:1 대결.

**▶ 바로 플레이: https://kamilokwon.github.io/mongjin/**

- 매 턴 **호위 두기** 또는 **말 옮기기** 중 하나를 선택
- 자기 **왕(王)** 을 상대 진영 끝줄 중앙 목적지에 먼저 도달시키면 승리
- 호위는 상대 호위와 **상대 왕**을 잡을 수 있다 — **왕이 잡히면 즉시 패배**, 왕은 호위와 함께 움직여야 안전
- 홈의 **랜덤 대전**에서 접속 중인 플레이어와 자동 매칭하며, 흑·백은 매 대국 무작위로 정해짐
- 기기별 익명 프로필에 **승·패·승률·Elo 레이팅·전체 순위**가 누적되고 닉네임을 변경할 수 있음
- **친구 대전**은 기존처럼 6자리 입장코드를 공유해 플레이 가능하며 공식 전적에는 반영되지 않음
- 컴퓨터전은 **보통·어려움·고수·올마이트** 4단계이며, 난이도마다 탐색량·평가 오차·왕 안전/차단 전략이 구분됩니다. `올마이트`는 최대 3초 동안 가장 깊고 정밀하게 탐색하는 최고 난이도입니다.

**온라인 대전** (GitHub Pages): **랜덤 대전**은 서버 대기열의 다른 플레이어와 자동으로 연결되고, **친구 대전**은 입장코드로 연결됩니다. 온라인 서버는 [Render](https://render.com) `mongjin-api` WebSocket(`wss://mongjin-api.onrender.com`)을 사용합니다. 최초 1회 [Blueprint 배포](https://render.com/deploy?repo=https://github.com/KAMILOKWON/mongjin) 후 GitHub `RENDER_DEPLOY_HOOK` 시크릿을 설정하면 `server/` 변경 시 자동 재배포됩니다.

프로필과 전적은 서버의 JSON 저장소에 원자적으로 기록됩니다. 기본 경로는 `server/data/profiles.json`이며, 운영에서 재배포·재시작 후에도 보존하려면 영구 디스크를 연결하고 `MONGJIN_PROFILE_DATA_FILE=/마운트경로/profiles.json` 환경 변수를 지정하세요.

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
