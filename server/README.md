# Mongjin online server

운영 환경에서는 `DATABASE_URL`을 설정해 Postgres를 프로필·Elo·경기 기록의 원본으로 사용한다.
`DATABASE_URL`이 없을 때만 기존 `data/profiles.json` 저장 방식으로 동작한다.

## Local checks

```sh
npm install
npm test
npm run typecheck
```

## Existing profile migration

로컬에 남아 있는 `data/profiles.json`의 프로필 ID와 인증 토큰을 그대로 Postgres로 가져온다.
같은 `player_id`는 덮어쓰지 않으므로 명령을 여러 번 실행해도 안전하다.

```sh
DATABASE_URL='postgresql://...' npm run migrate:profiles
```

마이그레이션 후 Render의 `DATABASE_URL`에 같은 연결 문자열을 설정하고 배포한다.
프로필 JSON과 DB 연결 문자열은 저장소에 커밋하지 않는다.

## Public operations endpoints

- `GET /health`: 방·대기열·등록 프로필·현재 WebSocket 세션 수와 저장소 종류
- `GET /leaderboard?limit=100&offset=0`: Elo 경쟁 순위. 동점자는 공동 순위이며 다음 순위는 건너뛴다.

경기 결과는 `match_id`를 고유 키로 저장한다. 같은 결과 요청이 다시 처리돼도 승패와 Elo는 한 번만 갱신된다.

## Device Elo handoff

기존 iOS·Android·앱인토스 설치본의 기기 누적 Elo는 업데이트된 클라이언트가 첫 연결 때
`MIGRATE_LEGACY_PROFILE`로 한 번만 공식 프로필에 승계한다. 서버는 프로필별 최초 요청만
트랜잭션으로 반영하고, 승계 전후 값은 `mongjin_legacy_profile_migrations`에 보관한다.

기본 승계 마감은 2026-12-01이며 `LEGACY_PROFILE_MIGRATION_DEADLINE`로 조정할 수 있다.
승계 후에는 서버 Elo가 유일한 공식 랭킹 원본이다.

## Online game records and learning export

서버가 빠른 대전(`random`), 두 사람이 입장한 친구 대전(`friend`), 공식 봇 대전(`bot`)의
기보를 자동 저장한다. 앱 업데이트나 외부 AI API 호출은 필요하지 않다.
운영에 적용하려면 이 서버 변경을 배포해야 한다. 기존 대국의 승패 기록만으로 과거 수순을 복구할 수는 없다.

- 대국 시작 시 양쪽 진영의 Elo와 사람/봇 구분을 고정한다. 경기 후 갱신된 Elo를 사용하지 않는다.
- 규칙 설정 전체와 `rulesVersion`, 착수 순서, 시작/종료 시각, 승자와 종료 사유를 저장한다.
- 매 합법 수 이후 전체 수순을 순서대로 저장한다. 정상 종료, 항복(`resign`), 연결 종료(`disconnect`)를 구분한다.
- 저장 데이터에 닉네임, 계정 ID, 인증 토큰, 토스 로그인 정보를 포함하지 않는다. `matchId`는 중복 식별용이다.
- `DATABASE_URL` 설정 시 `mongjin_game_records` 테이블을 시작 시 생성한다. 별도의 DB 연결 풀은 최대 2개다.
- 파일 모드는 `MONGJIN_PROFILE_DATA_FILE`과 같은 디렉터리의 `game-records/<matchId>.json`을 사용한다.
  기본 실행 명령(`npm start --prefix server`)에서는 `server/data/game-records`다.
- 서버 재시작 시 이미 저장된 기보는 남는다. 진행 중 방의 복구는 지원하지 않으며, 비정상 종료 당시 기록은
  `playing`으로 남아 학습 내보내기에서 제외된다. 쓰기 실패는 최대 3회 시도 후 `[records]` 오류를 기록한다.
  다음 스냅샷은 앞선 수순도 포함하지만, 장기 DB 장애나 강제 종료 시 저장되지 않은 마지막 수가 유실될 수 있다.
  이는 영속 재시도 큐나 대국 복구 기능을 구현한 것은 아니다.

운영자 CLI로 JSONL을 내보낸다. 공개 HTTP 다운로드 엔드포인트는 제공하지 않는다.
실행 환경의 `DATABASE_URL` 또는 `MONGJIN_PROFILE_DATA_FILE`로 저장소를 선택한다.
기존 출력 파일을 덮어쓰지 않으며, 출력 디렉터리는 미리 준비해야 한다.

```sh
# 한 명 이상이 시작 Elo 1500 이상인 정상 종료 사람 간 대국
npm run export:games --prefix server -- --min-elo 1500 --out /tmp/mongjin-human-1500.jsonl

# 두 명 모두 기준 이상인 대국; 정상 항복도 포함
npm run export:games --prefix server -- --min-elo 1500 --both --include-forfeits --out /tmp/mongjin-human-both.jsonl

# 봇 상대 대국도 포함하되, Elo 자격은 사람에게만 적용
npm run export:games --prefix server -- --min-elo 1500 --include-bots --out /tmp/mongjin-with-bots.jsonl
```

기본값은 사람 간 정상 종료 대국만 포함한다. 연결 종료·미완료·빈 기보는 항상 제외한다.
`eligibleSides`는 기준을 충족한 사람의 진영이며, 상대방의 수까지 정답으로 학습해서는 안 된다.
내보낼 수순은 공용 규칙으로 재생해 합법성과 정상 종료 결과를 검사한다.
불법 기보/지원하지 않는 규칙 버전은 건너뛰고 종료 코드 2를 반환한다. 이때 유효한 나머지 출력은 남는다.
규칙 동작을 바꿀 때 `server/gameRecords.ts`의 `RECORD_RULES_VERSION`을 갱신해야 한다.

구독 모델 분석 지침과 결과 형식: [HUMAN-GAMES.md](../bot/learning/HUMAN-GAMES.md).
이 변경은 수집·선별·내보내기까지이며, 모델 자동 호출·봇 전략 자동 반영은 수행하지 않는다.

검증 명령:

```sh
npm run typecheck --prefix server
npm run test --prefix server
npm test
# 로컬 임시 DB만 사용. DATABASE_URL은 테스트에서 자동 사용하지 않는다.
MONGJIN_TEST_DATABASE_URL='postgresql://localhost/mongjin_test' npm run test --prefix server -- gameRecords.postgres.test.ts
```

통합 테스트는 임시 파일 저장소와 실제 로컬 WebSocket 서버를 사용하며 운영 데이터에 접근하지 않는다.
로컬 포트 열기 권한이 필요하다. Postgres 테스트는 전용 환경 변수가 없으면 생략한다.
