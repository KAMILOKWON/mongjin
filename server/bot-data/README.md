# 1등찍고접기 학습 자료

`first-place.json`은 한 이용자의 완료 기보에서 **그 이용자가 둔 수만** 집계한 고정 자료다.
전체 150판을 시간순으로 나누어 최초 120판(흑 60, 백 60)을 학습에 사용하고 마지막 30판은
평가용으로 남겼다. 배포 데이터는 1,533수, 1,032개 국면이다. 원본 닉네임·계정 ID·토큰·경기 ID는
자료에 들어가지 않으며, 원본 JSONL은 저장소에 커밋하지 않는다.

각 키는 정렬한 전체 규칙 설정과 `positionKey`(보드·차례·남은 호위)를 포함한다. 값은 해당
국면에서 관측한 `moveKey`별 횟수다. 승리한 대국의 모든 수를 정답으로 가정하지 않으며,
승패와 무관하게 본인의 선택을 관측한다. 전술적 판단은 공용 AI가 담당한다.

서버는 시작할 때 자료를 한 번 읽는다. 신규 기보를 실시간으로 수집·추가하거나 외부 모델 API를
호출하지 않는다. 원본 이용자의 이후 활동이 이 파일을 자동 변경하지 않는다.

재생성 입력은 `HumanStyleSample` JSONL이다. 한 줄의 `record`는 `GameRecord`, `eligibleSide`는
해당 이용자의 진영이다. 운영 기록의 본인 완료 이벤트와 기보의 승자·결과를 대조해 진영을 지정한다.
일반 `export:games`의 양쪽 `eligibleSides`를 그대로 사용하면 다른 사람의 수가 섞일 수 있다.

```sh
npm run build:human-style --prefix server -- \
  --input /absolute/private/records.jsonl --out /tmp/first-place.json --train-games 120
```

빌더는 모든 기보의 자연 종료·진영·규칙 버전·엄격한 착수 스키마·합법 재생·결과·중복을
검사한다. JSONB 키 순서는 정상화하지만 숫자 문자열·추가 필드는 거부한다. 끝난 시각 순으로
나누며 평가용 대국이 최소 한 판 남아야 한다. 출력 파일을 덮어쓰지 않는다.
인접한 `.manifest.json`에는 입력·학습 파일 SHA-256과 분할/국면 수를 기록한다.

검증 명령(서버 디렉터리에서 실행):

```sh
node --import tsx evaluateHumanStyle.ts /absolute/private/records.jsonl /tmp/heldout-report.json
node --import tsx benchmarkHumanStyle.ts /tmp/tournament-report.json
```

평가기는 입력 해시가 고정 자료와 일치하는지 확인한다. 최대 24개 기지 국면과 24개 미지 국면을
평가용 대국에서 고르고 두 시드로 비교한다. 대전 비교는 동일한 축소 탐색 예산에서만 수행한다.
두 명령의 수치는 운영 지연이나 Elo 추정치가 아니다. 원본 기록을 재분할해 반복 조정한다면
기존 평가 표본은 더 이상 독립된 검증 자료로 사용할 수 없다.
