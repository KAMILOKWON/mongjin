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
