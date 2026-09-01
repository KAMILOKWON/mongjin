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
npm run build        # Sites 산출물 + SDK 3.x .ait 번들
npm run dev:ait      # SDK 3.x Devtools가 포함된 Vite 개발 서버
npm run build:ait    # SDK 3.x .ait 번들
```

로컬 개발에서는 기본 `ws://localhost:3001`을 사용합니다. 배포 빌드는 저장소 루트의
`.env.production`에 있는 `VITE_WS_URL`을 사용하며, 값이 없더라도 몽진 운영 서버로 연결합니다.

## 광고 설정

로컬 개발에서는 앱인토스 공식 테스트 광고 ID를 자동으로 사용합니다. 운영 빌드에서는
앱인토스 콘솔에서 만든 광고 그룹 ID를 저장소 루트의 `.env.production`에 설정해야 합니다.

```dotenv
VITE_TOSS_INTERSTITIAL_AD_GROUP_ID=전면형_광고_그룹_ID
VITE_TOSS_BANNER_AD_GROUP_ID=배너_리스트형_광고_그룹_ID
```

- 전면형 광고는 대국 결과가 확정될 때 한 번 노출됩니다.
- 리스트형 배너는 메인 화면 하단에만 부착되고, 다른 화면으로 이동하면 제거됩니다.
- 운영 광고 ID를 로컬 테스트에 사용하지 마세요. 개발 빌드는 공식 테스트 ID만 사용합니다.

## 프로모션 설정

대국이 정상 종료되면 하루 한 번 토스 포인트 지급을 요청합니다. 운영 코드는 기본값을
사용하며, 콘솔 테스트 빌드는 `VITE_TOSS_PROMOTION_CODE`로 `TEST_` 코드를 주입합니다.

```bash
VITE_TOSS_PROMOTION_CODE=TEST_... npm run build:ait
```

하루 5판 프로모션을 테스트할 때는 별도 환경 변수를 사용합니다.

```bash
VITE_TOSS_FIVE_GAME_PROMOTION_CODE=TEST_... npm run build:ait
```

테스트 코드가 주입된 빌드에서만 홈 화면에 해당 프로모션 API 테스트 버튼이 표시됩니다.

SDK 3.x부터 운영 및 QR 테스트 Origin이 바뀌므로 서버 CORS 허용 목록에 아래 주소를
등록해야 합니다.

- `https://mongjin.web.tossmini.com`
- `https://mongjin.private-web.tossmini.com`
