import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export type Lang = 'ko' | 'ja' | 'en' | 'zh';

const ko = {
  appTitle: '몽진',
  cancel: '취소',
  confirm: '확인',
  black: '흑',
  white: '백',
  me: '나',
  opponentGeneric: '상대',

  homeTabQuick: '빠른 대전',
  homeQuickBlurb: '접속 중인 상대와 자동 매칭',
  homeQuickCta: '대국 시작',
  homeTabFriend: '친구',
  homeFriendBlurb: '입장코드로 친구와 대국합니다',
  homeFriendCta: '코드 만들기',
  homeTabAI: '컴퓨터',
  homeAIBlurb: '난이도와 진영을 골라 연습합니다',
  homeAICta: '대국 준비',
  homeTabLocal: '같이 두기',
  homeLocalBlurb: '한 기기에서 흑·백을 번갈아 둡니다',
  homeLocalCta: '대국 시작',
  tutorial: '튜토리얼',
  eloWinsShort: 'Elo {rating} · {wins}승',

  quickMatch: '빠른 대전',
  matched: '매칭됐어요',
  searchingShort: '상대를 찾는 중',
  searching: '상대를 찾는 중…',

  friendMatch: '친구 대전',
  entryCode: '입장코드',
  friendIntro: '친구에게 입장코드를 보내거나, 받은 코드로 입장하세요.',
  createCode: '입장코드 생성',
  or: '또는',
  codePlaceholder: '6자리 코드',
  joinWithCode: '코드로 참가',
  codeShareBtn: '코드 공유',
  friendWaitingStart: '상대가 입장하면 대국이 시작됩니다',
  friendWaiting: '상대를 기다리는 중',
  joining: '입장하는 중…',
  codeLengthError: '6자리 입장코드를 입력해 주세요',
  inviteShareMessage: '몽진 친구 대전 초대!\n입장코드: {code}\n참가 링크: {link}',

  aiMatch: '컴퓨터 대전',
  setupHeading: '대국을 준비하세요',
  botDifficulty: '봇 난이도',
  diffEasy: '쉬움',
  diffNormal: '보통',
  diffHard: '어려움',
  diffEasyDesc: '규칙에 맞는 기본 수를 차분히 둔다',
  diffNormalDesc: '초보 전술과 기본 수비를 읽는다',
  diffHardDesc: '최선 수를 깊게 읽어 빈틈을 놓치지 않는다',
  myColor: '내 색',
  colorBlackFirst: '흑 · 선공',
  colorWhiteSecond: '백 · 후공',
  colorRandom: '랜덤',
  startGame: '대국 시작',

  localMode: '같이 두기',
  computerMode: '컴퓨터',
  tutorialMode: '튜토리얼',
  aiModeDiff: '컴퓨터 · {difficulty}',
  blackWins: '흑 승리',
  whiteWins: '백 승리',
  victory: '승리',
  defeat: '패배',
  resignConfirmTitle: '항복할까요?',
  resignConfirmBody: '이 대국은 패배로 기록됩니다. 상대 입장에서는 당신이 항복한 것으로 남습니다.',
  resign: '항복',
  exitConfirmTitle: '대국을 종료할까요?',
  exitConfirmBody: '진행 중인 대국은 저장되지 않습니다.',
  endGameAction: '종료',
  exit: '나가기',
  endGameBtn: '대국 종료',
  opponentThinking: '상대가 두는 중',
  aiThinking: '컴퓨터가 생각하는 중',
  turnOf: '{side} 차례',
  undo: '무르기',
  remainingTime: '남은 시간',
  clockOpponentTurn: '상대 차례',
  blackGuards: '흑 호위',
  whiteGuards: '백 호위',
  sideWithElo: '{side} · Elo {rating}',

  rForfeitWon: '상대가 항복했습니다',
  rForfeitLost: '항복했습니다',
  rTimeoutWon: '상대가 시간 안에 두지 못했습니다',
  rTimeoutLost: '1분 안에 두지 못했습니다',
  rGoalWon: '왕이 목적지에 도착했습니다',
  rGoalLost: '상대 왕이 목적지에 도착했습니다',
  rGoalLocal: '왕이 목적지에 도착했습니다',
  rCaptureWon: '상대 왕을 잡았습니다',
  rCaptureLost: '왕이 잡혔습니다',
  rCaptureLocal: '왕을 잡아 이겼습니다',
  rSurroundWon: '상대 왕을 포위했습니다',
  rSurroundLost: '왕이 포위되었습니다',
  rSurroundLocal: '왕을 포위해 이겼습니다',
  rNoMovesWon: '상대가 둘 수 없었습니다',
  rNoMovesLost: '둘 수 있는 수가 없었습니다',

  myProfile: '내 프로필',
  myRecord: '내 전적',
  recordLine: '{wins}승 {losses}패 · 승률 {rate}%',
  onlineRankLine: '온라인 순위 {rank}위',
  nickname: '닉네임',
  nicknamePlaceholder: '2~12자',
  saveNickname: '닉네임 저장',
  nameLengthError: '닉네임은 2~12자로 적어 주세요',
  saveNameFailed: '닉네임을 기기에 저장하지 못했습니다',
  savedName: '닉네임을 저장했어요',
  saveRecordFailed: '전적을 기기에 저장하지 못했습니다',
  language: '언어',
  discordCommunity: '디스코드 커뮤니티',

  connecting: '서버 연결 중…',
  connectedStatus: '서버에 연결됨',
  disconnected: '연결 끊김',
  connectFailed: '서버에 연결하지 못했어요',
  notConnected: '서버에 연결되어 있지 않습니다',
  parseFailed: '서버 응답을 읽을 수 없습니다',
  idSaveFailed: '프로필 식별자를 기기에 저장하지 못했습니다',
  queueCancelled: '랜덤 매칭을 취소했어요',
  noMatchFound: '대국할 상대를 찾지 못했어요',
  opponentLeft: '상대가 연결을 끊었습니다',
  matchFoundLine: '{name} 님과 매칭됐어요 · {side}',
  waitingSideLine: '{side} · 상대를 기다리는 중',
  ghostMatchLine: '{name} 님과 대국해요 · {side}',
  ghostMatchShort: '{name} 님과 대국해요',

  tutorialDoneTitle: '이제 기본 규칙을 모두 익혔어요',
  tutorialDoneCoach: '컴퓨터와 한 판 두면서 연습해 보세요.',
  practiceWithAI: '컴퓨터로 연습하기',
  goHome: '홈으로',
  todoNow: '지금 할 일',

  tutorialLessons: [
    {
      title: '호위를 놓아 볼까요?',
      coach: '흑부터 시작해요. 검은 왕 바로 위에 파랗게 빛나는 칸을 눌러 호위를 놓아 보세요.',
      hintIdle: '파란 칸을 눌러 호위를 놓아 보세요',
      hintArmed: '파란 칸을 눌러 호위를 놓아 보세요',
    },
    {
      title: '왕을 움직여 볼까요?',
      coach: '한 번에 한 가지 행동만 할 수 있어요. 왕을 누른 다음 파란 칸으로 옮겨 보세요.',
      hintIdle: '파란 왕을 먼저 눌러 보세요',
      hintArmed: '파란 칸으로 왕을 옮겨 보세요',
    },
    {
      title: '호위로 잡아 볼까요?',
      coach: '호위는 상하좌우로 움직여요. 상대 호위가 있는 칸으로 이동하면 잡을 수 있어요.',
      hintIdle: '파란 호위를 먼저 눌러 보세요',
      hintArmed: '흰 호위를 눌러 잡아 보세요',
    },
    {
      title: '왕을 잡으면 끝나요',
      coach: '호위는 목적지에는 들어갈 수 없지만 그 칸에 왕이 있으면 잡을 수 있어요. 왕을 잡으면 대국이 끝나요.',
      hintIdle: '파란 호위를 먼저 눌러 보세요',
      hintArmed: '흰 왕을 눌러 잡아 보세요',
    },
    {
      title: '목적지로 가 볼까요?',
      coach: '색이 다른 위쪽 가운데 세 칸이 목적지예요. 왕을 그중 한 칸으로 옮기면 이겨요.',
      hintIdle: '파란 왕을 먼저 눌러 보세요',
      hintArmed: '파란 목적지 칸을 눌러 보세요',
    },
  ],
};

export interface LessonCopy {
  title: string;
  coach: string;
  hintIdle: string;
  hintArmed: string;
}

export type Dict = Omit<{ [K in keyof typeof ko]: string }, 'tutorialLessons'> & {
  tutorialLessons: LessonCopy[];
};

const ja: Dict = {
  appTitle: 'モンジン',
  cancel: 'キャンセル',
  confirm: 'OK',
  black: '黒',
  white: '白',
  me: '自分',
  opponentGeneric: '相手',

  homeTabQuick: 'すぐ対戦',
  homeQuickBlurb: '接続中の相手と自動マッチング',
  homeQuickCta: '対局開始',
  homeTabFriend: 'フレンド',
  homeFriendBlurb: '入場コードでフレンドと対局します',
  homeFriendCta: 'コードを作成',
  homeTabAI: 'コンピュータ',
  homeAIBlurb: '難易度と陣営を選んで練習します',
  homeAICta: '対局準備',
  homeTabLocal: '同じ端末で対戦',
  homeLocalBlurb: '1台の端末で黒・白を交互に指します',
  homeLocalCta: '対局開始',
  tutorial: 'チュートリアル',
  eloWinsShort: 'Elo {rating} · {wins}勝',

  quickMatch: 'すぐ対戦',
  matched: 'マッチしました！',
  searchingShort: '相手を探しています',
  searching: '相手を探しています…',

  friendMatch: 'フレンド対戦',
  entryCode: '入場コード',
  friendIntro: 'フレンドに入場コードを送るか、受け取ったコードで入場しましょう。',
  createCode: '入場コードを作成',
  or: 'または',
  codePlaceholder: '6桁のコード',
  joinWithCode: 'コードで参加',
  codeShareBtn: 'コードを共有',
  friendWaitingStart: '相手が入場すると対局が始まります',
  friendWaiting: '相手を待っています',
  joining: '入場中…',
  codeLengthError: '6桁の入場コードを入力してください',
  inviteShareMessage: 'モンジン フレンド対戦に招待！\n入場コード: {code}\n参加リンク: {link}',

  aiMatch: 'コンピュータ対戦',
  setupHeading: '対局を準備しましょう',
  botDifficulty: 'BOTの難易度',
  diffEasy: 'かんたん',
  diffNormal: 'ふつう',
  diffHard: 'むずかしい',
  diffEasyDesc: 'ルールに合う基本的な手を落ち着いて指す',
  diffNormalDesc: '初級戦術と基本防守を読む',
  diffHardDesc: '最善手を深く読んで隙を見逃さない',
  myColor: '自分の色',
  colorBlackFirst: '黒・先攻',
  colorWhiteSecond: '白・後攻',
  colorRandom: 'ランダム',
  startGame: '対局開始',

  localMode: '同じ端末で対戦',
  computerMode: 'コンピュータ',
  tutorialMode: 'チュートリアル',
  aiModeDiff: 'コンピュータ · {difficulty}',
  blackWins: '黒の勝ち',
  whiteWins: '白の勝ち',
  victory: '勝ち',
  defeat: '負け',
  resignConfirmTitle: '降参しますか？',
  resignConfirmBody: 'この対局は負けとして記録され、相手にはあなたが降参したことが伝わります。',
  resign: '降参',
  exitConfirmTitle: '対局を終了しますか？',
  exitConfirmBody: '進行中の対局は保存されません。',
  endGameAction: '終了',
  exit: '出る',
  endGameBtn: '対局終了',
  opponentThinking: '相手が考えています',
  aiThinking: 'コンピュータが考えています',
  turnOf: '{side}の番',
  undo: '待った',
  remainingTime: '残り時間',
  clockOpponentTurn: '相手の番',
  blackGuards: '黒の護衛',
  whiteGuards: '白の護衛',
  sideWithElo: '{side} · Elo {rating}',

  rForfeitWon: '相手が降参しました',
  rForfeitLost: '降参しました',
  rTimeoutWon: '相手が制限時間内に指せませんでした',
  rTimeoutLost: '1分以内に指せませんでした',
  rGoalWon: '王が目的地に到着しました',
  rGoalLost: '相手の王が目的地に到着しました',
  rGoalLocal: '王が目的地に到着しました',
  rCaptureWon: '相手の王を取りました',
  rCaptureLost: '王が取られました',
  rCaptureLocal: '王を取って勝ちました',
  rSurroundWon: '相手の王を包囲しました',
  rSurroundLost: '王が包囲されました',
  rSurroundLocal: '王を包囲して勝ちました',
  rNoMovesWon: '相手は指せる手がありませんでした',
  rNoMovesLost: '指せる手がありませんでした',

  myProfile: 'マイプロフィール',
  myRecord: '戦績',
  recordLine: '{wins}勝 {losses}敗 · 勝率 {rate}%',
  onlineRankLine: 'オンライン順位 {rank}位',
  nickname: 'ニックネーム',
  nicknamePlaceholder: '2〜12文字',
  saveNickname: 'ニックネームを保存',
  nameLengthError: 'ニックネームは2〜12文字で入力してください',
  saveNameFailed: 'ニックネームを端末に保存できませんでした',
  savedName: 'ニックネームを保存しました',
  saveRecordFailed: '戦績を端末に保存できませんでした',
  language: '言語',
  discordCommunity: 'Discordコミュニティ',

  connecting: 'サーバーに接続中…',
  connectedStatus: 'サーバーに接続済み',
  disconnected: '接続切断',
  connectFailed: 'サーバーに接続できませんでした',
  notConnected: 'サーバーに接続されていません',
  parseFailed: 'サーバーの応答を読み取れません',
  idSaveFailed: 'プロフィールIDを端末に保存できませんでした',
  queueCancelled: 'ランダムマッチングをキャンセルしました',
  noMatchFound: '対戦相手が見つかりませんでした',
  opponentLeft: '相手が接続を切りました',
  matchFoundLine: '{name}さんとマッチしました · {side}',
  waitingSideLine: '{side} · 相手を待っています',
  ghostMatchLine: '{name}さんと対局します · {side}',
  ghostMatchShort: '{name}さんと対局します',

  tutorialDoneTitle: 'これで基本ルールをすべて覚えました',
  tutorialDoneCoach: 'コンピュータと一局指して練習してみましょう。',
  practiceWithAI: 'コンピュータで練習する',
  goHome: 'ホームへ',
  todoNow: '今やること',

  tutorialLessons: [
    {
      title: '護衛を置いてみましょう',
      coach: '黒から始めます。黒い王のすぐ上にある、青く光るマスをタップして護衛を置いてみてください。',
      hintIdle: '青いマスをタップして護衛を置いてみましょう',
      hintArmed: '青いマスをタップして護衛を置いてみましょう',
    },
    {
      title: '王を動かしてみましょう',
      coach: '1回にできる行動は1つだけです。王をタップしてから、青いマスへ移動してみてください。',
      hintIdle: 'まず青い王をタップしてみましょう',
      hintArmed: '青いマスへ王を移動してみましょう',
    },
    {
      title: '護衛で取ってみましょう',
      coach: '護衛は上下左右に動けます。相手の護衛がいるマスへ移動すると取ることができます。',
      hintIdle: 'まず青い護衛をタップしてみましょう',
      hintArmed: '白い護衛をタップして取ってみましょう',
    },
    {
      title: '王を取ると終わり',
      coach: '護衛は目的地には入れませんが、そこにいる王は取れます。王を取ると対局が終わります。',
      hintIdle: 'まず青い護衛をタップしてみましょう',
      hintArmed: '白い王をタップして取ってみましょう',
    },
    {
      title: '目的地を目指しましょう',
      coach: '色の違う上段中央の3マスが目的地です。王をそのうち1マスへ移動すれば勝ちです。',
      hintIdle: 'まず青い王をタップしてみましょう',
      hintArmed: '青い目的地のマスをタップしてみましょう',
    },
  ],
};

const en: Dict = {
  appTitle: 'MONGJIN',
  cancel: 'Cancel',
  confirm: 'OK',
  black: 'Black',
  white: 'White',
  me: 'You',
  opponentGeneric: 'Opponent',

  homeTabQuick: 'Quick Match',
  homeQuickBlurb: 'Auto-match with players who are online',
  homeQuickCta: 'Start Game',
  homeTabFriend: 'Friends',
  homeFriendBlurb: 'Play friends with an entry code',
  homeFriendCta: 'Create Code',
  homeTabAI: 'Computer',
  homeAIBlurb: 'Practice against the AI with your pick of difficulty and side',
  homeAICta: 'Set Up Game',
  homeTabLocal: 'Pass & Play',
  homeLocalBlurb: 'Take turns playing Black and White on one device',
  homeLocalCta: 'Start Game',
  tutorial: 'Tutorial',
  eloWinsShort: 'Elo {rating} · {wins}W',

  quickMatch: 'Quick Match',
  matched: 'Matched!',
  searchingShort: 'Finding an opponent',
  searching: 'Finding an opponent…',

  friendMatch: 'Friend Match',
  entryCode: 'Entry Code',
  friendIntro: 'Send a code to your friend, or enter a code you received.',
  createCode: 'Generate Entry Code',
  or: 'or',
  codePlaceholder: '6-character code',
  joinWithCode: 'Join with Code',
  codeShareBtn: 'Share Code',
  friendWaitingStart: 'The game starts when your opponent joins',
  friendWaiting: 'Waiting for your opponent',
  joining: 'Joining…',
  codeLengthError: 'Please enter the 6-character entry code',
  inviteShareMessage: 'Join my Mongjin match!\nEntry code: {code}\nJoin link: {link}',

  aiMatch: 'Computer Match',
  setupHeading: 'Prepare your game',
  botDifficulty: 'Bot Difficulty',
  diffEasy: 'Easy',
  diffNormal: 'Normal',
  diffHard: 'Hard',
  diffEasyDesc: 'Plays calm, rule-abiding basic moves',
  diffNormalDesc: 'Reads beginner tactics and basic defense',
  diffHardDesc: 'Reads deeply for the best move and punishes mistakes',
  myColor: 'Your Color',
  colorBlackFirst: 'Black · First',
  colorWhiteSecond: 'White · Second',
  colorRandom: 'Random',
  startGame: 'Start Game',

  localMode: 'Pass & Play',
  computerMode: 'Computer',
  tutorialMode: 'Tutorial',
  aiModeDiff: 'Computer · {difficulty}',
  blackWins: 'Black wins',
  whiteWins: 'White wins',
  victory: 'Victory',
  defeat: 'Defeat',
  resignConfirmTitle: 'Resign?',
  resignConfirmBody: 'This game will be recorded as a loss. Your opponent will see it as you resigning.',
  resign: 'Resign',
  exitConfirmTitle: 'End this game?',
  exitConfirmBody: 'The game in progress will not be saved.',
  endGameAction: 'End',
  exit: 'Exit',
  endGameBtn: 'End Game',
  opponentThinking: 'Opponent is thinking',
  aiThinking: 'Computer is thinking',
  turnOf: "{side}'s turn",
  undo: 'Undo',
  remainingTime: 'Time left',
  clockOpponentTurn: "Opponent's turn",
  blackGuards: 'Black Guards',
  whiteGuards: 'White Guards',
  sideWithElo: '{side} · Elo {rating}',

  rForfeitWon: 'Your opponent resigned',
  rForfeitLost: 'You resigned',
  rTimeoutWon: 'Your opponent ran out of time',
  rTimeoutLost: 'You ran out of time',
  rGoalWon: 'Your king reached the goal',
  rGoalLost: 'The enemy king reached the goal',
  rGoalLocal: 'A king reached the goal',
  rCaptureWon: 'You captured the enemy king',
  rCaptureLost: 'Your king was captured',
  rCaptureLocal: 'Captured the king to win',
  rSurroundWon: 'You surrounded the enemy king',
  rSurroundLost: 'Your king was surrounded',
  rSurroundLocal: 'Surrounded the king to win',
  rNoMovesWon: 'Your opponent had no moves left',
  rNoMovesLost: 'You had no moves left',

  myProfile: 'My Profile',
  myRecord: 'Record',
  recordLine: '{wins}W {losses}L · Win rate {rate}%',
  onlineRankLine: 'Online rank #{rank}',
  nickname: 'Nickname',
  nicknamePlaceholder: '2–12 characters',
  saveNickname: 'Save Nickname',
  nameLengthError: 'Nickname must be 2–12 characters',
  saveNameFailed: 'Could not save your nickname on this device',
  savedName: 'Nickname saved',
  saveRecordFailed: 'Could not save the result on this device',
  language: 'Language',
  discordCommunity: 'Discord Community',

  connecting: 'Connecting to server…',
  connectedStatus: 'Connected to server',
  disconnected: 'Disconnected',
  connectFailed: 'Could not reach the server',
  notConnected: 'Not connected to the server',
  parseFailed: 'Could not read the server response',
  idSaveFailed: 'Could not save your profile ID on this device',
  queueCancelled: 'Random matching cancelled',
  noMatchFound: "Couldn't find an opponent",
  opponentLeft: 'Your opponent disconnected',
  matchFoundLine: 'Matched with {name} · {side}',
  waitingSideLine: '{side} · Waiting for opponent',
  ghostMatchLine: 'Playing against {name} · {side}',
  ghostMatchShort: 'Playing against {name}',

  tutorialDoneTitle: "You've learned all the basic rules",
  tutorialDoneCoach: 'Try a practice game against the computer.',
  practiceWithAI: 'Practice vs Computer',
  goHome: 'Home',
  todoNow: 'Next step',

  tutorialLessons: [
    {
      title: 'Place a guard',
      coach: 'Black moves first. Tap the glowing blue cell right above the black king to place a guard.',
      hintIdle: 'Tap a blue cell to place your guard',
      hintArmed: 'Tap a blue cell to place your guard',
    },
    {
      title: 'Move your king',
      coach: 'You can do one thing per turn. Tap the king first, then tap a blue cell to move him.',
      hintIdle: 'Tap your blue king first',
      hintArmed: 'Move your king to a blue cell',
    },
    {
      title: 'Capture with a guard',
      coach: 'Guards move up, down, left, or right. Move onto a cell with an enemy guard to capture it.',
      hintIdle: 'Tap your blue guard first',
      hintArmed: 'Tap the white guard to capture it',
    },
    {
      title: 'Capture the king to win',
      coach: 'Guards cannot enter goal cells, but they can capture a king standing there. Capturing the king ends the game.',
      hintIdle: 'Tap your blue guard first',
      hintArmed: 'Tap the white king to capture it',
    },
    {
      title: 'Reach the goal',
      coach: 'The three center cells at the far edge are your goal. Move your king onto one of them to win.',
      hintIdle: 'Tap your blue king first',
      hintArmed: 'Tap a blue goal cell',
    },
  ],
};

const zh: Dict = {
  appTitle: 'MONGJIN',
  cancel: '取消',
  confirm: '确定',
  black: '黑',
  white: '白',
  me: '我',
  opponentGeneric: '对手',

  homeTabQuick: '快速对战',
  homeQuickBlurb: '与在线玩家自动匹配',
  homeQuickCta: '开始对局',
  homeTabFriend: '好友',
  homeFriendBlurb: '通过邀请码与好友对局',
  homeFriendCta: '创建代码',
  homeTabAI: '电脑',
  homeAIBlurb: '自选难度与阵营进行练习',
  homeAICta: '准备对局',
  homeTabLocal: '同屏对战',
  homeLocalBlurb: '在一台设备上轮流执黑、白',
  homeLocalCta: '开始对局',
  tutorial: '教程',
  eloWinsShort: 'Elo {rating} · {wins}胜',

  quickMatch: '快速对战',
  matched: '已匹配！',
  searchingShort: '正在寻找对手',
  searching: '正在寻找对手…',

  friendMatch: '好友对战',
  entryCode: '邀请码',
  friendIntro: '把邀请码发送给朋友，或输入收到的代码加入对局。',
  createCode: '生成邀请码',
  or: '或',
  codePlaceholder: '6位代码',
  joinWithCode: '使用代码加入',
  codeShareBtn: '分享代码',
  friendWaitingStart: '对方进入后对局即开始',
  friendWaiting: '正在等待对方',
  joining: '正在加入…',
  codeLengthError: '请输入6位邀请码',
  inviteShareMessage: 'MONGJIN 好友对战邀请！\n邀请码：{code}\n加入链接：{link}',

  aiMatch: '人机对战',
  setupHeading: '准备对局',
  botDifficulty: '电脑难度',
  diffEasy: '简单',
  diffNormal: '普通',
  diffHard: '困难',
  diffEasyDesc: '从容地按规则走出基本着法',
  diffNormalDesc: '会读初级战术和基本防守',
  diffHardDesc: '深算最佳着法，不放过任何破绽',
  myColor: '我的颜色',
  colorBlackFirst: '黑 · 先手',
  colorWhiteSecond: '白 · 后手',
  colorRandom: '随机',
  startGame: '开始对局',

  localMode: '同屏对战',
  computerMode: '电脑',
  tutorialMode: '教程',
  aiModeDiff: '电脑 · {difficulty}',
  blackWins: '黑方胜利',
  whiteWins: '白方胜利',
  victory: '胜利',
  defeat: '失败',
  resignConfirmTitle: '要投降吗？',
  resignConfirmBody: '本局将被记为失败，对手会看到你投降了。',
  resign: '投降',
  exitConfirmTitle: '要结束本局吗？',
  exitConfirmBody: '进行中的对局不会被保存。',
  endGameAction: '结束',
  exit: '退出',
  endGameBtn: '结束对局',
  opponentThinking: '对手行棋中',
  aiThinking: '电脑思考中',
  turnOf: '{side}方回合',
  undo: '悔棋',
  remainingTime: '剩余时间',
  clockOpponentTurn: '对手回合',
  blackGuards: '黑护卫',
  whiteGuards: '白护卫',
  sideWithElo: '{side} · Elo {rating}',

  rForfeitWon: '对手投降了',
  rForfeitLost: '你投降了',
  rTimeoutWon: '对手未在限时内落子',
  rTimeoutLost: '你未在一分钟内落子',
  rGoalWon: '你的王到达了目的地',
  rGoalLost: '对方的王到达了目的地',
  rGoalLocal: '王到达了目的地',
  rCaptureWon: '你吃掉了对方的王',
  rCaptureLost: '你的王被吃掉了',
  rCaptureLocal: '吃掉王获胜',
  rSurroundWon: '你围住了对方的王',
  rSurroundLost: '你的王被围住了',
  rSurroundLocal: '围住王获胜',
  rNoMovesWon: '对手无棋可走',
  rNoMovesLost: '无棋可走',

  myProfile: '个人资料',
  myRecord: '战绩',
  recordLine: '{wins}胜 {losses}负 · 胜率 {rate}%',
  onlineRankLine: '在线排名第 {rank} 名',
  nickname: '昵称',
  nicknamePlaceholder: '2~12个字',
  saveNickname: '保存昵称',
  nameLengthError: '昵称请输入2~12个字',
  saveNameFailed: '未能将昵称保存到设备',
  savedName: '昵称已保存',
  saveRecordFailed: '未能将对局结果保存到设备',
  language: '语言',
  discordCommunity: 'Discord 社区',

  connecting: '正在连接服务器…',
  connectedStatus: '已连接服务器',
  disconnected: '连接已断开',
  connectFailed: '无法连接服务器',
  notConnected: '尚未连接到服务器',
  parseFailed: '无法读取服务器响应',
  idSaveFailed: '未能将资料ID保存到设备',
  queueCancelled: '已取消随机匹配',
  noMatchFound: '未找到对手',
  opponentLeft: '对方已断开连接',
  matchFoundLine: '已与{name}匹配 · {side}',
  waitingSideLine: '{side} · 正在等待对方',
  ghostMatchLine: '与{name}对局 · {side}',
  ghostMatchShort: '与{name}对局',

  tutorialDoneTitle: '基本规则已全部掌握',
  tutorialDoneCoach: '和电脑来一局练习一下吧。',
  practiceWithAI: '与电脑练习',
  goHome: '返回首页',
  todoNow: '现在要做的',

  tutorialLessons: [
    {
      title: '试试放置护卫',
      coach: '黑方先行。点击黑色王的正上方发光的蓝色格子，试着放下护卫。',
      hintIdle: '点击蓝格放置护卫',
      hintArmed: '点击蓝格放置护卫',
    },
    {
      title: '试试移动王',
      coach: '每回合只能进行一个行动。先点击王，再将它移动到蓝色格子。',
      hintIdle: '先点击发蓝光的己方王',
      hintArmed: '把王移动到蓝格',
    },
    {
      title: '用护卫吃子',
      coach: '护卫可以上下左右移动。移动到对方护卫所在的格子即可吃掉它。',
      hintIdle: '先点击发蓝光的护卫',
      hintArmed: '点击白护卫将其吃掉',
    },
    {
      title: '吃掉王即获胜',
      coach: '护卫不能进入目的地，但如果王就在那格里，就可以吃掉它。吃掉王后对局结束。',
      hintIdle: '先点击发蓝光的护卫',
      hintArmed: '点击白王将其吃掉',
    },
    {
      title: '向目的地进发',
      coach: '上排中间颜色不同的三个格子是目的地。把王移动到其中一格即获胜。',
      hintIdle: '先点击发蓝光的王',
      hintArmed: '点击蓝色的目的地格子',
    },
  ],
};

const dicts: Record<Lang, Dict> = { ko, ja, en, zh };

export const LANG_OPTIONS: Array<{ value: Lang; label: string }> = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

let currentLang: Lang = 'ko';

export function setI18nLang(lang: Lang): void {
  currentLang = lang;
}

export function getI18nLang(): Lang {
  return currentLang;
}

export function dict(lang: Lang = currentLang): Dict {
  return dicts[lang];
}

export function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function candidateLocaleTags(): string[] {
  const tags: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NativeModules } = require('react-native') as typeof import('react-native');
    if (Platform.OS === 'ios') {
      interface SettingsManagerLike { settings?: { AppleLocale?: unknown; AppleLanguages?: unknown } }
      const settings = (NativeModules.SettingsManager as SettingsManagerLike | undefined)?.settings;
      if (typeof settings?.AppleLocale === 'string') tags.push(settings.AppleLocale);
      if (Array.isArray(settings?.AppleLanguages)) tags.push(...(settings.AppleLanguages as unknown[]).filter((item): item is string => typeof item === 'string'));
    } else {
      interface I18nManagerLike { localeIdentifier?: unknown }
      const identifier = (NativeModules.I18nManager as I18nManagerLike | undefined)?.localeIdentifier;
      if (typeof identifier === 'string') tags.push(identifier);
    }
  } catch {
    // Fall through to Intl below.
  }
  try {
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof tag === 'string') tags.push(tag);
  } catch {
    // No Intl available.
  }
  return tags;
}

export function detectDeviceLang(): Lang {
  for (const tag of candidateLocaleTags()) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === 'ko') return 'ko';
    if (base === 'ja') return 'ja';
    if (base === 'zh') return 'zh';
    if (base === 'en') return 'en';
  }
  return 'en';
}

const LANG_KEY = 'mongjin.mobile.lang.v1';

export async function loadStoredLang(): Promise<Lang | null> {
  try {
    const raw = await AsyncStorage.getItem(LANG_KEY);
    return raw === 'ko' || raw === 'ja' || raw === 'en' ? raw : null;
  } catch {
    return null;
  }
}

export async function persistLang(lang: Lang): Promise<void> {
  try {
    await AsyncStorage.setItem(LANG_KEY, lang);
  } catch {
    // A failed write only means the next launch falls back to detection.
  }
}
