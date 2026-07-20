import './style.css';
import type { AiDifficulty, HumanColorChoice, OpponentMode } from './game/settings';
import { GameController, PLAYER_KO, stoneHtml } from './ui/gameController';
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
    piece = `<img class="preview-piece preview-piece-white" src="${blackKingUrl}" alt="백 왕" />`;
  } else if (r === 8 && c === 4) {
    piece = `<img class="preview-piece preview-piece-black" src="${blackKingUrl}" alt="흑 왕" />`;
  }
  return `<div class="preview-cell${goalClass}" aria-hidden="true">${piece}</div>`;
}).join('');

function guardTray(player: 'white' | 'black', label: string) {
  const src = player === 'white' ? whiteGuardUrl : blackGuardUrl;
  return `
    <div class="guard-tray guard-tray-${player}" aria-label="${label} 호위 8개">
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
        <h1>몽진</h1>
        <p class="brand-subtitle">왕의 피난길</p>
      </div>
    </header>

    <section class="home-actions" aria-label="게임 시작">
      <button class="menu-button menu-button-primary" id="quick-play" type="button">
        <i class="ph ph-play" aria-hidden="true"></i>
        <span><strong>빠른 대국</strong><small>흑 · 어려움</small></span>
      </button>
      <button class="menu-button" id="computer-play" type="button">
        <i class="ph ph-desktop" aria-hidden="true"></i>
        <span><strong>컴퓨터 대전</strong><small>난이도와 진영 선택</small></span>
      </button>
      <button class="menu-button" id="online-play" type="button">
        <i class="ph ph-globe-hemisphere-east" aria-hidden="true"></i>
        <span><strong>온라인 대전</strong><small>입장코드로 친구와 대국</small></span>
      </button>
      <button class="menu-button menu-button-tutorial" id="tutorial-open" type="button">
        <i class="ph ph-book-open-text" aria-hidden="true"></i>
        <span><strong>튜토리얼</strong><small>4단계로 규칙 익히기</small></span>
      </button>
    </section>

    <section class="home-preview" aria-label="몽진 초기 배치 미리보기">
      <div class="preview-board-shell">
        <div class="preview-board">${previewCells}</div>
      </div>
      <div class="preview-trays">
        ${guardTray('white', '백')}
        ${guardTray('black', '흑')}
      </div>
      <p class="preview-caption"><span>9 × 9</span> 왕을 호위해 상대 진영의 목적지까지 이동시키세요.</p>
    </section>
  </main>

  <main class="game-screen hidden" id="game-screen">
    <aside class="game-sidebar">
      <div class="game-sidebar-top">
        <button class="back-button" id="back-home" type="button">
          <i class="ph ph-arrow-left" aria-hidden="true"></i> 홈으로
        </button>
        <div class="game-brand">
          <h1>몽진</h1>
          <p>왕의 피난길</p>
        </div>
        <div class="mode-chip" id="mode-chip">컴퓨터 대전</div>
      </div>

      <section id="status" class="status-card" aria-live="polite"></section>

      <section id="ai-settings" class="settings-card">
        <label>봇 난이도
          <select id="ai-difficulty">
            <option value="normal">보통</option>
            <option value="hard" selected>어려움</option>
            <option value="expert">고수</option>
            <option value="allMight">올마이트</option>
          </select>
        </label>
        <label>내 색
          <select id="human-color">
            <option value="BLACK" selected>흑 · 선공</option>
            <option value="WHITE">백 · 후공</option>
            <option value="random">랜덤</option>
          </select>
        </label>
      </section>

      <section id="online-panel" class="online-panel hidden">
        <button class="secondary-button" id="create-room" type="button">입장코드 생성</button>
        <div id="room-code-display" class="room-code-display hidden">
          <strong id="room-code-value"></strong>
          <button class="text-button" id="copy-code" type="button">복사</button>
        </div>
        <div class="online-join">
          <input id="room-code" type="text" maxlength="6" placeholder="6자리 코드" autocomplete="off" aria-label="입장코드" />
          <button class="secondary-button" id="join-room" type="button">참가</button>
        </div>
        <div id="online-status" class="online-status" aria-live="polite"></div>
      </section>

      <div class="game-actions">
        <button class="secondary-button" id="undo" type="button"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> 무르기</button>
        <button class="secondary-button" id="reset" type="button"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> 새 게임</button>
      </div>

      <button class="rules-button" id="rules-open" type="button">
        <i class="ph ph-book-open-text" aria-hidden="true"></i> 규칙 다시 보기
      </button>
    </aside>

    <section class="game-stage">
      <div class="live-board-wrap"><div id="board"></div></div>
    </section>
  </main>

  <dialog class="app-dialog setup-dialog" id="setup-dialog">
    <form method="dialog" class="dialog-card" id="setup-form">
      <div class="dialog-heading">
        <div><p class="eyebrow">GAME SETUP</p><h2>컴퓨터 대전</h2></div>
        <button class="icon-button" value="cancel" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <label>난이도
        <select id="setup-difficulty">
          <option value="normal">보통 · 빠르게 둬요</option>
          <option value="hard" selected>어려움 · 수비와 반격을 읽어요</option>
          <option value="expert">고수 · 깊게 탐색해 도전해요</option>
          <option value="allMight">올마이트 · 극한 탐색으로 도전해요</option>
        </select>
      </label>
      <label>내 진영
        <select id="setup-color">
          <option value="BLACK" selected>흑 · 선공</option>
          <option value="WHITE">백 · 후공</option>
          <option value="random">랜덤</option>
        </select>
      </label>
      <button class="dialog-primary" id="setup-start" value="default" type="button">대국 시작</button>
      <button class="dialog-link" id="local-play" value="cancel" type="button">한 기기에서 둘이 두기</button>
    </form>
  </dialog>

  <dialog class="app-dialog tutorial-dialog" id="tutorial-dialog">
    <section class="dialog-card tutorial-card" aria-labelledby="tutorial-title">
      <div class="dialog-heading">
        <div><p class="eyebrow">HOW TO PLAY</p><h2 id="tutorial-title">왕을 피난시키세요</h2></div>
        <button class="icon-button" id="tutorial-close" type="button" aria-label="닫기"><i class="ph ph-x" aria-hidden="true"></i></button>
      </div>
      <div class="tutorial-visual" id="tutorial-visual"></div>
      <p class="tutorial-copy" id="tutorial-copy"></p>
      <div class="tutorial-progress" id="tutorial-progress" aria-label="튜토리얼 진행 상태"></div>
      <div class="tutorial-actions">
        <button class="secondary-button" id="tutorial-prev" type="button">이전</button>
        <button class="dialog-primary" id="tutorial-next" type="button">다음</button>
      </div>
    </section>
  </dialog>
`;

const homeScreen = document.querySelector<HTMLElement>('#home-screen')!;
const gameScreen = document.querySelector<HTMLElement>('#game-screen')!;
const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const modeChipEl = document.querySelector<HTMLDivElement>('#mode-chip')!;
const aiSettingsEl = document.querySelector<HTMLElement>('#ai-settings')!;
const humanColorEl = document.querySelector<HTMLSelectElement>('#human-color')!;
const aiDifficultyEl = document.querySelector<HTMLSelectElement>('#ai-difficulty')!;
const onlinePanelEl = document.querySelector<HTMLElement>('#online-panel')!;
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

const modeLabels: Record<OpponentMode, string> = {
  ai: '컴퓨터 대전',
  local: '같이 두기',
  online: '온라인 대전',
};

function renderStatus() {
  const snap = game.getSnapshot();
  const { state, result, settings } = snap;
  const handRow = (player: 'BLACK' | 'WHITE') => `
    <div class="hand-row">
      <span class="hand-label"><b>${PLAYER_KO[player]}</b> 호위 <span>${state.guardsInHand[player]} / 8</span></span>
      <span class="hand-stones">${stoneHtml(player, state.guardsInHand[player])}</span>
    </div>`;

  statusEl.innerHTML = result && snap.resultLabel
    ? `<div class="result-banner">${snap.resultLabel}</div>${handRow('BLACK')}${handRow('WHITE')}`
    : `<div class="turn-banner"><span class="turn-stone ${state.turn.toLowerCase()}"></span><span>${snap.turnLabel}</span></div>${handRow('BLACK')}${handRow('WHITE')}`;

  modeChipEl.textContent = modeLabels[settings.mode];
  aiSettingsEl.classList.toggle('hidden', settings.mode !== 'ai');
  onlinePanelEl.classList.toggle('hidden', settings.mode !== 'online');
  onlineStatusEl.textContent = snap.onlineStatus;
  onlineStatusEl.classList.toggle('error', snap.onlineError);

  const showCode = settings.mode === 'online' && !!snap.onlineRoomId;
  roomCodeDisplayEl.classList.toggle('hidden', !showCode);
  createRoomBtn.classList.toggle('hidden', showCode);
  if (showCode && snap.onlineRoomId) roomCodeValueEl.textContent = snap.onlineRoomId;

  undoBtn.disabled = !snap.canUndo || snap.aiThinking;
  requestAnimationFrame(() => game.refreshBoardLayout());
}

function showGame() {
  homeScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.body.classList.add('playing');
  requestAnimationFrame(() => game.refreshBoardLayout());
}

function showHome() {
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

document.querySelector('#quick-play')!.addEventListener('click', () => startGame('ai', 'hard', 'BLACK'));
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
    onlineStatusEl.textContent = `입장코드 ${code} 복사됨 — 친구에게 공유하세요`;
    onlineStatusEl.classList.remove('error');
  } catch {
    onlineStatusEl.textContent = '코드를 직접 선택해 복사해 주세요';
    onlineStatusEl.classList.add('error');
  }
});

const tutorialSteps = [
  {
    title: '왕을 피난시키세요',
    copy: '내 왕을 상대 진영 끝줄의 가운데 세 칸 중 하나로 먼저 이동시키면 승리합니다.',
    image: tutorialGoalUrl,
    alt: '흑 왕이 상대편 끝줄의 가운데 목적지로 이동하는 경로',
  },
  {
    title: '호위를 배치하세요',
    copy: '매 턴 호위 하나를 내 말과 상하좌우로 맞닿은 빈 칸에 놓을 수 있습니다. 호위는 각 진영에 8개입니다.',
    image: tutorialPlaceUrl,
    alt: '왕과 호위에 상하좌우로 맞닿은 칸에 새 호위를 배치하는 모습',
  },
  {
    title: '두거나, 움직이세요',
    copy: '한 턴에는 호위를 새로 두거나 말 하나를 움직입니다. 왕은 8방향, 호위는 상하좌우로 한 칸 이동합니다.',
    image: tutorialMoveUrl,
    alt: '왕은 여덟 방향, 호위는 상하좌우 네 방향으로 움직이는 방법',
  },
  {
    title: '왕을 끝까지 지키세요',
    copy: '호위는 상대 호위와 왕을 잡을 수 있습니다. 왕이 잡히면 즉시 패배하므로 혼자 돌진하지 마세요.',
    image: tutorialProtectUrl,
    alt: '세 호위가 왕을 둘러싸고 상대 호위의 접근을 막는 모습',
  },
] as const;

let tutorialStep = 0;
const tutorialTitle = document.querySelector<HTMLElement>('#tutorial-title')!;
const tutorialCopy = document.querySelector<HTMLElement>('#tutorial-copy')!;
const tutorialVisual = document.querySelector<HTMLElement>('#tutorial-visual')!;
const tutorialProgress = document.querySelector<HTMLElement>('#tutorial-progress')!;
const tutorialPrev = document.querySelector<HTMLButtonElement>('#tutorial-prev')!;
const tutorialNext = document.querySelector<HTMLButtonElement>('#tutorial-next')!;

function renderTutorial() {
  const step = tutorialSteps[tutorialStep];
  tutorialTitle.textContent = step.title;
  tutorialCopy.textContent = step.copy;
  tutorialVisual.innerHTML = `<img src="${step.image}" alt="${step.alt}" decoding="async" /><span aria-hidden="true">${tutorialStep + 1}</span>`;
  tutorialProgress.innerHTML = tutorialSteps.map((_, index) =>
    `<span class="${index === tutorialStep ? 'active' : ''}">${index + 1}</span>`,
  ).join('');
  tutorialPrev.disabled = tutorialStep === 0;
  tutorialNext.textContent = tutorialStep === tutorialSteps.length - 1 ? '연습 대국 시작' : '다음';
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
