# 모바일 개발

몽진의 모바일 앱은 `apps/mobile`의 React Native + Expo 앱 하나로 iPhone과 Android를 함께 빌드한다.

## 실행

```bash
npm install --prefix apps/mobile
npm run dev:mobile
```

Expo 개발 서버에서 iOS Simulator 또는 Android Emulator를 선택한다.

## 구조

- `apps/mobile/src/game/engine.ts`: 기존 iOS SwiftUI `GameSession`을 이식한 공용 모바일 세션
- `apps/mobile/src/screens`: 홈, AI 설정, 매칭, 프로필, 튜토리얼, 대국 화면
- `apps/mobile/src/online.ts`: React Native WebSocket 클라이언트
- `apps/mobile/src/storage.ts`: AsyncStorage 기반 프로필·고스트 저장소
- `packages/game-core`: 규칙·상태·결과 판정 경계
- `packages/game-ai`: AI·전술 경계
- `packages/game-data`: 난이도·고스트·게임 설정 경계

게임 규칙과 AI는 루트 `src`의 순수 TypeScript 구현을 패키지 경계로 노출해 웹·앱인토스와 공유한다. 모바일 UI는 DOM/CSS를 사용하지 않고 React Native 컴포넌트로 구현한다.

## SwiftUI 기능 대응 범위

`apps/ios`의 제출 기준 앱은 기능 비교 기준으로 유지하고, 새 앱은 다음 흐름을 모두 대응한다.

- 홈: 빠른 대전·컴퓨터·같이 두기 탭, 프로필 요약, 튜토리얼
- 컴퓨터: 쉬움·보통·어려움, 흑·백·랜덤 선택
- 빠른 대전: WebSocket 매칭, 15초 후 고스트 대체, 취소·연결 실패 처리
- 대국: 9×9 보드, 목적지·선택·최근 수·착수·잡기 하이라이트, 흑/백 호위 보관함
- 대국 상태: AI/상대 생각 중, 고스트 기보 일치도·응수 설명, 빠른 대전 60초 시계
- 종료: 목표 도달·왕 잡기·포위·둘 수 없음·항복·시간 초과 결과와 확인 모달
- 튜토리얼: 5단계 규칙 안내, 단계 표시, 힌트, 컴퓨터 연습 전환
- 프로필: 닉네임 검증·저장, 로컬/온라인 Elo·승패·승률

제출된 SwiftUI 앱은 즉시 삭제하지 않고 `apps/ios`에 보존한다. 스토어 전환 시에는 `apps/mobile`에서 iOS·Android를 함께 검증한 뒤, 기존 iOS 번들을 새 앱으로 교체하는 별도 마이그레이션 릴리스를 진행한다.

## 빌드

```bash
npm run typecheck:mobile
npm run build:mobile
```

새 Expo 제출 타깃에는 광고 SDK를 포함하지 않는다. 광고·추적 권한 없이 핵심 대국 기능과 온라인 WebSocket 기능만 제공한다.
