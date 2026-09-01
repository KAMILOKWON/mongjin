import './mobile.css';

import { initAppsInToss } from '../ait';
import { applyMove } from '../core/apply';
import { DEFAULT_CONFIG } from '../core/config';
import { initialState } from '../core/rules';
import type { Coord, GameState, Move, Piece, Player } from '../core/types';
import type { AiDifficulty, HumanColorChoice, OpponentMode } from '../game/settings';
import { getLocale, setLocale, t, type Locale } from '../i18n';
import { GameController, stoneHtml } from '../ui/gameController';
import woodTextureUrl from '../../assets/ui/board-light-ash.png';
import blackGuardUrl from '../../assets/ui/stone-black-guard.png';
import blackKingUrl from '../../assets/ui/stone-black-king.png';
import whiteGuardUrl from '../../assets/ui/stone-white-guard.png';
import whiteKingUrl from '../../assets/ui/stone-white-king.png';
import appStoreBadgeUrl from '../../assets/app-store-badge-black.svg';

type Route = 'home' | 'profile' | 'setup' | 'match' | 'game' | 'tutorial';
type HomeTab = 'quick' | 'ai' | 'local';

interface DisplayProfile {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  winRate: number;
}

interface TutorialLesson {
  title: string;
  coach: string;
  hintIdle: string;
  hintArmed: string;
  state: () => GameState;
  move: Move;
  showGoals: boolean;
}

const PROFILE_KEY = 'mongjin.native-parity.profile.v1';
const game = new GameController();
const app = document.querySelector<HTMLDivElement>('#app')!;

const locale = getLocale();
document.documentElement.lang = locale;
document.title = t('meta.title');
app.className = 'native-app';
app.style.setProperty('--board-texture', `url("${woodTextureUrl}")`);
app.style.setProperty('--stone-white', `url("${whiteGuardUrl}")`);
app.style.setProperty('--stone-black', `url("${blackGuardUrl}")`);
app.style.setProperty('--king-white', `url("${whiteKingUrl}")`);
app.style.setProperty('--king-black', `url("${blackKingUrl}")`);

function previewBoardMarkup(): string {
  return Array.from({ length: 81 }, (_, index) => {
    const r = Math.floor(index / 9);
    const c = index % 9;
    const goal = (r === 0 || r === 8) && c >= 3 && c <= 5;
    const piece = r === 0 && c === 4
      ? '<span class="preview-piece white king" aria-hidden="true"></span>'
      : r === 8 && c === 4
        ? '<span class="preview-piece black king" aria-hidden="true"></span>'
        : '';
    return `<span class="preview-cell${goal ? ' goal' : ''}">${piece}</span>`;
  }).join('');
}

app.innerHTML = `
  <main class="native-shell">
    <section class="screen home-screen active" data-route="home" data-i18n-aria="home.actions" aria-label="홈">
      <div class="home-scroll">
        <header class="home-header">
          <h1 data-i18n="brand.title">몽진</h1>
          <button class="profile-pill" id="open-profile" type="button" data-i18n-aria="profile.open" aria-label="내 프로필">
            <strong id="home-profile-name">플레이어</strong>
            <small id="home-profile-record">Elo 1200 · 0승</small>
          </button>
        </header>
        <div class="preview-board" role="img" data-i18n-aria="preview.aria" aria-label="몽진 초기 배치 미리보기">${previewBoardMarkup()}</div>
        <div class="home-controls">
          <div class="home-tabs" role="tablist" data-i18n-aria="home.actions" aria-label="대국 방식">
            <button class="active" type="button" role="tab" data-home-tab="quick" aria-selected="true" data-i18n="menu.random.title">빠른 대전</button>
            <button type="button" role="tab" data-home-tab="ai" aria-selected="false" data-i18n="menu.ai.title">컴퓨터</button>
            <button type="button" role="tab" data-home-tab="local" aria-selected="false" data-i18n="menu.friend.title">같이 두기</button>
          </div>
          <p class="home-blurb" id="home-blurb" data-i18n="menu.random.description">접속 중인 상대와 자동 매칭</p>
          <button class="primary-button" id="home-primary" type="button" data-i18n="menu.random.title">대국 시작</button>
          <div class="home-links">
            <button class="text-link" id="open-tutorial" type="button" data-i18n="menu.tutorial.title">튜토리얼</button>
            <span class="link-separator">·</span>
            <a href="./mongjin-print-and-play.pdf" target="_blank" rel="noopener noreferrer" class="text-link" data-i18n="menu.pnp.title">인쇄해서 두기</a>
          </div>
          <div class="language-toggle" role="group" data-i18n-aria="language.selector" aria-label="언어 선택">
            <button type="button" data-locale="ko" data-i18n="language.ko">한국어</button>
            <button type="button" data-locale="en" data-i18n="language.en">English</button>
            <button type="button" data-locale="ja" data-i18n="language.ja">日本語</button>
          </div>
          <a href="https://apps.apple.com/app/id6802212694" target="_blank" rel="noopener noreferrer" class="app-store-badge-link" data-i18n-aria="appstore.badge.aria" aria-label="App Store에서 다운로드">
            <img src="${appStoreBadgeUrl}" alt="Download on the App Store" class="app-store-badge" />
          </a>
        </div>
      </div>
      <div class="native-ad-space" aria-hidden="true"></div>
    </section>

    <section class="screen" data-route="profile" aria-label="내 프로필">
      <header class="screen-nav">
        <button class="nav-back" type="button" data-back-home aria-label="뒤로">‹</button>
        <h1>내 프로필</h1><span class="nav-spacer"></span>
      </header>
      <div class="screen-scroll profile-content">
        <section class="elo-card">
          <span id="profile-rank-kind">로컬 순위</span>
          <strong id="profile-elo">Elo 1200</strong>
          <small id="profile-summary">0승 0패 · 승률 0%</small>
        </section>
        <section class="field-block">
          <label for="profile-name">닉네임</label>
          <input id="profile-name" type="text" minlength="2" maxlength="12" autocomplete="nickname" placeholder="2~12자" />
          <button class="secondary-button" id="save-profile" type="button">닉네임 저장</button>
        </section>
      </div>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </section>

    <section class="screen" data-route="setup" aria-label="컴퓨터 대전 설정">
      <header class="screen-nav">
        <button class="nav-back" type="button" data-back-home aria-label="뒤로">‹</button>
        <h1>컴퓨터 대전</h1><span class="nav-spacer"></span>
      </header>
      <div class="setup-content">
        <h2>대국을 준비하세요</h2>
        <section class="field-block">
          <span class="field-label">봇 난이도</span>
          <div class="choice-row" id="difficulty-choice" role="radiogroup" aria-label="봇 난이도">
            <button type="button" role="radio" data-value="easy" aria-checked="false">쉬움</button>
            <button class="active" type="button" role="radio" data-value="normal" aria-checked="true">보통</button>
            <button type="button" role="radio" data-value="hard" aria-checked="false">어려움</button>
          </div>
          <p class="field-description" id="difficulty-description">초보 전술과 기본 수비를 읽어요</p>
        </section>
        <section class="field-block">
          <span class="field-label">내 색</span>
          <div class="choice-row" id="color-choice" role="radiogroup" aria-label="내 색">
            <button class="active" type="button" role="radio" data-value="BLACK" aria-checked="true">흑 · 선공</button>
            <button type="button" role="radio" data-value="WHITE" aria-checked="false">백 · 후공</button>
            <button type="button" role="radio" data-value="random" aria-checked="false">랜덤</button>
          </div>
        </section>
        <button class="primary-button setup-start" id="start-ai" type="button">대국 시작</button>
      </div>
    </section>

    <section class="screen" data-route="match" aria-label="빠른 대전 매칭">
      <header class="screen-nav">
        <button class="nav-back" id="cancel-match" type="button" aria-label="뒤로">‹</button>
        <h1>빠른 대전</h1><span class="nav-spacer"></span>
      </header>
      <div class="match-content">
        <div class="match-pulse" aria-hidden="true"><i></i><i></i><i></i></div>
        <h2 id="match-title">상대를 찾는 중</h2><p id="match-status"></p>
      </div>
    </section>

    <section class="screen game-screen" data-route="game" aria-label="대국">
      <header class="screen-nav">
        <button class="nav-back" id="leave-game-top" type="button" aria-label="뒤로">‹</button>
        <h1 id="game-title">같이 두기</h1><span class="nav-spacer"></span>
      </header>
      <div class="match-seats hidden" id="match-seats"></div>
      <div class="game-board-wrap"><div id="board"></div></div>
      <div class="game-status"><div class="turn-label" id="turn-label"></div><div class="guard-trays" id="guard-trays"></div></div>
      <div class="game-actions">
        <button class="secondary-button" id="undo" type="button">무르기</button>
        <button class="primary-button" id="leave-game" type="button">대국 종료</button>
      </div>
      <div class="result-backdrop hidden" id="result-backdrop">
        <section class="result-card">
          <span class="result-eyebrow">대국 종료</span><h2 id="result-title">승리</h2><p id="result-copy"></p>
          <button class="primary-button" id="close-result" type="button">확인</button>
        </section>
      </div>
    </section>

    <section class="screen tutorial-screen" data-route="tutorial" aria-label="튜토리얼">
      <header class="screen-nav">
        <button class="nav-back" id="leave-tutorial" type="button" aria-label="뒤로">‹</button>
        <h1>튜토리얼</h1><span class="nav-spacer"></span>
      </header>
      <section class="coach-card">
        <div><h2 id="tutorial-title"></h2><strong id="tutorial-count"></strong></div><p id="tutorial-coach"></p>
      </section>
      <div class="tutorial-board" id="tutorial-board"></div>
      <div class="tutorial-progress" id="tutorial-progress"></div>
      <section class="tutorial-footer" id="tutorial-active-footer">
        <span class="tap-icon" aria-hidden="true">☝︎</span><div><small>지금 할 일</small><strong id="tutorial-hint"></strong></div>
      </section>
      <section class="tutorial-complete hidden" id="tutorial-complete">
        <h2>✓ 규칙을 모두 익혔어요</h2><p>컴퓨터와 한 판 두면서 연습해 보세요.</p>
        <button class="primary-button" id="tutorial-practice" type="button">컴퓨터로 연습하기</button>
        <button class="secondary-button" id="tutorial-home" type="button">홈으로</button>
      </section>
    </section>
  </main>
`;

const routes = new Map<Route, HTMLElement>();
document.querySelectorAll<HTMLElement>('[data-route]').forEach((screen) => routes.set(screen.dataset.route as Route, screen));

const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const homeBlurbEl = document.querySelector<HTMLElement>('#home-blurb')!;
const homePrimaryEl = document.querySelector<HTMLButtonElement>('#home-primary')!;
const profileNameInput = document.querySelector<HTMLInputElement>('#profile-name')!;
const toastEl = document.querySelector<HTMLElement>('#toast')!;
const difficultyChoiceEl = document.querySelector<HTMLElement>('#difficulty-choice')!;
const colorChoiceEl = document.querySelector<HTMLElement>('#color-choice')!;
const difficultyDescriptionEl = document.querySelector<HTMLElement>('#difficulty-description')!;
const matchTitleEl = document.querySelector<HTMLElement>('#match-title')!;
const matchStatusEl = document.querySelector<HTMLElement>('#match-status')!;
const gameTitleEl = document.querySelector<HTMLElement>('#game-title')!;
const matchSeatsEl = document.querySelector<HTMLElement>('#match-seats')!;
const turnLabelEl = document.querySelector<HTMLElement>('#turn-label')!;
const guardTraysEl = document.querySelector<HTMLElement>('#guard-trays')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!;
const leaveGameButton = document.querySelector<HTMLButtonElement>('#leave-game')!;
const resultBackdropEl = document.querySelector<HTMLElement>('#result-backdrop')!;
const resultTitleEl = document.querySelector<HTMLElement>('#result-title')!;
const resultCopyEl = document.querySelector<HTMLElement>('#result-copy')!;
const tutorialTitleEl = document.querySelector<HTMLElement>('#tutorial-title')!;
const tutorialCountEl = document.querySelector<HTMLElement>('#tutorial-count')!;
const tutorialCoachEl = document.querySelector<HTMLElement>('#tutorial-coach')!;
const tutorialBoardEl = document.querySelector<HTMLElement>('#tutorial-board')!;
const tutorialProgressEl = document.querySelector<HTMLElement>('#tutorial-progress')!;
const tutorialHintEl = document.querySelector<HTMLElement>('#tutorial-hint')!;
const tutorialActiveFooterEl = document.querySelector<HTMLElement>('#tutorial-active-footer')!;
const tutorialCompleteEl = document.querySelector<HTMLElement>('#tutorial-complete')!;

let route: Route = 'home';
let homeTab: HomeTab = 'quick';
let toastTimer = 0;
const nativeAdBridge = (window as Window & {
  MongjinAndroid?: { setHomeVisible: (visible: boolean) => void };
}).MongjinAndroid;

if (nativeAdBridge) document.documentElement.classList.add('android-native');

function loadLocalProfile(): DisplayProfile {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as Partial<DisplayProfile> | null;
    return {
      name: typeof saved?.name === 'string' ? saved.name : '플레이어',
      rating: typeof saved?.rating === 'number' ? saved.rating : 1200,
      wins: typeof saved?.wins === 'number' ? saved.wins : 0,
      losses: typeof saved?.losses === 'number' ? saved.losses : 0,
      winRate: typeof saved?.winRate === 'number' ? saved.winRate : 0,
    };
  } catch {
    return { name: '플레이어', rating: 1200, wins: 0, losses: 0, winRate: 0 };
  }
}

let localProfile = loadLocalProfile();

function saveLocalProfile(profile: DisplayProfile) {
  localProfile = profile;
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* session fallback */ }
}

function displayProfile(): DisplayProfile {
  const remote = game.getSnapshot().profile;
  if (!remote) return localProfile;
  const next = { name: remote.name, rating: remote.rating, wins: remote.wins, losses: remote.losses, winRate: remote.winRate };
  saveLocalProfile(next);
  return next;
}

function showToast(message: string) {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), 2200);
}

function navigate(next: Route) {
  route = next;
  routes.forEach((screen, key) => screen.classList.toggle('active', key === next));
  nativeAdBridge?.setHomeVisible(next === 'home');
  if (next === 'profile') { void game.refreshProfile(); renderProfile(); }
  if (next === 'game') requestAnimationFrame(() => game.refreshBoardLayout());
  if (next === 'tutorial') startTutorial();
}

function renderHomeTab() {
  document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((button) => {
    const active = button.dataset.homeTab === homeTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const copy = homeTab === 'quick'
    ? { blurb: t('menu.random.description'), cta: t('setup.start') }
    : homeTab === 'ai'
      ? { blurb: t('menu.ai.description'), cta: t('setup.title') }
      : { blurb: t('menu.friend.description'), cta: t('setup.start') };
  homeBlurbEl.textContent = copy.blurb;
  homePrimaryEl.textContent = copy.cta;
}

function renderProfile() {
  const profile = displayProfile();
  const onlineProfile = game.getSnapshot().profile;
  document.querySelector<HTMLElement>('#home-profile-name')!.textContent = profile.name;
  document.querySelector<HTMLElement>('#home-profile-record')!.textContent = `Elo ${profile.rating} · ${profile.wins}승`;
  document.querySelector<HTMLElement>('#profile-rank-kind')!.textContent = onlineProfile ? '온라인 순위' : '로컬 Elo';
  document.querySelector<HTMLElement>('#profile-elo')!.textContent = onlineProfile ? `${onlineProfile.rank}위` : `Elo ${profile.rating}`;
  document.querySelector<HTMLElement>('#profile-summary')!.textContent = `${profile.wins}승 ${profile.losses}패 · 승률 ${profile.winRate}%`;
  if (document.activeElement !== profileNameInput) profileNameInput.value = profile.name;
}

function choiceValue(group: HTMLElement): string {
  return group.querySelector<HTMLElement>('button.active')?.dataset.value ?? '';
}

function bindChoice(group: HTMLElement, onChange?: () => void) {
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || !group.contains(button)) return;
    group.querySelectorAll('button').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
    });
    onChange?.();
  });
}

const difficultyCopy: Record<AiDifficulty, string> = {
  easy: '기본 수와 즉시 전술을 익혀요', normal: '초보 전술과 기본 수비를 읽어요', hard: '최선 수를 깊게 읽어요',
};

function startGame(mode: OpponentMode, difficulty?: AiDifficulty, color?: HumanColorChoice) {
  game.setMode(mode);
  if (difficulty) game.setAiDifficulty(difficulty);
  if (color) game.setHumanColor(color);
  game.reset();
  navigate('game');
}

function leaveGame() {
  if (game.getSnapshot().settings.mode === 'online') game.cancelRandomMatch();
  resultBackdropEl.classList.add('hidden');
  navigate('home');
}

function playerName(player: Player): string { return player === 'BLACK' ? '흑' : '백'; }

function modeTitle(): string {
  const snap = game.getSnapshot();
  if (snap.settings.mode === 'online') return '빠른 대전';
  if (snap.settings.mode === 'ghost') return `고스트 · ${snap.ghostOpponent?.name ?? '상대'}`;
  if (snap.settings.mode === 'local') return '같이 두기';
  const labels: Record<AiDifficulty, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };
  return `컴퓨터 · ${labels[snap.settings.aiDifficulty]}`;
}

function seatMarkup(player: Player): string {
  const snap = game.getSnapshot();
  const me = snap.humanSide === player;
  const profile = displayProfile();
  const opponent = snap.onlineOpponent ?? snap.ghostOpponent;
  const name = me ? profile.name : (opponent?.name ?? '상대');
  const rating = me ? profile.rating : (opponent?.rating ?? 1200);
  const active = !snap.result && snap.state.turn === player;
  const color = player.toLowerCase();
  return `<article class="seat ${color}${active ? ' active' : ''}"><span class="seat-piece ${color}"></span><div><strong>${name}${me ? '<em>나</em>' : ''}</strong><small>${playerName(player)} · Elo ${rating}</small></div></article>`;
}

function renderGame() {
  const snap = game.getSnapshot();
  renderProfile();
  if (route === 'match') {
    matchTitleEl.textContent = snap.settings.mode === 'ghost'
      ? '고스트를 찾았어요'
      : snap.onlineSide ? '매칭됐어요' : '상대를 찾는 중';
    matchStatusEl.textContent = snap.onlineStatus;
    if (snap.settings.mode === 'ghost' || (snap.onlineMatchKind === 'random' && snap.onlineSide && !snap.onlineWaiting)) {
      navigate('game');
    }
  }
  gameTitleEl.textContent = modeTitle();
  const quick = snap.settings.mode === 'online' || snap.settings.mode === 'ghost';
  matchSeatsEl.classList.toggle('hidden', !quick);
  if (quick) matchSeatsEl.innerHTML = seatMarkup('WHITE') + seatMarkup('BLACK');
  const turnStone = snap.result ? '' : `<span class="turn-stone ${snap.state.turn.toLowerCase()}"></span>`;
  turnLabelEl.innerHTML = `${turnStone}<strong>${snap.resultLabel ?? snap.turnLabel}</strong>`;
  guardTraysEl.innerHTML = (['WHITE', 'BLACK'] as const).map((player) => {
    const count = snap.state.guardsInHand[player];
    return `<article class="guard-tray ${player.toLowerCase()}${!snap.result && snap.state.turn === player ? ' active' : ''}"><header><span>${playerName(player)} 호위</span><strong>${count} / 8</strong></header><div>${stoneHtml(player, count)}</div></article>`;
  }).join('');
  undoButton.disabled = !snap.canUndo || snap.aiThinking;
  undoButton.classList.toggle('hidden', quick);
  leaveGameButton.textContent = snap.result ? '나가기' : (quick ? '항복' : '대국 종료');
  const showResult = route === 'game' && snap.result !== null;
  resultBackdropEl.classList.toggle('hidden', !showResult);
  if (snap.result) {
    const mine = snap.settings.mode !== 'local' && snap.result.winner === snap.humanSide;
    resultTitleEl.textContent = snap.settings.mode === 'local' ? `${playerName(snap.result.winner)} 승리` : (mine ? '승리' : '패배');
    resultCopyEl.textContent = snap.resultLabel ?? '';
  }
}

function makeState(pieces: Array<[number, number, Player, Piece['type']]>, blackHand = 8, whiteHand = 8): GameState {
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => null));
  pieces.forEach(([r, c, player, type]) => { board[r][c] = { player, type }; });
  return { board, turn: 'BLACK', guardsInHand: { BLACK: blackHand, WHITE: whiteHand }, history: [], positionCounts: {} };
}

const tutorialLessons: TutorialLesson[] = [
  {
    title: '호위를 놓아 볼까요?',
    coach: '흑부터 시작해요. 검은 왕 바로 위에 파랗게 깜빡이는 칸이 보이죠? 그 칸을 눌러 호위를 놓아 보세요.',
    hintIdle: '파란 칸을 눌러 호위를 놓아 보세요', hintArmed: '파란 칸을 눌러 호위를 놓아 보세요',
    state: () => initialState(DEFAULT_CONFIG), move: { kind: 'PLACE', to: { r: 7, c: 4 } }, showGoals: false,
  },
  {
    title: '왕을 움직여 볼까요?',
    coach: '한 번에 한 가지 행동만 할 수 있어요. 파랗게 빛나는 왕을 누른 다음, 옆의 파란 칸으로 옮겨 보세요.',
    hintIdle: '파란 왕을 먼저 눌러 보세요', hintArmed: '파란 칸을 눌러 왕을 옮겨 보세요',
    state: () => { const state = applyMove(initialState(DEFAULT_CONFIG), { kind: 'PLACE', to: { r: 7, c: 4 } }); state.turn = 'BLACK'; return state; },
    move: { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 3 } }, showGoals: false,
  },
  {
    title: '호위로 잡아 볼까요?',
    coach: '호위는 위, 아래, 왼쪽, 오른쪽으로 한 칸씩 움직여요. 상대 호위가 있는 칸으로 이동하면 잡을 수 있어요.',
    hintIdle: '파란 호위를 먼저 눌러 보세요', hintArmed: '흰 호위를 눌러 잡아 보세요',
    state: () => makeState([[8, 4, 'BLACK', 'KING'], [6, 4, 'BLACK', 'GUARD'], [0, 4, 'WHITE', 'KING'], [5, 4, 'WHITE', 'GUARD']], 7, 7),
    move: { kind: 'MOVE', from: { r: 6, c: 4 }, to: { r: 5, c: 4 } }, showGoals: false,
  },
  {
    title: '왕을 잡으면 끝나요',
    coach: '호위는 목적지에는 들어갈 수 없지만 그 칸에 왕이 있으면 잡을 수 있어요. 왕을 잡으면 대국이 끝나요.',
    hintIdle: '파란 호위를 먼저 눌러 보세요', hintArmed: '흰 왕을 눌러 잡아 보세요',
    state: () => makeState([[8, 4, 'BLACK', 'KING'], [1, 4, 'BLACK', 'GUARD'], [0, 4, 'WHITE', 'KING']], 7, 8),
    move: { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 0, c: 4 } }, showGoals: true,
  },
  {
    title: '목적지로 가 볼까요?', coach: '색이 다른 위쪽 가운데 세 칸이 목적지예요. 왕을 그중 한 칸으로 옮기면 이겨요.',
    hintIdle: '파란 왕을 먼저 눌러 보세요', hintArmed: '파란 목적지 칸을 눌러 보세요',
    state: () => makeState([[1, 3, 'BLACK', 'KING'], [0, 4, 'WHITE', 'KING']]),
    move: { kind: 'MOVE', from: { r: 1, c: 3 }, to: { r: 0, c: 3 } }, showGoals: true,
  },
];

let tutorialIndex = 0;
let tutorialState = tutorialLessons[0].state();
let tutorialSelected: Coord | null = null;
let tutorialFinished = false;

function sameCoord(a: Coord | undefined, b: Coord): boolean { return Boolean(a && a.r === b.r && a.c === b.c); }
function tutorialPiece(piece: Piece): string { return `<span class="tutorial-piece ${piece.player.toLowerCase()} ${piece.type.toLowerCase()}"></span>`; }

function applyTranslations() {
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.title = t('meta.title');
  
  // Update all text content with data-i18n attribute
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(key);
  });
  
  // Update all aria-labels with data-i18n-aria attribute
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((element) => {
    const key = element.dataset.i18nAria;
    if (key) element.setAttribute('aria-label', t(key));
  });
  
  // Mark active locale button
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
    button.classList.toggle('active', button.dataset.locale === locale);
    button.setAttribute('aria-pressed', String(button.dataset.locale === locale));
  });
}

function renderTutorial() {
  const lesson = tutorialLessons[tutorialIndex];
  tutorialTitleEl.textContent = tutorialFinished ? '이제 기본 규칙을 모두 익혔어요' : lesson.title;
  tutorialCountEl.textContent = `${tutorialIndex + 1} / ${tutorialLessons.length}`;
  tutorialCoachEl.textContent = tutorialFinished ? '컴퓨터와 한 판 두면서 연습해 보세요.' : lesson.coach;
  tutorialHintEl.textContent = tutorialSelected ? lesson.hintArmed : lesson.hintIdle;
  tutorialActiveFooterEl.classList.toggle('hidden', tutorialFinished);
  tutorialCompleteEl.classList.toggle('hidden', !tutorialFinished);
  tutorialProgressEl.innerHTML = tutorialLessons.map((_, index) => `<i class="${index <= tutorialIndex ? 'done' : ''}${index === tutorialIndex ? ' current' : ''}"></i>`).join('');
  tutorialBoardEl.innerHTML = tutorialState.board.flatMap((row, r) => row.map((piece, c) => {
    const coord = { r, c };
    const move = lesson.move;
    const goal = lesson.showGoals && (r === 0 || r === 8) && c >= 3 && c <= 5;
    const selected = sameCoord(tutorialSelected ?? undefined, coord);
    const placeHint = move.kind === 'PLACE' && sameCoord(move.to, coord);
    const sourceHint = move.kind === 'MOVE' && !tutorialSelected && sameCoord(move.from, coord);
    const targetHint = move.kind === 'MOVE' && Boolean(tutorialSelected) && sameCoord(move.to, coord);
    const hint = placeHint || sourceHint || targetHint;
    return `<button type="button" class="tutorial-cell${goal ? ' goal' : ''}${selected ? ' selected' : ''}${hint ? ' hint' : ''}${targetHint ? ' target' : ''}" data-r="${r}" data-c="${c}">${piece ? tutorialPiece(piece) : ''}</button>`;
  })).join('');
}

function startTutorial() {
  tutorialIndex = 0; tutorialState = tutorialLessons[0].state(); tutorialSelected = null; tutorialFinished = false; renderTutorial();
}

function advanceTutorial() {
  if (tutorialIndex >= tutorialLessons.length - 1) { tutorialFinished = true; renderTutorial(); return; }
  tutorialIndex += 1; tutorialState = tutorialLessons[tutorialIndex].state(); tutorialSelected = null; renderTutorial();
}

document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((button) => button.addEventListener('click', () => {
  homeTab = button.dataset.homeTab as HomeTab; renderHomeTab();
}));
document.querySelector('#open-profile')!.addEventListener('click', () => navigate('profile'));
document.querySelectorAll('[data-back-home]').forEach((button) => button.addEventListener('click', () => navigate('home')));
document.querySelector('#open-tutorial')!.addEventListener('click', () => navigate('tutorial'));
document.querySelector('#leave-tutorial')!.addEventListener('click', () => navigate('home'));

homePrimaryEl.addEventListener('click', () => {
  if (homeTab === 'quick') { game.setMode('online'); navigate('match'); void game.startRandomMatch(); }
  else if (homeTab === 'ai') navigate('setup');
  else startGame('local');
});

document.querySelector('#cancel-match')!.addEventListener('click', () => { game.cancelRandomMatch(); navigate('home'); });
document.querySelector('#save-profile')!.addEventListener('click', () => {
  const name = profileNameInput.value.trim();
  if (name.length < 2 || name.length > 12) { showToast('닉네임은 2~12자로 적어 주세요'); return; }
  saveLocalProfile({ ...displayProfile(), name }); void game.updateProfileName(name); renderProfile(); showToast('닉네임을 저장했어요');
});

bindChoice(difficultyChoiceEl, () => { difficultyDescriptionEl.textContent = difficultyCopy[choiceValue(difficultyChoiceEl) as AiDifficulty]; });
bindChoice(colorChoiceEl);
document.querySelector('#start-ai')!.addEventListener('click', () => startGame('ai', choiceValue(difficultyChoiceEl) as AiDifficulty, choiceValue(colorChoiceEl) as HumanColorChoice));
undoButton.addEventListener('click', () => game.undo());
document.querySelector('#leave-game-top')!.addEventListener('click', leaveGame);
leaveGameButton.addEventListener('click', leaveGame);
document.querySelector('#close-result')!.addEventListener('click', leaveGame);

tutorialBoardEl.addEventListener('click', (event) => {
  if (tutorialFinished) return;
  const cell = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-r][data-c]');
  if (!cell) return;
  const coord = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
  const move = tutorialLessons[tutorialIndex].move;
  if (move.kind === 'PLACE' && sameCoord(move.to, coord)) { advanceTutorial(); return; }
  if (move.kind === 'MOVE') {
    if (!tutorialSelected && sameCoord(move.from, coord)) { tutorialSelected = coord; renderTutorial(); }
    else if (tutorialSelected && sameCoord(move.to, coord)) advanceTutorial();
  }
});

document.querySelector('#tutorial-practice')!.addEventListener('click', () => startGame('ai', 'easy', 'BLACK'));
document.querySelector('#tutorial-home')!.addEventListener('click', () => navigate('home'));

document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    const locale = button.dataset.locale as Locale | undefined;
    if (locale !== 'ko' && locale !== 'ja' && locale !== 'en') return;
    setLocale(locale);
    applyTranslations();
    renderHomeTab();
    renderProfile();
    if (route === 'tutorial') renderTutorial();
    game.refreshLocale();
  });
});

game.attachBoard(boardEl);
game.subscribe(renderGame);
game.init();
applyTranslations();
renderHomeTab();
renderProfile();
renderGame();
nativeAdBridge?.setHomeVisible(true);

window.addEventListener('resize', () => game.refreshBoardLayout());
window.visualViewport?.addEventListener('resize', () => game.refreshBoardLayout());
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => game.refreshBoardLayout()).observe(document.querySelector('.game-board-wrap')!);
void initAppsInToss();
