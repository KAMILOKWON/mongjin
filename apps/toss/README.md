# 몽진 — 앱인토스 미니앱

이 폴더만으로 앱인토스 프론트를 실행·빌드할 수 있습니다. 상위 웹 프로젝트(`../src`)에 의존하지 않습니다.

```
app/        # React + TDS 화면, 토스 로그인
src/        # 게임 규칙·AI·보드 컨트롤러
bot/        # 전략서·기보 (오프라인 봇)
assets/     # 튜토리얼·말 이미지
```

```bash
npm install
npm run dev          # http://localhost:5174
npm run build        # dist/
npm run dev:ait      # ait dev
npm run build:ait    # ait build
```

온라인 서버는 기본 `ws://localhost:3001`입니다. 배포 시 `VITE_WS_URL`로 바꿉니다.
