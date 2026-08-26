# 몽진 — 앱인토스 미니앱

이 폴더만으로 앱인토스 프론트를 실행·빌드할 수 있습니다. 게임 규칙·AI·고스트 데이터는
저장소 루트의 패키지 경계(`packages/game-core|game-ai|game-data`)를 직접 가져다 씁니다.

```
app/        # React + TDS 화면, 토스 로그인
src/        # 보드 컨트롤러·온라인 클라이언트·기기 로컬 전적 카탈로그
assets/     # 말 이미지
```

```bash
npm install
npm run dev          # http://localhost:5174
npm run build        # dist/
npm run dev:ait      # ait dev
npm run build:ait    # ait build
```

로컬 개발에서는 기본 `ws://localhost:3001`을 사용합니다. 배포 빌드는 저장소 루트의
`.env.production`에 있는 `VITE_WS_URL`을 사용하며, 값이 없더라도 몽진 운영 서버로 연결합니다.
