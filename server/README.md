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

## 고정 빠른대전 선수와 사람 기보 학습

서버 시작 시 `rankedBots.ts`의 15명을 영구 프로필로 한 번만 생성한다.
연세대MAY(1000), 씹다버린계피(1100), 용광로불주먹(1200), 동년배들몽진한다(1300),
うずまき(1400), faker(1500), Astra(1600)는 기존 7명의 초기 이름과 Elo다.
나그네2847(1050), 나그네5931(1150), 나그네7068(1250), 나그네9325(1350), 히어로메이커(1450),
영일만사나이(1550), 이겜뭐임(1600)를 추가한다. 신규 7명은 숫자를 고정한 기본 닉네임 4명과
고유 닉네임 3명으로 구성한다. 기존 7명의 ID·Elo·전적·학습을 유지한다. 초기 점수는 배치값이며
실측 실력을 의미하지 않는다. 기존 계정과 이름이 겹치면 시작을 중단하며 기존 계정을 덮어쓰지 않는다.
재시작 시 점수·전적·학습을 초기화하지 않는다. 봇 ID는 클라이언트 로그인에 사용할 수 없다.

2026-09-20 추가한 `1등찍고접기`(초기 1600)는 한 이용자의 120판에서 본인 착수 1,533수를
집계한 기보 기반 선수다. 30판은 평가용으로 제외했다. 탐색이 검증한 근접 후보 사이에서만
기보의 선택을 선호하며, 기록에 없는 국면은 기존 진출형 탐색을 사용한다. 사람의 Elo나 전적을
복제하지 않는다. 자료 생성 방법은 `bot-data/README.md`, 검증 결과는
`../bot/learning/FIRST-PLACE-BOT.md`를 참고한다.

기존 `MATCHMAKE` / `MATCHMAKE_BOT` 프로토콜을 유지한다. 클라이언트의 사람 매칭 대기 후
봇 요청에만 응답하며, 봇끼리 대국하거나 임의로 승패·순위를 만드는 작업은 없다.
가장 가까운 Elo 차이에 250을 더한 범위 안의 모든 봇을 후보로 쓰고, 부족하면 가까운 5명까지
확보한다. Elo가 가까울수록 가중치를 높이고 최근 5판에 만난 상대는 가중치를 낮춘다.
다른 봇이 있으면 직전 상대는 제외한다. 후보가 모두 최근 상대여도 매칭은 가능하다.
한 선수는 복수 사람과 동시에 대국할 수 있다.
각 선수의 기본 탐색 강도·성향은 고정하며, 표시 Elo를 상대에 맞춰 생성하지 않는다.
대국 중 전략은 시작 시점의 사본으로 고정한다.

프로세스에서 이용자의 첫 봇 대전 요청을 받을 때 저장된 최근 완료 상대 5명을 조회한다.
이후 시작한 상대는 중도 이탈도 포함해 메모리의 최근 5명에 반영한다. 재시작하면 완료 기록으로
복구한다. 최초 조회가 500ms 안에 끝나지 않거나 실패하면 빈 기록 또는 메모리로 진행한다.
조회 중 매칭 취소·친구 대전 전환·사람 매칭·연결 종료가 일어나면 늦은 응답으로 봇 방을 만들지 않는다.

초반 12수에는 진출형·호위형·측면형·전술형의 선택 선호도를 적용한다. 즉시 승리·필수 방어와
근접 최선수 후보 검증이 먼저이며, 성향 때문에 후보의 탐색 점수 허용폭을 넓히지 않는다.
측면형의 좌우 방향은 대국 시작 시 정한다. 첫 수에 호위 배치를 강제하지 않고 이후 검증된
호위 전개 기회에서 성향을 드러낸다. 공용 AI의 기본 동작과 클라이언트 매칭 흐름은 유지한다.
기보 활용 기준: [OPENING-STYLES.md](../bot/learning/OPENING-STYLES.md).

완료 시 사람과 봇의 전적을 함께 갱신한다. 사람 Elo는 기존 K=24와 대국 시작 시 봇 Elo로
계산하고, 봇은 그 증감의 반대를 반영한다(100 하한 적용). 봇도 기존 `/leaderboard`에 포함되며
클라이언트 화면 수정은 없다. 내부 봇 구분과 기존 `isBot` 응답은 유지한다.
`totalPlayers`에는 봇도 포함되므로 실제 사람 수를 구할 때 고정 봇 ID를 제외해야 한다.

학습은 외부 API 없이 각 봇이 사람과 둔 정상 종료 기보를 공용 규칙으로 재생·검증해 처리한다.
처음 12수 중 해당 봇 착수 후 국면별 승패를 최대 512개 저장하며, 3회 이상 관측한 패턴만
평가·수 정렬에 절댓값 16 미만의 보너스로 반영한다. 흑백과 규칙 설정·보드·보유 호위 수를 구분하고
항복·연결 종료·미완료 기보는 학습에서 제외한다. 이 통계적 적응은 실력 향상을 보장하거나
자동 검증된 새 모델을 배포하는 시스템은 아니다. 봇끼리 평가 대국도 실행하지 않는다.

Postgres는 시작 시 `bot_learning` JSONB 및 봇 경기의 `bot_player_id` 컬럼을 추가한다.
양쪽 프로필을 ID 순서로 잠그고 경기 ID 중복 검사·양쪽 전적·학습을 한 트랜잭션에 저장한다.
파일 모드는 `<프로필 경로>.snapshot.json`을 원본으로 사용해 프로필·경기 ID·봇 경기·이벤트를
하나의 atomic rename으로 저장한다. 기존 JSON 파일에서 자동 시작하며, `profiles.json` 배열은
호환용 사본이다. 백업·복구할 때 snapshot도 함께 보관하고, 파일 모드는 단일 프로세스로 운영한다. 구버전으로 롤백해 레거시 파일이 더 새롭게 바뀐 경우
재업그레이드와 DB 가져오기를 중단하므로, 백업을 보존하고 명시적으로 병합해야 한다.
이 변경은 서버 배포 후 적용되며 앱 버전 변경·스토어 재배포는 필요하지 않다.

검증: `npm run typecheck --prefix server`, `npm run test --prefix server`.
Postgres 통합 검증은 운영 DB가 아닌 `MONGJIN_TEST_DATABASE_URL`을 지정해 실행한다.

2026-09-07 로컬 검증: 서버 타입 검사, 임시 Postgres(127.0.0.1:55439)와 실제 WebSocket을
포함한 서버 테스트 45개 통과. 별도 작업 폴더·archive를 제외한 현재 프로젝트 테스트 138개 통과.
최초 무제한 `npm test`는 별도 작업 폴더까지 수집해 시간 초과가 발생했으며, 현재 프로젝트는
`--maxWorkers=2`로 다시 검증했다. 앱 실기기 화면·장기 운영 성능·실력 향상은 이번 검증에 포함하지 않았다.
