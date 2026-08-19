export type Locale = 'ko' | 'ja';

const LOCALE_STORAGE_KEY = 'mongjin.locale.v1';

type TranslationValue = string;
type TranslationTable = Record<string, TranslationValue>;

const translations: Record<Locale, TranslationTable> = {
  ko: {
    'language.selector': '언어 선택',
    'language.ko': '한국어',
    'language.ja': '日本語',
    'meta.title': '몽진 — 왕의 피난길',
    'meta.description': '왕을 호위해 상대 진영까지 피난시키는 2인 추상 전략 게임',
    'brand.title': '몽진',
    'brand.subtitle': '왕의 피난길',
    'profile.open': '내 프로필 열기',
    'profile.default': '프로필',
    'profile.loading': '전적 불러오는 중',
    'home.actions': '게임 시작',
    'menu.random.title': '랜덤 대전',
    'menu.random.description': '실시간 플레이어와 자동 매칭',
    'menu.ai.title': '컴퓨터 대전',
    'menu.ai.description': '난이도와 진영 선택',
    'menu.friend.title': '친구 대전',
    'menu.friend.description': '입장코드로 친구와 대국',
    'menu.tutorial.title': '튜토리얼',
    'menu.tutorial.description': '4단계로 규칙 익히기',
    'preview.aria': '몽진 초기 배치 미리보기',
    'preview.caption': '왕을 호위해 상대 진영의 목적지까지 이동시키세요.',
    'piece.king.black': '흑 왕',
    'piece.king.white': '백 왕',
    'piece.guard.black': '흑 호위',
    'piece.guard.white': '백 호위',
    'game.back': '홈으로',
    'mode.ai': '컴퓨터 대전',
    'mode.local': '같이 두기',
    'mode.online': '온라인 대전',
    'mode.random': '랜덤 대전',
    'settings.aiDifficulty': '봇 난이도',
    'settings.humanColor': '내 색',
    'difficulty.easy': '쉬움',
    'difficulty.normal': '보통',
    'difficulty.hard': '어려움',
    'color.black.first': '흑 · 선공',
    'color.white.second': '백 · 후공',
    'color.random': '랜덤',
    'online.create': '입장코드 생성',
    'online.copy': '복사',
    'online.code.placeholder': '6자리 코드',
    'online.code.aria': '입장코드',
    'online.join': '참가',
    'online.opponent': '{name} · 레이팅 {rating}',
    'online.searching': '상대를 찾고 있어요',
    'online.cancel': '매칭 취소',
    'game.undo': '무르기',
    'game.reset': '새 게임',
    'rules.open': '규칙 다시 보기',
    'setup.eyebrow': 'GAME SETUP',
    'setup.title': '컴퓨터 대전',
    'dialog.close': '닫기',
    'setup.difficulty': '난이도',
    'setup.easy.option': '쉬움 · 기본 수와 즉시 전술을 익혀요',
    'setup.normal.option': '보통 · 초보 전술과 기본 수비를 읽어요',
    'setup.hard.option': '어려움 · 최대 4.3초 동안 최선 수를 깊게 읽어요',
    'setup.side': '내 진영',
    'setup.start': '대국 시작',
    'setup.local': '한 기기에서 둘이 두기',
    'profile.eyebrow': 'PLAYER PROFILE',
    'profile.title': '내 프로필',
    'profile.nickname': '닉네임',
    'profile.placeholder': '2~12자',
    'profile.save': '저장',
    'profile.stats': '랜덤 대전 전적',
    'profile.rank': '전체 순위',
    'profile.rankPlaceholder': '-위',
    'profile.ratingPlaceholder': '레이팅 -',
    'profile.rating': '레이팅 {rating} · 전체 {total}명',
    'profile.wins': '승',
    'profile.losses': '패',
    'profile.winRate': '승률',
    'profile.note': '랜덤 대전 결과만 공식 전적에 반영돼요.',
    'profile.loadingRecord': '전적을 불러오고 있어요',
    'tutorial.eyebrow': 'HOW TO PLAY',
    'tutorial.title': '왕을 피난시키세요',
    'tutorial.progress': '튜토리얼 진행 상태',
    'tutorial.previous': '이전',
    'tutorial.next': '다음',
    'tutorial.startPractice': '연습 대국 시작',
    'tutorial.step1.title': '왕을 피난시키세요',
    'tutorial.step1.copy': '내 왕을 상대 진영 끝줄의 가운데 세 칸 중 하나로 먼저 이동시키면 승리합니다.',
    'tutorial.step1.alt': '흑 왕이 상대편 끝줄의 가운데 목적지로 이동하는 경로',
    'tutorial.step2.title': '호위를 배치하세요',
    'tutorial.step2.copy': '매 턴 호위 하나를 내 말과 상하좌우로 맞닿은 빈 칸에 놓을 수 있습니다. 호위는 각 진영에 8개입니다.',
    'tutorial.step2.alt': '왕과 호위에 상하좌우로 맞닿은 칸에 새 호위를 배치하는 모습',
    'tutorial.step3.title': '두거나, 움직이세요',
    'tutorial.step3.copy': '한 턴에는 호위를 새로 두거나 말 하나를 움직입니다. 왕은 8방향, 호위는 상하좌우로 한 칸 이동합니다.',
    'tutorial.step3.alt': '왕은 여덟 방향, 호위는 상하좌우 네 방향으로 움직이는 방법',
    'tutorial.step4.title': '왕을 끝까지 지키세요',
    'tutorial.step4.copy': '호위는 상대 호위와 왕을 잡을 수 있습니다. 왕이 잡히면 즉시 패배하므로 혼자 돌진하지 마세요.',
    'tutorial.step4.alt': '세 호위가 왕을 둘러싸고 상대 호위의 접근을 막는 모습',
    'status.turn': '{player} 차례',
    'status.aiThinking': '컴퓨터({difficulty}) 생각 중…',
    'status.waiting': '상대 대기 중…',
    'status.opponentTurn': '상대 차례',
    'status.hand': '{player} 호위',
    'result.win': '{player} 승리! — {reason}',
    'reason.goal': '왕이 목적지에 도달',
    'reason.capture': '상대 왕을 잡음',
    'reason.surround': '상대 왕을 포위',
    'reason.no-moves': '상대가 둘 수 없음',
    'reason.forfeit': '상대가 대국을 떠남',
    'status.code': '입장코드 {code} — {side}',
    'status.code.waiting': '입장코드 {code} — {side} (상대 대기 중)',
    'status.matched': '{name} 님과 매칭됐어요 — {side}',
    'profile.saved': '저장했어요',
    'profile.saving': '저장 중…',
    'profile.invalid': '닉네임은 2~12자로 입력해 주세요',
    'clipboard.copied': '입장코드 {code} 복사됨 — 친구에게 공유하세요',
    'clipboard.manual': '코드를 직접 선택해 복사해 주세요',
    'online.setupHint': '입장코드를 생성하거나 코드를 입력해 참가하세요',
    'online.noCode': '입장코드를 입력하세요',
    'online.opponentSearching': '상대를 찾고 있어요',
    'online.matchCanceled': '랜덤 매칭을 취소했어요',
    'online.ended': '대전이 종료됐어요',
    'online.opponentLeft': '상대가 나갔습니다',
    'server.connecting': '서버 연결 중…',
    'server.retrying': '서버 연결 재시도 ({attempt}/{total})…',
    'server.connected': '서버에 연결됨',
    'server.disconnected': '연결 끊김',
    'server.badResponse': '서버 응답을 읽을 수 없습니다',
    'server.unavailable': '온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    'server.notConnected': '서버에 연결되어 있지 않습니다',
    'server.profileRequired': '프로필 연결을 먼저 완료해 주세요',
    'server.invalidMessage': '잘못된 메시지 형식입니다',
    'server.duplicateName': '이미 사용 중인 닉네임입니다',
    'server.alreadyPlaying': '이미 대국에 참가 중입니다',
    'server.roomCodeRequired': '방 코드가 필요합니다',
    'server.roomNotFound': '방을 찾을 수 없습니다',
    'server.notFriendRoom': '참가할 수 없는 방입니다',
    'server.alreadyInRoom': '이미 이 방에 참가 중입니다',
    'server.roomFull': '방이 가득 찼습니다',
    'server.joinBeforeMove': '방에 참가한 뒤 수를 둘 수 있습니다',
    'server.roomMissing': '방이 존재하지 않습니다',
    'server.notRoomPlayer': '이 방의 플레이어가 아닙니다',
    'server.notYourTurn': '내 차례가 아닙니다',
    'server.gameOver': '게임이 이미 끝났습니다',
    'server.illegalMove': '불법 수입니다',
    'server.unknownRequest': '알 수 없는 요청입니다',
  },
  ja: {
    'language.selector': '言語を選択',
    'language.ko': '한국어',
    'language.ja': '日本語',
    'meta.title': '蒙塵 — 王の避難路',
    'meta.description': '王を護衛して相手陣地まで避難させる、2人用の抽象戦略ボードゲーム',
    'brand.title': '蒙塵',
    'brand.subtitle': '王の避難路',
    'profile.open': 'プロフィールを開く',
    'profile.default': 'プロフィール',
    'profile.loading': '戦績を読み込み中',
    'home.actions': 'ゲームを始める',
    'menu.random.title': 'ランダム対戦',
    'menu.random.description': 'リアルタイムのプレイヤーと自動マッチング',
    'menu.ai.title': 'コンピューター対戦',
    'menu.ai.description': '難易度と陣営を選択',
    'menu.friend.title': '友だち対戦',
    'menu.friend.description': '入室コードで友だちと対局',
    'menu.tutorial.title': 'チュートリアル',
    'menu.tutorial.description': '4ステップでルールを学ぶ',
    'preview.aria': '蒙塵の初期配置プレビュー',
    'preview.caption': '王を護衛しながら、相手陣地の目的地まで進めましょう。',
    'piece.king.black': '黒の王',
    'piece.king.white': '白の王',
    'piece.guard.black': '黒の護衛',
    'piece.guard.white': '白の護衛',
    'game.back': 'ホームへ',
    'mode.ai': 'コンピューター対戦',
    'mode.local': '2人で対戦',
    'mode.online': 'オンライン対戦',
    'mode.random': 'ランダム対戦',
    'settings.aiDifficulty': 'AIの難易度',
    'settings.humanColor': '自分の陣営',
    'difficulty.easy': 'やさしい',
    'difficulty.normal': 'ふつう',
    'difficulty.hard': 'むずかしい',
    'color.black.first': '黒 · 先手',
    'color.white.second': '白 · 後手',
    'color.random': 'ランダム',
    'online.create': '入室コードを作成',
    'online.copy': 'コピー',
    'online.code.placeholder': '6桁のコード',
    'online.code.aria': '入室コード',
    'online.join': '参加',
    'online.opponent': '{name} · レーティング {rating}',
    'online.searching': '対戦相手を探しています',
    'online.cancel': 'マッチングをキャンセル',
    'game.undo': '待った',
    'game.reset': '新しいゲーム',
    'rules.open': 'ルールを見る',
    'setup.eyebrow': 'GAME SETUP',
    'setup.title': 'コンピューター対戦',
    'dialog.close': '閉じる',
    'setup.difficulty': '難易度',
    'setup.easy.option': 'やさしい · 基本の手と簡単な戦術を学びます',
    'setup.normal.option': 'ふつう · 初歩的な戦術と基本の守りを読みます',
    'setup.hard.option': 'むずかしい · 最大4.3秒かけて最善手を深く読みます',
    'setup.side': '自分の陣営',
    'setup.start': '対局を始める',
    'setup.local': '1台で2人対戦',
    'profile.eyebrow': 'PLAYER PROFILE',
    'profile.title': 'プロフィール',
    'profile.nickname': 'ニックネーム',
    'profile.placeholder': '2〜12文字',
    'profile.save': '保存',
    'profile.stats': 'ランダム対戦の戦績',
    'profile.rank': '全体順位',
    'profile.rankPlaceholder': '-位',
    'profile.ratingPlaceholder': 'レーティング -',
    'profile.rating': 'レーティング {rating} · 全 {total}人',
    'profile.wins': '勝',
    'profile.losses': '敗',
    'profile.winRate': '勝率',
    'profile.note': 'ランダム対戦の結果だけが公式戦績に反映されます。',
    'profile.loadingRecord': '戦績を読み込んでいます',
    'tutorial.eyebrow': 'HOW TO PLAY',
    'tutorial.title': '王を避難させよう',
    'tutorial.progress': 'チュートリアルの進行状況',
    'tutorial.previous': '前へ',
    'tutorial.next': '次へ',
    'tutorial.startPractice': '練習対局を始める',
    'tutorial.step1.title': '王を避難させよう',
    'tutorial.step1.copy': '自分の王を相手陣地の最終列、その中央3マスのいずれかへ先に移動させると勝利です。',
    'tutorial.step1.alt': '黒の王が相手側の最終列にある中央の目的地へ進む道',
    'tutorial.step2.title': '護衛を配置しよう',
    'tutorial.step2.copy': '各ターンに1つ、味方の駒と上下左右で隣り合う空きマスへ護衛を置けます。護衛は各陣営8個です。',
    'tutorial.step2.alt': '王と護衛に上下左右で隣り合うマスへ新しい護衛を置く様子',
    'tutorial.step3.title': '置くか、動かそう',
    'tutorial.step3.copy': '1ターンにできるのは、護衛を置くか駒を1つ動かすかのどちらかです。王は8方向、護衛は上下左右に1マス動きます。',
    'tutorial.step3.alt': '王は8方向、護衛は上下左右の4方向へ動かせることを示す図',
    'tutorial.step4.title': '最後まで王を守ろう',
    'tutorial.step4.copy': '護衛は相手の護衛と王を取れます。王を取られると即座に敗北するので、1人で突っ込まないようにしましょう。',
    'tutorial.step4.alt': '3つの護衛が王を囲み、相手の護衛の接近を防ぐ様子',
    'status.turn': '{player}の番',
    'status.aiThinking': 'コンピューター（{difficulty}）が考えています…',
    'status.waiting': '対戦相手を待っています…',
    'status.opponentTurn': '相手の番',
    'status.hand': '{player}の護衛',
    'result.win': '{player}の勝利！ — {reason}',
    'reason.goal': '王が目的地に到達',
    'reason.capture': '相手の王を取った',
    'reason.surround': '相手の王を包囲した',
    'reason.no-moves': '相手が動けない',
    'reason.forfeit': '相手が対局を退出した',
    'status.code': '入室コード {code} — {side}',
    'status.code.waiting': '入室コード {code} — {side}（対戦相手を待っています）',
    'status.matched': '{name}さんとマッチしました — {side}',
    'profile.saved': '保存しました',
    'profile.saving': '保存中…',
    'profile.invalid': 'ニックネームは2〜12文字で入力してください',
    'clipboard.copied': '入室コード {code}をコピーしました — 友だちに共有しましょう',
    'clipboard.manual': 'コードを選択してコピーしてください',
    'online.setupHint': '入室コードを作成するか、コードを入力して参加してください',
    'online.noCode': '入室コードを入力してください',
    'online.opponentSearching': '対戦相手を探しています',
    'online.matchCanceled': 'ランダムマッチングをキャンセルしました',
    'online.ended': '対戦を終了しました',
    'online.opponentLeft': '相手が退出しました',
    'server.connecting': 'サーバーに接続中…',
    'server.retrying': 'サーバーへの接続を再試行中（{attempt}/{total}）…',
    'server.connected': 'サーバーに接続しました',
    'server.disconnected': '接続が切れました',
    'server.badResponse': 'サーバーの応答を読み取れません',
    'server.unavailable': 'オンラインサーバーに接続できません。しばらくしてからお試しください。',
    'server.notConnected': 'サーバーに接続されていません',
    'server.profileRequired': '先にプロフィールの接続を完了してください',
    'server.invalidMessage': 'メッセージの形式が正しくありません',
    'server.duplicateName': 'そのニックネームはすでに使われています',
    'server.alreadyPlaying': 'すでに対局に参加しています',
    'server.roomCodeRequired': '部屋のコードが必要です',
    'server.roomNotFound': '部屋が見つかりません',
    'server.notFriendRoom': 'この部屋には参加できません',
    'server.alreadyInRoom': 'すでにこの部屋に参加しています',
    'server.roomFull': '部屋が満員です',
    'server.joinBeforeMove': '部屋に参加してから手を打ってください',
    'server.roomMissing': '部屋が存在しません',
    'server.notRoomPlayer': 'この部屋のプレイヤーではありません',
    'server.notYourTurn': 'あなたの番ではありません',
    'server.gameOver': 'ゲームはすでに終了しています',
    'server.illegalMove': '不正な手です',
    'server.unknownRequest': '不明なリクエストです',
  },
};

let currentLocale: Locale = loadLocale();

function loadLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === 'ja' ? 'ja' : 'ko';
  } catch {
    return 'ko';
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 언어 선택을 저장할 수 없는 환경에서도 현재 세션은 계속 동작한다.
  }
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = translations[currentLocale][key] ?? translations.ko[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export function playerLabel(player: 'BLACK' | 'WHITE'): string {
  return currentLocale === 'ja' ? (player === 'BLACK' ? '黒' : '白') : player === 'BLACK' ? '흑' : '백';
}

export function reasonLabel(reason: 'goal' | 'capture' | 'surround' | 'no-moves' | 'forfeit'): string {
  return t(`reason.${reason}`);
}

/** 서버와 온라인 클라이언트가 보관한 한국어 상태 메시지를 현재 언어로 표시한다. */
export function localizeMessage(message: string): string {
  if (currentLocale === 'ko') return message;

  const retry = message.match(/^서버 연결 재시도 \((\d+)\/(\d+)\)…$/);
  if (retry) return t('server.retrying', { attempt: retry[1], total: retry[2] });

  const codeWaiting = message.match(/^입장코드 ([A-Z0-9]+) — (흑|백) \(상대 대기 중\)$/);
  if (codeWaiting) return t('status.code.waiting', { code: codeWaiting[1], side: codeWaiting[2] === '흑' ? '黒' : '白' });

  const code = message.match(/^입장코드 ([A-Z0-9]+) — (흑|백)$/);
  if (code) return t('status.code', { code: code[1], side: code[2] === '흑' ? '黒' : '白' });

  const matched = message.match(/^(.+?) 님과 매칭됐어요 — (흑|백)$/);
  if (matched) return t('status.matched', { name: matched[1], side: matched[2] === '흑' ? '黒' : '白' });

  const result = message.match(/^(흑|백) 승리 · (왕이 목적지에 도달|상대 왕을 잡음|상대 왕을 포위|상대가 둘 수 없음|상대가 대국을 떠남)$/);
  if (result) {
    const reasonKeys: Record<string, 'goal' | 'capture' | 'surround' | 'no-moves' | 'forfeit'> = {
      '왕이 목적지에 도달': 'goal',
      '상대 왕을 잡음': 'capture',
      '상대 왕을 포위': 'surround',
      '상대가 둘 수 없음': 'no-moves',
      '상대가 대국을 떠남': 'forfeit',
    };
    return `${result[1] === '흑' ? '黒' : '白'}の勝利 · ${t(`reason.${reasonKeys[result[2]]}`)}`;
  }

  const copied = message.match(/^입장코드 ([A-Z0-9]+) 복사됨 — 친구에게 공유하세요$/);
  if (copied) return t('clipboard.copied', { code: copied[1] });

  const direct: Record<string, string> = {
    '상대를 찾고 있어요': 'online.opponentSearching',
    '랜덤 상대를 찾는 중…': 'online.opponentSearching',
    '랜덤 매칭을 취소했어요': 'online.matchCanceled',
    '대전이 종료됐어요': 'online.ended',
    '상대가 나갔습니다': 'online.opponentLeft',
    '입장코드를 생성하거나 코드를 입력해 참가하세요': 'online.setupHint',
    '입장코드를 입력하세요': 'online.noCode',
    '서버 연결 중…': 'server.connecting',
    '서버에 연결됨': 'server.connected',
    '연결 끊김': 'server.disconnected',
    '서버 응답을 읽을 수 없습니다': 'server.badResponse',
    '온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.': 'server.unavailable',
    '서버에 연결되어 있지 않습니다': 'server.notConnected',
    '프로필 연결을 먼저 완료해 주세요': 'server.profileRequired',
    '잘못된 메시지 형식입니다': 'server.invalidMessage',
    '닉네임은 2~12자로 입력해 주세요': 'profile.invalid',
    '이미 사용 중인 닉네임입니다': 'server.duplicateName',
    '이미 대국에 참가 중입니다': 'server.alreadyPlaying',
    '방 코드가 필요합니다': 'server.roomCodeRequired',
    '방을 찾을 수 없습니다': 'server.roomNotFound',
    '참가할 수 없는 방입니다': 'server.notFriendRoom',
    '이미 이 방에 참가 중입니다': 'server.alreadyInRoom',
    '방이 가득 찼습니다': 'server.roomFull',
    '방에 참가한 뒤 수를 둘 수 있습니다': 'server.joinBeforeMove',
    '방이 존재하지 않습니다': 'server.roomMissing',
    '이 방의 플레이어가 아닙니다': 'server.notRoomPlayer',
    '내 차례가 아닙니다': 'server.notYourTurn',
    '게임이 이미 끝났습니다': 'server.gameOver',
    '불법 수입니다': 'server.illegalMove',
    '알 수 없는 요청입니다': 'server.unknownRequest',
  };
  const key = direct[message];
  return key ? t(key) : message;
}
