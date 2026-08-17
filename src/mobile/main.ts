import './mobile.css';
import type { AiDifficulty, HumanColorChoice, OpponentMode } from '../game/settings';
import { GameController, stoneHtml } from '../ui/gameController';
import { getLocale, playerLabel, setLocale, t, type Locale } from '../i18n';
import { initAppsInToss } from '../ait';
import woodTextureUrl from '../../assets/ui/board-light-ash.png';
import whiteGuardUrl from '../../assets/ui/stone-white-guard.png';
import blackGuardUrl from '../../assets/ui/stone-black-guard.png';
import blackKingUrl from '../../assets/ui/stone-black-king.png';
import tutorialGoalUrl from '../../assets/tutorial/tutorial-goal.jpg';
import tutorialPlaceUrl from '../../assets/tutorial/tutorial-place.jpg';
import tutorialMoveUrl from '../../assets/tutorial/tutorial-move.jpg';
import tutorialProtectUrl from '../../assets/tutorial/tutorial-protect.jpg';

const game = new GameController();
const app = document.querySelector<HTMLDivElement>('#app')!;

app.className = 'm-app';
app.style.setProperty('--board-texture', `url("${woodTextureUrl}")`);
app.style.setProperty('--stone-white', `url("${whiteGuardUrl}")`);
app.style.setProperty('--stone-black', `url("${blackGuardUrl}")`);
app.style.setProperty('--king-white', `url("${blackKingUrl}")`);
app.style.setProperty('--king-black', `url("${blackKingUrl}")`);

app.innerHTML = `
  <section class="m-home" id="home-screen">
    <header class="m-home-top">
      <div>
        <h1 data-i18n="brand.title">몽진</h1>
        <p data-i18n="brand.subtitle">왕의 피난길</p>
      </div>
      <div class="m-home-tools">
        <div class="language-toggle" role="group" data-i18n-aria="language.selector">
          <button type="button" data-locale="ko" data-i18n="language.ko">한국어</button>
          <button type="button" data-locale="ja" data-i18n="language.ja">日本語</button>
        </div>
        <button class="m-profile" id="profile-open" type="button" data-i18n-aria="profile.open">
          <strong id="home-profile-name" data-i18n="profile.default">프로필</strong>
          <small id="home-profile-rank" data-i18n="profile.loading">전적 불러오는 중</small>
        </button>
      </div>
    </header>
    <div class="m-home-actions" data-i18n-aria="home.actions">
      <button class="m-cta m-cta-primary" id="quick-play" type="button">
        <i class="ph ph-play" aria-hidden="true"></i>
        <span><strong data-i18n="menu.random.title">랜덤 대전</strong><small data-i18n="menu.random.description">실시간 플레이어와 자동 매칭</small></span>
      </button>
      <button class="m-cta" id="computer-play" type="button">
        <i class="ph ph-desktop" aria-hidden="true"></i>
        <span><strong data-i18n="menu.ai.title">컴퓨터 대전</strong><small data-i18n="menu.ai.description">난이도와 진영 선택</small></span>
      </button>
      <button class="m-cta" id="online-play" type="button">
        <i class="ph ph-globe-hemisphere-east" aria-hidden="true"></i>
        <span><strong data-i18n="menu.friend.title">친구 대전</strong><small data-i18n="menu.friend.description">입장코드로 친구와 대국</small></span>
      </button>
      <button class="m-cta m-cta-quiet" id="tutorial-open" type="button">
        <i class="ph ph-book-open-text" aria-hidden="true"></i>
        <span><strong data-i18n="menu.tutorial.title">튜토리얼</strong><small data-i18n="menu.tutorial.description">4단계로 규칙 익히기</small></span>
      </button>
    </div>
    <p class="m-home-note"><b>9 × 9</b><span data-i18n="preview.caption">왕을 호위해 상대 진영의 목적지까지 이동시키세요.</span></p>
  </section>

  <section class="m-play hidden" id="game-screen">
    <header class="m-play-bar">
      <button class="m-text-btn" id="back-home" type="button">
        <i class="ph ph-arrow-left" aria-hidden="true"></i> <span data-i18n="game.back">홈으로</span>
      </button>
      <div class="m-mode" id="mode-chip">컴퓨터 대전</div>
      <button class="m-text-btn" id="rules-open" type="button" data-i18n-aria="rules.open" aria-label="규칙 다시 보기">
        <i class="ph ph-book-open-text" aria-hidden="true"></i>
      </button>
    </header>
    <div class="m-hud">
      <div id="status"></div>
      <div class="m-banner hidden" id="online-banner">
        <div class="m-code hidden" id="room-code-display">
          <strong id="room-code-value"></strong>
          <button class="m-text-btn" id="copy-code" type="button" data-i18n="online.copy">복사</button>
        </div>
        <span id="online-status"></span>
      </div>
    </div>
    <div class="m-board-wrap"><div id="board"></div></div>
    <div class="m-play-actions">
      <button class="m-btn" id="undo" type="button"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i><span data-i18n="game.undo">무르기</span></button>
      <button class="m-btn" id="reset" type="button"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i><span data-i18n="game.reset">새 게임</span></button>
    </div>
    <div class="m-overlay hidden" id="match-overlay">
      <p id="random-status" data-i18n="online.searching">상대를 찾고 있어요</p>
      <button class="m-btn" id="cancel-matchmaking" type="button" data-i18n="online.cancel">매칭 취소</button>
    </div>
  </section>

  <dialog class="m-sheet" id="setup-dialog">
    <form method="dialog" class="m-sheet-body" id="setup-form">
      <div class="m-sheet-head">
        <h2 data-i18n="setup.title">컴퓨터 대전</h2>
        <button class="m-icon-btn" value="cancel" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <label class="m-field"><span data-i18n="setup.difficulty">난이도</span>
        <div class="m-seg" id="setup-difficulty" role="radiogroup">
          <button type="button" role="radio" data-value="easy" data-i18n="difficulty.easy">쉬움</button>
          <button type="button" role="radio" data-value="normal" class="active" aria-checked="true" data-i18n="difficulty.normal">보통</button>
          <button type="button" role="radio" data-value="hard" data-i18n="difficulty.hard">어려움</button>
        </div>
      </label>
      <label class="m-field"><span data-i18n="setup.side">내 진영</span>
        <div class="m-seg" id="setup-color" role="radiogroup">
          <button type="button" role="radio" data-value="BLACK" class="active" aria-checked="true" data-i18n="color.black">흑</button>
          <button type="button" role="radio" data-value="WHITE" data-i18n="color.white">백</button>
          <button type="button" role="radio" data-value="random" data-i18n="color.random">랜덤</button>
        </div>
      </label>
      <button class="m-primary" id="setup-start" value="default" type="button" data-i18n="setup.start">대국 시작</button>
      <button class="m-text-btn" id="local-play" value="cancel" type="button" data-i18n="setup.local">한 기기에서 둘이 두기</button>
    </form>
  </dialog>

  <dialog class="m-sheet" id="friend-dialog">
    <section class="m-sheet-body">
      <div class="m-sheet-head">
        <h2 data-i18n="menu.friend.title">친구 대전</h2>
        <button class="m-icon-btn" id="friend-close" type="button" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <button class="m-primary" id="create-room" type="button" data-i18n="online.create">입장코드 생성</button>
      <p class="m-or" data-i18n="friend.or">또는</p>
      <div class="m-row">
        <input id="room-code" type="text" maxlength="6" autocomplete="off" autocapitalize="characters" inputmode="text" data-i18n-placeholder="online.code.placeholder" data-i18n-aria="online.code.aria" placeholder="6자리 코드" />
        <button class="m-btn" id="join-room" type="button" data-i18n="online.join">참가</button>
      </div>
      <p class="m-note" data-i18n="friend.shareHint">입장코드를 친구에게 공유하세요</p>
      <p class="m-status" id="friend-status"></p>
    </section>
  </dialog>

  <dialog class="m-sheet" id="profile-dialog">
    <section class="m-sheet-body">
      <div class="m-sheet-head">
        <h2 data-i18n="profile.title">내 프로필</h2>
        <button class="m-icon-btn" id="profile-close" type="button" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <label class="m-field"><span data-i18n="profile.nickname">닉네임</span>
        <div class="m-row">
          <input id="profile-name" type="text" minlength="2" maxlength="12" autocomplete="nickname" data-i18n-placeholder="profile.placeholder" placeholder="2~12자" />
          <button class="m-btn" id="profile-save" type="button" data-i18n="profile.save">저장</button>
        </div>
      </label>
      <div class="m-rank">
        <div>
          <span data-i18n="profile.rank">전체 순위</span>
          <small id="profile-rating" data-i18n="profile.ratingPlaceholder">레이팅 -</small>
        </div>
        <strong id="profile-rank" data-i18n="profile.rankPlaceholder">-위</strong>
      </div>
      <div class="m-stats" data-i18n-aria="profile.stats">
        <div><span data-i18n="profile.wins">승</span><strong id="profile-wins">0</strong></div>
        <div><span data-i18n="profile.losses">패</span><strong id="profile-losses">0</strong></div>
        <div><span data-i18n="profile.winRate">승률</span><strong id="profile-win-rate">0%</strong></div>
      </div>
      <p class="m-note" data-i18n="profile.note">랜덤 대전 결과만 공식 전적에 반영돼요.</p>
      <p class="m-status" id="profile-status"></p>
    </section>
  </dialog>

  <dialog class="m-sheet" id="tutorial-dialog">
    <section class="m-sheet-body">
      <div class="m-sheet-head">
        <h2 id="tutorial-title" data-i18n="tutorial.title">왕을 피난시키세요</h2>
        <button class="m-icon-btn" id="tutorial-close" type="button" data-i18n-aria="dialog.close" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <div class="m-tutorial-visual" id="tutorial-visual"></div>
      <p class="m-tutorial-copy" id="tutorial-copy"></p>
      <div class="m-progress" id="tutorial-progress" data-i18n-aria="tutorial.progress"></div>
      <div class="m-tutorial-actions">
        <button class="m-btn" id="tutorial-prev" type="button" data-i18n="tutorial.previous">이전</button>
        <button class="m-primary" id="tutorial-next" type="button" data-i18n="tutorial.next">다음</button>
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
}

applyTranslations();

const homeScreen = document.querySelector<HTMLElement>('#home-screen')!;
const gameScreen = document.querySelector<HTMLElement>('#game-screen')!;
const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const modeChipEl = document.querySelector<HTMLDivElement>('#mode-chip')!;
const onlineBannerEl = document.querySelector<HTMLElement>('#online-banner')!;
const matchOverlayEl = document.querySelector<HTMLElement>('#match-overlay')!;
const friendStatusEl = document.querySelector<HTMLElement>('#friend-status')!;
const onlineStatusEl = document.querySelector<HTMLElement>('#online-status')!;
const randomStatusEl = document.querySelector<HTMLElement>('#random-status')!;
const roomCodeEl = document.querySelector<HTMLInputElement>('#room-code')!;
const roomCodeDisplayEl = document.querySelector<HTMLElement>('#room-code-display')!;
const roomCodeValueEl = document.querySelector<HTMLElement>('#room-code-value')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
const setupDialog = document.querySelector<HTMLDialogElement>('#setup-dialog')!;
const setupDifficultyEl = document.querySelector<HTMLElement>('#setup-difficulty')!;
const setupColorEl = document.querySelector<HTMLElement>('#setup-color')!;
const friendDialog = document.querySelector<HTMLDialogElement>('#friend-dialog')!;
const tutorialDialog = document.querySelector<HTMLDialogElement>('#tutorial-dialog')!;
const profileDialog = document.querySelector<HTMLDialogElement>('#profile-dialog')!;
const profileNameEl = document.querySelector<HTMLInputElement>('#profile-name')!;
const profileStatusEl = document.querySelector<HTMLElement>('#profile-status')!;
let pendingProfileName: string | null = null;

function segValue(group: HTMLElement): string {
  return group.querySelector<HTMLElement>('button.active')?.dataset.value ?? '';
}

function bindSeg(group: HTMLElement) {
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button || !group.contains(button)) return;
    event.preventDefault();
    group.querySelectorAll('button').forEach((item) => {
      const on = item === button;
      item.classList.toggle('active', on);
      item.setAttribute('aria-checked', String(on));
    });
  });
}

bindSeg(setupDifficultyEl);
bindSeg(setupColorEl);

function renderStatus() {
  const snap = game.getSnapshot();
  const { state, result, settings } = snap;
  const turnClass = result ? 'm-turn is-result' : 'm-turn';
  const headline = result && snap.resultLabel
    ? snap.resultLabel
    : snap.turnLabel;
  const stone = result ? '' : `<span class="turn-stone ${state.turn.toLowerCase()}"></span>`;
  const hand = (player: 'BLACK' | 'WHITE') => `
    <div class="m-hand">
      <b>${playerLabel(player)} ${state.guardsInHand[player]}</b>
      <span class="hand-stones">${stoneHtml(player, state.guardsInHand[player])}</span>
    </div>`;

  statusEl.innerHTML = `<div class="${turnClass}">${stone}<span>${headline}</span></div><div class="m-hands">${hand('BLACK')}${hand('WHITE')}</div>`;

  modeChipEl.textContent = settings.mode === 'online' && snap.onlineMatchKind === 'random'
    ? t('mode.random')
    : t(`mode.${settings.mode}`);

  const randomWaiting = settings.mode === 'online'
    && snap.onlineMatchKind === 'random'
    && (snap.onlineWaiting || !snap.onlineSide);
  matchOverlayEl.classList.toggle('hidden', !randomWaiting);
  onlineBannerEl.classList.toggle('hidden', settings.mode !== 'online' || randomWaiting);
  onlineBannerEl.classList.toggle('error', snap.onlineError);
  onlineStatusEl.textContent = snap.onlineStatus;
  randomStatusEl.textContent = snap.onlineStatus || t('online.searching');
  friendStatusEl.textContent = friendDialog.open ? snap.onlineStatus : friendStatusEl.textContent;
  friendStatusEl.classList.toggle('error', snap.onlineError && friendDialog.open);

  const showCode = settings.mode === 'online' && !!snap.onlineRoomId && snap.onlineMatchKind !== 'random';
  roomCodeDisplayEl.classList.toggle('hidden', !showCode);
  if (showCode && snap.onlineRoomId) roomCodeValueEl.textContent = snap.onlineRoomId;

  undoBtn.disabled = !snap.canUndo || snap.aiThinking;

  const profile = snap.profile;
  if (profile) {
    document.querySelector<HTMLElement>('#home-profile-name')!.textContent = profile.name;
    document.querySelector<HTMLElement>('#home-profile-rank')!.textContent =
      `${profile.rank}${getLocale() === 'ja' ? '位' : '위'} · ${profile.wins}${t('profile.wins')} ${profile.losses}${t('profile.losses')}`;
    document.querySelector<HTMLElement>('#profile-rank')!.textContent = `${profile.rank}${getLocale() === 'ja' ? '位' : '위'}`;
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
  requestAnimationFrame(() => game.refreshBoardLayout());
}

function showHome() {
  const snap = game.getSnapshot();
  if (snap.settings.mode === 'online') game.reset();
  gameScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
}

function startGame(mode: OpponentMode, difficulty?: AiDifficulty, color?: HumanColorChoice) {
  game.setMode(mode);
  if (difficulty) game.setAiDifficulty(difficulty);
  if (color) game.setHumanColor(color);
  game.reset();
  showGame();
}

document.querySelector('#quick-play')!.addEventListener('click', () => {
  startGame('online');
  void game.startRandomMatch();
});
document.querySelector('#computer-play')!.addEventListener('click', () => setupDialog.showModal());
document.querySelector('#online-play')!.addEventListener('click', () => {
  friendStatusEl.textContent = '';
  friendStatusEl.classList.remove('error');
  roomCodeEl.value = '';
  friendDialog.showModal();
});
document.querySelector('#back-home')!.addEventListener('click', showHome);

document.querySelector('#setup-start')!.addEventListener('click', () => {
  setupDialog.close();
  startGame(
    'ai',
    segValue(setupDifficultyEl) as AiDifficulty,
    segValue(setupColorEl) as HumanColorChoice,
  );
});
document.querySelector('#local-play')!.addEventListener('click', () => {
  setupDialog.close();
  startGame('local');
});

undoBtn.addEventListener('click', () => game.undo());
document.querySelector('#reset')!.addEventListener('click', () => game.reset());
document.querySelector('#create-room')!.addEventListener('click', () => {
  friendDialog.close();
  startGame('online');
  void game.createRoom();
});
document.querySelector('#join-room')!.addEventListener('click', () => {
  if (!roomCodeEl.value.trim()) {
    friendStatusEl.textContent = t('online.noCode');
    friendStatusEl.classList.add('error');
    return;
  }
  friendDialog.close();
  startGame('online');
  void game.joinRoom(roomCodeEl.value);
});
document.querySelector('#friend-close')!.addEventListener('click', () => friendDialog.close());
document.querySelector('#copy-code')!.addEventListener('click', async () => {
  const code = roomCodeValueEl.textContent?.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    onlineStatusEl.textContent = t('clipboard.copied', { code });
    onlineBannerEl.classList.remove('error');
  } catch {
    onlineStatusEl.textContent = t('clipboard.manual');
    onlineBannerEl.classList.add('error');
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
  { titleKey: 'tutorial.step1.title', copyKey: 'tutorial.step1.copy', image: tutorialGoalUrl, altKey: 'tutorial.step1.alt' },
  { titleKey: 'tutorial.step2.title', copyKey: 'tutorial.step2.copy', image: tutorialPlaceUrl, altKey: 'tutorial.step2.alt' },
  { titleKey: 'tutorial.step3.title', copyKey: 'tutorial.step3.copy', image: tutorialMoveUrl, altKey: 'tutorial.step3.alt' },
  { titleKey: 'tutorial.step4.title', copyKey: 'tutorial.step4.copy', image: tutorialProtectUrl, altKey: 'tutorial.step4.alt' },
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
    if (locale !== 'ko' && locale !== 'ja') return;
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
  tutorialVisual.innerHTML = `<img src="${step.image}" alt="${t(step.altKey)}" decoding="async" />`;
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
window.visualViewport?.addEventListener('resize', () => game.refreshBoardLayout());
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => game.refreshBoardLayout()).observe(document.querySelector('.m-board-wrap')!);
}
void initAppsInToss();
