import './style.css';
import type { AiDifficulty, HumanColorChoice, OpponentMode } from './game/settings';
import { GameController, PLAYER_KO, stoneHtml } from './ui/gameController';
import { initAppsInToss } from './ait';

const game = new GameController();

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="board-wrap">
    <h1>몽진<small>蒙塵 — 왕의 피난길</small></h1>
    <section class="play-mode-panel" aria-label="대전 설정">
      <label>대전 모드
        <select id="mode">
          <option value="ai" selected>컴퓨터 대전</option>
          <option value="local">같이 두기</option>
          <option value="online">온라인 대전</option>
        </select>
      </label>
      <label id="difficulty-row">봇 난이도
        <select id="ai-difficulty">
          <option value="normal">보통</option>
          <option value="hard" selected>어려움</option>
          <option value="expert">고수</option>
        </select>
      </label>
      <label id="color-row">내 색
        <select id="human-color">
          <option value="BLACK" selected>흑 (선공)</option>
          <option value="WHITE">백 (후공)</option>
          <option value="random">랜덤</option>
        </select>
      </label>
    </section>
    <div id="board"></div>
  </div>
  <div class="side">
    <div id="status" class="panel"></div>
    <div class="buttons">
      <button class="action" id="undo">↩ 무르기</button>
      <button class="action" id="reset">새 게임</button>
    </div>
    <div id="online-panel" class="panel online-panel hidden">
        <div class="online-actions">
          <button class="action" id="create-room" type="button">입장코드 생성</button>
        </div>
        <div id="room-code-display" class="room-code-display hidden">
          <span class="room-code-label">입장코드</span>
          <strong id="room-code-value"></strong>
          <button class="action subtle" id="copy-code" type="button">복사</button>
        </div>
        <div class="online-join">
          <input id="room-code" type="text" maxlength="6" placeholder="입장코드 6자리" autocomplete="off" />
          <button class="action" id="join-room" type="button">참가</button>
        </div>
        <p class="online-hint">같은 입장코드를 입력한 두 사람이 대전합니다</p>
        <div id="online-status" class="online-status"></div>
    </div>
    <details class="panel rules-note">
      <summary>규칙 요약</summary>
      · 매 턴 <b>호위 두기</b> 또는 <b>말 옮기기</b> 중 하나<br/>
      · 두기: 자기 말과 상하좌우로 붙은 빈 칸<br/>
      · 왕(王)은 8방향 1칸, 빈 칸으로만 이동 (잡기는 불가)<br/>
      · 호위는 상하좌우 1칸 — 상대 호위와 <b>상대 왕</b>을 잡을 수 있음<br/>
      · <b>왕이 잡히면 즉시 패배!</b> 왕은 호위와 함께 움직여야 안전<br/>
      · 호위는 양쪽 <b>목적지 칸에 들어갈 수 없음</b> (봉쇄 방지)<br/>
      · <b>승리</b>: 내 왕을 상대 진영의 빛나는 목적지 칸에 도달<br/>
      · 왕이 상하좌우로 포위되면 패배
    </details>
  </div>
`;

const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const modeEl = document.querySelector<HTMLSelectElement>('#mode')!;
const colorRowEl = document.querySelector<HTMLLabelElement>('#color-row')!;
const humanColorEl = document.querySelector<HTMLSelectElement>('#human-color')!;
const difficultyRowEl = document.querySelector<HTMLLabelElement>('#difficulty-row')!;
const aiDifficultyEl = document.querySelector<HTMLSelectElement>('#ai-difficulty')!;
const onlinePanelEl = document.querySelector<HTMLDivElement>('#online-panel')!;
const onlineStatusEl = document.querySelector<HTMLDivElement>('#online-status')!;
const roomCodeEl = document.querySelector<HTMLInputElement>('#room-code')!;
const roomCodeDisplayEl = document.querySelector<HTMLDivElement>('#room-code-display')!;
const roomCodeValueEl = document.querySelector<HTMLElement>('#room-code-value')!;
const boardWrapEl = document.querySelector<HTMLDivElement>('.board-wrap')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;

function renderStatus() {
  const snap = game.getSnapshot();
  const { state, result, settings } = snap;
  const handRow = (p: 'BLACK' | 'WHITE') => `
    <div class="hand-row">
      <span>${PLAYER_KO[p]} 호위 ${state.guardsInHand[p]} / 8</span>
      <span class="hand-stones">${stoneHtml(p, state.guardsInHand[p])}</span>
    </div>`;

  if (result && snap.resultLabel) {
    statusEl.innerHTML = `
      <div class="result-banner">${snap.resultLabel}</div>
      ${handRow('BLACK')}${handRow('WHITE')}
    `;
  } else {
    statusEl.innerHTML = `
      <div class="turn-banner"><span class="stone ${state.turn.toLowerCase()}"></span>${snap.turnLabel}</div>
      ${handRow('BLACK')}${handRow('WHITE')}
    `;
  }

  colorRowEl.classList.toggle('hidden', settings.mode !== 'ai');
  difficultyRowEl.classList.toggle('hidden', settings.mode !== 'ai');
  onlinePanelEl.classList.toggle('hidden', settings.mode !== 'online');
  onlineStatusEl.textContent = snap.onlineStatus;
  onlineStatusEl.classList.toggle('error', snap.onlineError);

  const showCode = settings.mode === 'online' && !!snap.onlineRoomId;
  roomCodeDisplayEl.classList.toggle('hidden', !showCode);
  if (showCode && snap.onlineRoomId) {
    roomCodeValueEl.textContent = snap.onlineRoomId;
    roomCodeEl.value = snap.onlineRoomId;
  }

  undoBtn.disabled = !snap.canUndo || snap.aiThinking;

  requestAnimationFrame(() => game.refreshBoardLayout());
}

game.attachBoard(boardEl);
game.subscribe(renderStatus);

modeEl.addEventListener('change', () => game.setMode(modeEl.value as OpponentMode));
humanColorEl.addEventListener('change', () => game.setHumanColor(humanColorEl.value as HumanColorChoice));
aiDifficultyEl.addEventListener('change', () => game.setAiDifficulty(aiDifficultyEl.value as AiDifficulty));
undoBtn.addEventListener('click', () => game.undo());
document.querySelector('#reset')!.addEventListener('click', () => game.reset());
document.querySelector('#create-room')!.addEventListener('click', () => game.createRoom());
document.querySelector('#join-room')!.addEventListener('click', () => {
  game.joinRoom(roomCodeEl.value);
});
document.querySelector('#copy-code')!.addEventListener('click', async () => {
  const code = roomCodeValueEl.textContent?.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    onlineStatusEl.textContent = `입장코드 ${code} 복사됨 — 친구에게 공유하세요`;
    onlineStatusEl.classList.remove('error');
  } catch {
    onlineStatusEl.textContent = '복사에 실패했습니다. 코드를 직접 선택해 복사해 주세요';
    onlineStatusEl.classList.add('error');
  }
});

game.init();
window.addEventListener('resize', () => game.refreshBoardLayout());
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => game.refreshBoardLayout()).observe(boardWrapEl);
}
initAppsInToss();
