import './style.css';
import type { AiDifficulty, HumanColorChoice, OpponentMode } from './game/settings';
import { GameController, stoneHtml } from './ui/gameController';
import { getLocale, playerLabel, setLocale, t, type Locale } from './i18n';
import { initAppsInToss } from './ait';
import woodTextureUrl from '../assets/ui/board-light-ash.png';
import whiteGuardUrl from '../assets/ui/stone-white-guard.png';
import blackGuardUrl from '../assets/ui/stone-black-guard.png';
import blackKingUrl from '../assets/ui/stone-black-king.png';
import tutorialGoalUrl from '../assets/tutorial/tutorial-goal.jpg';
import tutorialPlaceUrl from '../assets/tutorial/tutorial-place.jpg';
import tutorialMoveUrl from '../assets/tutorial/tutorial-move.jpg';
import tutorialProtectUrl from '../assets/tutorial/tutorial-protect.jpg';

const game = new GameController();
const app = document.querySelector<HTMLDivElement>('#app')!;

const previewCells = Array.from({ length: 81 }, (_, index) => {
  const r = Math.floor(index / 9);
  const c = index % 9;
  const goalClass = (r === 0 || r === 8) && c >= 3 && c <= 5 ? ' preview-goal' : '';
  let piece = '';
  if (r === 0 && c === 4) {
    piece = `<img class="preview-piece preview-piece-white" src="${blackKingUrl}" alt="${t('piece.king.white')}" />`;
  } else if (r === 8 && c === 4) {
    piece = `<img class="preview-piece preview-piece-black" src="${blackKingUrl}" alt="${t('piece.king.black')}" />`;
  }
  return `<div class="preview-cell${goalClass}" aria-hidden="true">${piece}</div>`;
}).join('');

function guardTray(player: 'white' | 'black') {
  const src = player === 'white' ? whiteGuardUrl : blackGuardUrl;
  const playerName = player === 'white' ? t('piece.guard.white') : t('piece.guard.black');
  return `
    <div class="guard-tray guard-tray-${player}" aria-label="${playerName} 8개">
      ${Array.from({ length: 8 }, () => `<img src="${src}" alt="" />`).join('')}
    </div>`;
}

app.style.setProperty('--board-texture', `url("${woodTextureUrl}")`);
app.style.setProperty('--stone-white', `url("${whiteGuardUrl}")`);
app.style.setProperty('--stone-black', `url("${blackGuardUrl}")`);
app.style.setProperty('--king-white', `url("${blackKingUrl}")`);
app.style.setProperty('--king-black', `url("${blackKingUrl}")`);

app.innerHTML = `
  <main class="home-screen" id="home-screen">
    <header class="home-brand">
      <div>
        <h1 data-i18n="brand.title">몽진</h1>
        <p class="brand-subtitle" data-i18n="brand.subtitle">왕의 피난길</p>
      </div>
      <div class="home-brand-tools">
        <button class="profile-pill" id="profile-open" type="button" data-i18n-aria="profile.open" aria-label="내 프로필 열기">
          <span id="home-profile-name" data-i18n="profile.default">프로필</span>
          <small id="home-profile-rank" data-i18n="profile.loading">전적 불러오는 중</small>
        </button>
      </div>
    </header>

    <section class="home-actions" data-i18n-aria="home.actions" aria-label="게임 시작">
      <button class="menu-button menu-button-primary" id="quick-play" type="button">
        <i class="ph ph-play" aria-hidden="true"></i>
        <span><strong data-i18n="menu.random.title">랜덤 대전</strong><small data-i18n="menu.random.description">실시간 플레이어와 자동 매칭</small></span>
      </button>
      <button class="menu-button" id="computer-play" type="button">
        <i class="ph ph-desktop" aria-hidden="true"></i>
        <span><strong data-i18n="menu.ai.title">컴퓨터 대전</strong><small data-i18n="menu.ai.description">난이도와 진영 선택</small></span>
      </button>
      <button class="menu-button" id="online-play" type="button">
        <i class="ph ph-globe-hemisphere-east" aria-hidden="true"></i>
        <span><strong data-i18n="menu.friend.title">친구 대전</strong><small data-i18n="menu.friend.description">입장코드로 친구와 대국</small></span>
      </button>
      <div class="home-language-row">
        <div class="language-toggle" role="group" data-i18n-aria="language.selector">
          <button type="button" data-locale="ko" data-i18n="language.ko">한국어</button>
          <button type="button" data-locale="en" data-i18n="language.en">English</button>
          <button type="button" data-locale="ja" data-i18n="language.ja">日本語</button>
        </div>
      </div>
      <button class="menu-button menu-button-tutorial" id="tutorial-open" type="button">
        <i class="ph ph-book-open-text" aria-hidden="true"></i>
        <span><strong data-i18n="menu.tutorial.title">튜토리얼</strong><small data-i18n="menu.tutorial.description">4단계로 규칙 익히기</small></span>
      </button>
    </section>

    <section class="home-preview" data-i18n-aria="preview.aria" aria-label="몽진 초기 배치 미리보기">
      <div class="preview-board-shell">
        <div class="preview-board">${previewCells}</div>
      </div>
      <div class="preview-trays">
        ${guardTray('white')}
        ${guardTray('black')}
      </div>
      <p class="preview-caption"><span>9 × 9</span> <span data-i18n="preview.caption">왕을 호위해 상대 진영의 목적지까지 이동시키세요.</span></p>
    </section>
  </main>

  <main class="game-screen hidden" id="game-screen">
    <aside class="game-sidebar">
      <div class="game-sidebar-top">
        <button class="back-button" id="back-home" type="button">
          <i class="ph ph-arrow-left" aria-hidden="true"></i> <span data-i18n="game.back">홈으로</span>
        </button>
        <div class="game-brand">
          <h1 data-i18n="brand.title">몽진</h1>
          <p data-i18n="brand.subtitle">왕의 피난길</p>
        </div>
        <div class="game-top-tools">
          <div class="language-toggle" role="group" data-i18n-aria="language.selector">
            <button type="button" data-locale="ko" data-i18n="language.ko">한국어</button>
            <button type="button" data-locale="en" data-i18n="language.en">English</button>
            <button type="button" data-locale="ja" data-i18n="language.ja">日本語</button>
          </div>
          <div class="mode-chip" id="mode-chip">컴퓨터 대전</div>
        </div>
      </div>

      <section id="status" class="status-card" aria-live="polite"></section>

      <section id="ai-settings" class="settings-card">
        <label><span data-i18n="settings.aiDifficulty">봇 난이도</span>
          <select id="ai-difficulty">
            <option value="easy" data-i18n="difficulty.easy">쉬움</option>
            <option value="normal" selected data-i18n="difficulty.normal">보통</option>
            <option value="hard" data-i18n="difficulty.hard">어려움</option>
          </select>
        </label>
        <label><span data-i18n="settings.humanColor">내 색</span>
          <select id="human-color">
            <option value="BLACK" selected data-i18n="color.black.first">흑 · 선공</option>
            <option value="WHITE" data-i18n="color.white.second">백 · 후공</option>
            <option value="random" data-i18n="color.random">랜덤</option>
          </select>
        </label>
      </section>

      <section id="online-panel" class="online-panel hidden">
        <button class="secondary-button" id="create-room" type="button" data-i18n="online.create">입장코드 생성</button>
        <div id="room-code-display" class="room-code-display hidden">
          <strong id="room-code-value"></strong>
          <button class="text-button" id="copy-code" type="button" data-i18n="online.copy">복사</button>
        </div>
        <div class="online-join">
          <input id="room-code" type="text" maxlength="6" data-i18n-placeholder="online.code.placeholder" data-i18n-aria="online.code.aria" placeholder="6자리 코드" autocomplete="off" aria-label="입장코드" />
          <button class="secondary-button" id="join-room" type="button" data-i18n="online.join">참가</button>
        </div>
        <div id="online-status" class="online-status" aria-live="polite"></div>
      </section>

      <section id="random-panel" class="random-panel hidden">
        <div class="random-opponent" id="random-opponent" data-i18n="online.searching">상대를 찾고 있어요</div>
        <div id="random-status" class="online-status" aria-live="polite"></div>
        <button class="secondary-button" id="cancel-matchmaking" type="button" data-i18n="online.cancel">매칭 취소</button>
      </section>

      <div class="game-actions">
        <button class="secondary-button" id="undo" type="button"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> <span data-i18n="game.undo">무르기</span></button>
        <button class="secondary-button" id="reset" type="button"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> <span data-i18n="game.reset">새 게임</span></button>
      </div>

      <button class="rules-button" id="rules-open" type="button">
        <i class="ph ph-book-open-text" aria-hidden="true"></i> <span data-i18n="rules.open">규칙 다시 보기</span>
      </button>
    </aside>

    <section class="game-stage">
      <div class="live-board-wrap"><div id="board"></div></div>
    </section>
  </main>

  <dialog class="app-dialog setup-dialog" id="setup-dialog">
    <form method="dialog" class="dialog-card" id="setup-form">
      <div class="dialog-heading">
        <div><p class="eyebrow" data-i18n="setup.eyebrow">GAME SETUP</p><h2 data-i18n="setup.title">컴퓨터 대전</h2></div>
        <button class="icon-button" value="cancel" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <label><span data-i18n="setup.difficulty">난이도</span>
        <select id="setup-difficulty">
          <option value="easy" data-i18n="setup.easy.option">쉬움 · 기본 수와 즉시 전술을 익혀요</option>
          <option value="normal" selected data-i18n="setup.normal.option">보통 · 초보 전술과 기본 수비를 읽어요</option>
          <option value="hard" data-i18n="setup.hard.option">어려움 · 최대 4.3초 동안 최선 수를 깊게 읽어요</option>
        </select>
      </label>
      <label><span data-i18n="setup.side">내 진영</span>
        <select id="setup-color">
          <option value="BLACK" selected data-i18n="color.black.first">흑 · 선공</option>
          <option value="WHITE" data-i18n="color.white.second">백 · 후공</option>
          <option value="random" data-i18n="color.random">랜덤</option>
        </select>
      </label>
      <button class="dialog-primary" id="setup-start" value="default" type="button" data-i18n="setup.start">대국 시작</button>
      <button class="dialog-link" id="local-play" value="cancel" type="button" data-i18n="setup.local">한 기기에서 둘이 두기</button>
    </form>
  </dialog>

  <dialog class="app-dialog profile-dialog" id="profile-dialog">
    <section class="dialog-card" aria-labelledby="profile-title">
      <div class="dialog-heading">
        <div><p class="eyebrow" data-i18n="profile.eyebrow">PLAYER PROFILE</p><h2 id="profile-title" data-i18n="profile.title">내 프로필</h2></div>
        <button class="icon-button" id="profile-close" type="button" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <label><span data-i18n="profile.nickname">닉네임</span>
        <div class="profile-name-edit">
          <input id="profile-name" type="text" minlength="2" maxlength="12" autocomplete="nickname" data-i18n-placeholder="profile.placeholder" placeholder="2~12자" />
          <button class="secondary-button" id="profile-save" type="button" data-i18n="profile.save">저장</button>
        </div>
      </label>
      <div class="profile-rank-card">
        <span data-i18n="profile.rank">전체 순위</span>
        <strong id="profile-rank" data-i18n="profile.rankPlaceholder">-위</strong>
        <small id="profile-rating" data-i18n="profile.ratingPlaceholder">레이팅 -</small>
      </div>
      <div class="profile-stats" data-i18n-aria="profile.stats" aria-label="랜덤 대전 전적">
        <div><span data-i18n="profile.wins">승</span><strong id="profile-wins">0</strong></div>
        <div><span data-i18n="profile.losses">패</span><strong id="profile-losses">0</strong></div>
        <div><span data-i18n="profile.winRate">승률</span><strong id="profile-win-rate">0%</strong></div>
      </div>
      <p class="profile-note" data-i18n="profile.note">랜덤 대전 결과만 공식 전적에 반영돼요.</p>
      <div id="profile-status" class="online-status" aria-live="polite"></div>
    </section>
  </dialog>

  <dialog class="app-dialog tutorial-dialog" id="tutorial-dialog">
    <section class="dialog-card tutorial-card" aria-labelledby="tutorial-title">
      <div class="dialog-heading">
        <div><p class="eyebrow" data-i18n="tutorial.eyebrow">HOW TO PLAY</p><h2 id="tutorial-title" data-i18n="tutorial.title">왕을 피난시키세요</h2></div>
        <button class="icon-button" id="tutorial-close" type="button" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <div class="tutorial-visual" id="tutorial-visual"></div>
      <p class="tutorial-copy" id="tutorial-copy"></p>
      <div class="tutorial-progress" id="tutorial-progress" data-i18n-aria="tutorial.progress" aria-label="튜토리얼 진행 상태"></div>
      <div class="tutorial-actions">
        <button class="secondary-button" id="tutorial-prev" type="button" data-i18n="tutorial.previous">이전</button>
        <button class="dialog-primary" id="tutorial-next" type="button" data-i18n="tutorial.next">다음</button>
      </div>
    </section>
  </dialog>
`;

function applyTranslations() {
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (key) element.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((element) => {
    const key = element.dataset.i18nAria;
    if (key) element.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    if (key) element.placeholder = t(key);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
    button.classList.toggle('active', button.dataset.locale === locale);
    button.setAttribute('aria-pressed', String(button.dataset.locale === locale));
  });

  const whiteTray = document.querySelector<HTMLElement>('.guard-tray-white');
  const blackTray = document.querySelector<HTMLElement>('.guard-tray-black');
  const countSuffix = locale === 'ja' ? '個' : locale === 'en' ? '' : '개';
  whiteTray?.setAttribute('aria-label', `${t('piece.guard.white')} 8${countSuffix}`);
  blackTray?.setAttribute('aria-label', `${t('piece.guard.black')} 8${countSuffix}`);
  document.querySelector<HTMLImageElement>('.preview-piece-white')?.setAttribute('alt', t('piece.king.white'));
  document.querySelector<HTMLImageElement>('.preview-piece-black')?.setAttribute('alt', t('piece.king.black'));
}

applyTranslations();

const homeScreen = document.querySelector<HTMLElement>('#home-screen')!;
const gameScreen = document.querySelector<HTMLElement>('#game-screen')!;
const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const modeChipEl = document.querySelector<HTMLDivElement>('#mode-chip')!;
const aiSettingsEl = document.querySelector<HTMLElement>('#ai-settings')!;
const humanColorEl = document.querySelector<HTMLSelectElement>('#human-color')!;
const aiDifficultyEl = document.querySelector<HTMLSelectElement>('#ai-difficulty')!;
const onlinePanelEl = document.querySelector<HTMLElement>('#online-panel')!;
const randomPanelEl = document.querySelector<HTMLElement>('#random-panel')!;
const randomOpponentEl = document.querySelector<HTMLElement>('#random-opponent')!;
const randomStatusEl = document.querySelector<HTMLElement>('#random-status')!;
const onlineStatusEl = document.querySelector<HTMLDivElement>('#online-status')!;
const roomCodeEl = document.querySelector<HTMLInputElement>('#room-code')!;
const roomCodeDisplayEl = document.querySelector<HTMLDivElement>('#room-code-display')!;
const roomCodeValueEl = document.querySelector<HTMLElement>('#room-code-value')!;
const createRoomBtn = document.querySelector<HTMLButtonElement>('#create-room')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
const setupDialog = document.querySelector<HTMLDialogElement>('#setup-dialog')!;
const setupDifficultyEl = document.querySelector<HTMLSelectElement>('#setup-difficulty')!;
const setupColorEl = document.querySelector<HTMLSelectElement>('#setup-color')!;
const tutorialDialog = document.querySelector<HTMLDialogElement>('#tutorial-dialog')!;
const profileDialog = document.querySelector<HTMLDialogElement>('#profile-dialog')!;
const profileNameEl = document.querySelector<HTMLInputElement>('#profile-name')!;
const profileStatusEl = document.querySelector<HTMLElement>('#profile-status')!;
let pendingProfileName: string | null = null;

function modeLabel(mode: OpponentMode): string {
  return t(`mode.${mode}`);
}

function renderStatus() {
  const snap = game.getSnapshot();
  const { state, result, settings } = snap;
  const handRow = (player: 'BLACK' | 'WHITE') => `
    <div class="hand-row">
      <span class="hand-label"><b>${t('status.hand', { player: playerLabel(player) })}</b><span>${state.guardsInHand[player]} / 8</span></span>
      <span class="hand-stones">${stoneHtml(player, state.guardsInHand[player])}</span>
    </div>`;

  statusEl.innerHTML = result && snap.resultLabel
    ? `<div class="result-banner">${snap.resultLabel}</div>${handRow('BLACK')}${handRow('WHITE')}`
    : `<div class="turn-banner"><span class="turn-stone ${state.turn.toLowerCase()}"></span><span>${snap.turnLabel}</span></div>${handRow('BLACK')}${handRow('WHITE')}`;

  modeChipEl.textContent = settings.mode === 'online' && snap.onlineMatchKind === 'random'
    ? t('mode.random')
    : modeLabel(settings.mode);
  aiSettingsEl.classList.toggle('hidden', settings.mode !== 'ai');
  onlinePanelEl.classList.toggle('hidden', settings.mode !== 'online' || snap.onlineMatchKind === 'random');
  randomPanelEl.classList.toggle('hidden', settings.mode !== 'online' || snap.onlineMatchKind !== 'random');
  onlineStatusEl.textContent = snap.onlineStatus;
  onlineStatusEl.classList.toggle('error', snap.onlineError);
  randomStatusEl.textContent = snap.onlineStatus;
  randomStatusEl.classList.toggle('error', snap.onlineError);
  randomOpponentEl.textContent = snap.onlineOpponent
    ? t('online.opponent', { name: snap.onlineOpponent.name, rating: snap.onlineOpponent.rating })
    : t('online.searching');

  const showCode = settings.mode === 'online' && !!snap.onlineRoomId;
  roomCodeDisplayEl.classList.toggle('hidden', !showCode);
  createRoomBtn.classList.toggle('hidden', showCode);
  if (showCode && snap.onlineRoomId) roomCodeValueEl.textContent = snap.onlineRoomId;

  undoBtn.disabled = !snap.canUndo || snap.aiThinking;
  const profile = snap.profile;
  if (profile) {
    const locale = getLocale();
    const rankSuffix = locale === 'ja' ? '位' : locale === 'en' ? '' : '위';
    const rankPrefix = locale === 'en' ? '#' : '';
    document.querySelector<HTMLElement>('#home-profile-name')!.textContent = profile.name;
    document.querySelector<HTMLElement>('#home-profile-rank')!.textContent =
      `${rankPrefix}${profile.rank}${rankSuffix} · ${profile.wins}${t('profile.wins')} ${profile.losses}${t('profile.losses')}`;
    document.querySelector<HTMLElement>('#profile-rank')!.textContent = `${rankPrefix}${profile.rank}${rankSuffix}`;
    document.querySelector<HTMLElement>('#profile-rating')!.textContent =
      t('profile.rating', { rating: profile.rating, total: profile.totalPlayers });
    document.querySelector<HTMLElement>('#profile-wins')!.textContent = String(profile.wins);
    document.querySelector<HTMLElement>('#profile-losses')!.textContent = String(profile.losses);
    document.querySelector<HTMLElement>('#profile-win-rate')!.textContent = `${profile.winRate}%`;
    if (document.activeElement !== profileNameEl) profileNameEl.value = profile.name;
    if (pendingProfileName && profile.name === pendingProfileName) {
      pendingProfileName = null;
      profileStatusEl.textContent = t('profile.saved');
      profileStatusEl.classList.remove('error');
    }
  }
  if (pendingProfileName && snap.onlineError) {
    pendingProfileName = null;
    profileStatusEl.textContent = snap.onlineStatus;
    profileStatusEl.classList.add('error');
  }
  requestAnimationFrame(() => game.refreshBoardLayout());
}

function showGame() {
  homeScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.body.classList.add('playing');
  requestAnimationFrame(() => game.refreshBoardLayout());
}

function showHome() {
  const snap = game.getSnapshot();
  if (snap.settings.mode === 'online') game.reset();
  gameScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  document.body.classList.remove('playing');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startGame(mode: OpponentMode, difficulty?: AiDifficulty, color?: HumanColorChoice) {
  game.setMode(mode);
  if (difficulty) {
    aiDifficultyEl.value = difficulty;
    game.setAiDifficulty(difficulty);
  }
  if (color) {
    humanColorEl.value = color;
    game.setHumanColor(color);
  }
  game.reset();
  showGame();
}

document.querySelector('#quick-play')!.addEventListener('click', () => {
  startGame('online');
  void game.startRandomMatch();
});
document.querySelector('#computer-play')!.addEventListener('click', () => setupDialog.showModal());
document.querySelector('#online-play')!.addEventListener('click', () => startGame('online'));
document.querySelector('#back-home')!.addEventListener('click', showHome);

document.querySelector('#setup-start')!.addEventListener('click', () => {
  setupDialog.close();
  startGame('ai', setupDifficultyEl.value as AiDifficulty, setupColorEl.value as HumanColorChoice);
});
document.querySelector('#local-play')!.addEventListener('click', () => {
  setupDialog.close();
  startGame('local');
});

humanColorEl.addEventListener('change', () => game.setHumanColor(humanColorEl.value as HumanColorChoice));
aiDifficultyEl.addEventListener('change', () => game.setAiDifficulty(aiDifficultyEl.value as AiDifficulty));
undoBtn.addEventListener('click', () => game.undo());
document.querySelector('#reset')!.addEventListener('click', () => game.reset());
document.querySelector('#create-room')!.addEventListener('click', () => game.createRoom());
document.querySelector('#join-room')!.addEventListener('click', () => game.joinRoom(roomCodeEl.value));
document.querySelector('#copy-code')!.addEventListener('click', async () => {
  const code = roomCodeValueEl.textContent?.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    onlineStatusEl.textContent = t('clipboard.copied', { code });
    onlineStatusEl.classList.remove('error');
  } catch {
    onlineStatusEl.textContent = t('clipboard.manual');
    onlineStatusEl.classList.add('error');
  }
});
document.querySelector('#cancel-matchmaking')!.addEventListener('click', () => {
  game.cancelRandomMatch();
  showHome();
});

document.querySelector('#profile-open')!.addEventListener('click', () => {
  profileStatusEl.textContent = '';
  void game.refreshProfile();
  profileDialog.showModal();
});
document.querySelector('#profile-close')!.addEventListener('click', () => profileDialog.close());
document.querySelector('#profile-save')!.addEventListener('click', async () => {
  const name = profileNameEl.value.trim();
  if (name.length < 2 || name.length > 12) {
    profileStatusEl.textContent = t('profile.invalid');
    profileStatusEl.classList.add('error');
    return;
  }
  profileStatusEl.textContent = t('profile.saving');
  profileStatusEl.classList.remove('error');
  pendingProfileName = name;
  await game.updateProfileName(name);
});

const tutorialSteps = [
  {
    titleKey: 'tutorial.step1.title',
    copyKey: 'tutorial.step1.copy',
    image: tutorialGoalUrl,
    altKey: 'tutorial.step1.alt',
  },
  {
    titleKey: 'tutorial.step2.title',
    copyKey: 'tutorial.step2.copy',
    image: tutorialPlaceUrl,
    altKey: 'tutorial.step2.alt',
  },
  {
    titleKey: 'tutorial.step3.title',
    copyKey: 'tutorial.step3.copy',
    image: tutorialMoveUrl,
    altKey: 'tutorial.step3.alt',
  },
  {
    titleKey: 'tutorial.step4.title',
    copyKey: 'tutorial.step4.copy',
    image: tutorialProtectUrl,
    altKey: 'tutorial.step4.alt',
  },
] as const;

let tutorialStep = 0;
const tutorialTitle = document.querySelector<HTMLElement>('#tutorial-title')!;
const tutorialCopy = document.querySelector<HTMLElement>('#tutorial-copy')!;
const tutorialVisual = document.querySelector<HTMLElement>('#tutorial-visual')!;
const tutorialProgress = document.querySelector<HTMLElement>('#tutorial-progress')!;
const tutorialPrev = document.querySelector<HTMLButtonElement>('#tutorial-prev')!;
const tutorialNext = document.querySelector<HTMLButtonElement>('#tutorial-next')!;

document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach((button) => {
  button.addEventListener('click', () => {
    const locale = button.dataset.locale as Locale | undefined;
    if (locale !== 'ko' && locale !== 'ja' && locale !== 'en') return;
    setLocale(locale);
    applyTranslations();
    if (tutorialDialog.open) renderTutorial();
    game.refreshLocale();
  });
});

function renderTutorial() {
  const step = tutorialSteps[tutorialStep];
  tutorialTitle.textContent = t(step.titleKey);
  tutorialCopy.textContent = t(step.copyKey);
  tutorialVisual.innerHTML = `<img src="${step.image}" alt="${t(step.altKey)}" decoding="async" /><span aria-hidden="true">${tutorialStep + 1}</span>`;
  tutorialProgress.innerHTML = tutorialSteps.map((_, index) =>
    `<span class="${index === tutorialStep ? 'active' : ''}">${index + 1}</span>`,
  ).join('');
  tutorialPrev.disabled = tutorialStep === 0;
  tutorialNext.textContent = tutorialStep === tutorialSteps.length - 1 ? t('tutorial.startPractice') : t('tutorial.next');
}

function openTutorial() {
  tutorialStep = 0;
  renderTutorial();
  tutorialDialog.showModal();
}

document.querySelector('#tutorial-open')!.addEventListener('click', openTutorial);
document.querySelector('#rules-open')!.addEventListener('click', openTutorial);
document.querySelector('#tutorial-close')!.addEventListener('click', () => tutorialDialog.close());
tutorialPrev.addEventListener('click', () => {
  tutorialStep = Math.max(0, tutorialStep - 1);
  renderTutorial();
});
tutorialNext.addEventListener('click', () => {
  if (tutorialStep < tutorialSteps.length - 1) {
    tutorialStep += 1;
    renderTutorial();
  } else {
    tutorialDialog.close();
    startGame('ai', 'normal', 'BLACK');
  }
});

game.attachBoard(boardEl);
game.subscribe(renderStatus);
game.init();
renderStatus();
window.addEventListener('resize', () => game.refreshBoardLayout());
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => game.refreshBoardLayout()).observe(document.querySelector('.live-board-wrap')!);
}
initAppsInToss();
