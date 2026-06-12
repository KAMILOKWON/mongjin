import './style.css';
import type { Coord, GameState, Move, Player } from './core/types';
import { DEFAULT_CONFIG, type RuleConfig } from './core/config';
import { goalCellsFor, initialState, legalMoves } from './core/rules';
import { applyMove } from './core/apply';
import { getResult, type WinReason } from './core/result';
import { chooseMove } from './ai/ai';

// 규칙은 플레이테스트를 거쳐 v0.3으로 확정 (DEFAULT_CONFIG)
const config: RuleConfig = { ...DEFAULT_CONFIG };
let states: GameState[] = [initialState(config)];
let selected: Coord | null = null;
let vsComputer = true; // 백을 컴퓨터가 둔다
let aiThinking = false;

const current = (): GameState => states[states.length - 1];

const PLAYER_KO: Record<Player, string> = { BLACK: '흑', WHITE: '백' };
const REASON_KO: Record<WinReason, string> = {
  goal: '왕이 목적지에 도달',
  capture: '상대 왕을 잡음',
  surround: '상대 왕을 포위',
  repetition: '상대가 동형 국면 3회 반복',
  'no-moves': '상대가 둘 수 없음',
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="board-wrap">
    <h1>몽진<small>蒙塵 — 왕의 피난길</small></h1>
    <div id="board"></div>
  </div>
  <div class="side">
    <div id="status" class="panel"></div>
    <div class="buttons">
      <button class="action" id="undo">↩ 무르기</button>
      <button class="action" id="reset">새 게임</button>
    </div>
    <div class="panel config">
      <label style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">상대
        <select id="mode">
          <option value="ai" selected>컴퓨터 (백)</option>
          <option value="human">사람 (2인 핫시트)</option>
        </select>
      </label>
    </div>
    <div class="panel rules-note">
      <b>규칙 요약</b><br/>
      · 매 턴 <b>호위 두기</b> 또는 <b>말 옮기기</b> 중 하나<br/>
      · 두기: 자기 말과 상하좌우로 붙은 빈 칸<br/>
      · 왕(王)은 8방향 1칸, 빈 칸으로만 이동 (잡기는 불가)<br/>
      · 호위는 상하좌우 1칸 — 상대 호위와 <b>상대 왕</b>을 잡을 수 있음<br/>
      · <b>왕이 잡히면 즉시 패배!</b> 왕은 호위와 함께 움직여야 안전<br/>
      · 호위는 양쪽 <b>목적지 칸에 들어갈 수 없음</b> (봉쇄 방지)<br/>
      · <b>승리</b>: 내 왕을 상대 진영의 빛나는 목적지 칸에 도달<br/>
      · 왕이 상하좌우로 포위되면 패배
    </div>
  </div>
`;

const boardEl = document.querySelector<HTMLDivElement>('#board')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;

document.querySelector('#undo')!.addEventListener('click', () => {
  if (aiThinking) return;
  // vs 컴퓨터 모드에서는 (컴퓨터 수 + 내 수) 한 쌍을 되돌려 항상 흑 차례로 맞춘다
  if (states.length > 1) states.pop();
  if (vsComputer && states.length > 1 && current().turn === 'WHITE') states.pop();
  selected = null;
  render();
});

document.querySelector('#reset')!.addEventListener('click', () => {
  if (aiThinking) return;
  newGame();
});

document.querySelector<HTMLSelectElement>('#mode')!.addEventListener('change', (e) => {
  vsComputer = (e.target as HTMLSelectElement).value === 'ai';
  maybeAiTurn(); // 모드를 켰을 때 백 차례면 즉시 컴퓨터가 둔다 (게임은 리셋하지 않음)
});

function maybeAiTurn() {
  const state = current();
  if (!vsComputer || aiThinking || state.turn !== 'WHITE' || getResult(state, config)) return;
  aiThinking = true;
  render();
  setTimeout(() => {
    const move = chooseMove(current(), config, { maxMs: 700 });
    aiThinking = false;
    if (move) states.push(applyMove(current(), move));
    render();
  }, 120); // "생각 중" 표시가 그려질 틈을 준다
}

function newGame() {
  states = [initialState(config)];
  selected = null;
  render();
}

function stoneHtml(player: Player, n: number): string {
  return Array.from({ length: n }, () => `<span class="stone ${player.toLowerCase()}"></span>`).join('');
}

function renderStatus(state: GameState) {
  const result = getResult(state, config);
  const handRow = (p: Player) => `
    <div class="hand-row">
      <span>${PLAYER_KO[p]} 호위 ${state.guardsInHand[p]} / ${config.guardCount}</span>
      <span class="hand-stones">${stoneHtml(p, state.guardsInHand[p])}</span>
    </div>`;

  if (result) {
    statusEl.innerHTML = `
      <div class="result-banner">${PLAYER_KO[result.winner]} 승리! — ${REASON_KO[result.reason]}</div>
      ${handRow('BLACK')}${handRow('WHITE')}
    `;
  } else {
    const thinking = aiThinking ? ' — 컴퓨터 생각 중…' : '';
    statusEl.innerHTML = `
      <div class="turn-banner"><span class="stone ${state.turn.toLowerCase()}"></span>${PLAYER_KO[state.turn]} 차례${thinking}</div>
      ${handRow('BLACK')}${handRow('WHITE')}
    `;
  }
}

function lastMoveCells(state: GameState): Coord[] {
  const m = state.history[state.history.length - 1];
  if (!m) return [];
  return m.kind === 'PLACE' ? [m.to] : [m.from, m.to];
}

function render() {
  const state = current();
  const n = state.board.length;
  const result = getResult(state, config);
  const moves = result ? [] : legalMoves(state, config);

  const moveTargets = new Map<string, Move>();
  const placeTargets = new Map<string, Move>();
  for (const m of moves) {
    if (m.kind === 'MOVE' && selected && m.from.r === selected.r && m.from.c === selected.c) {
      moveTargets.set(`${m.to.r},${m.to.c}`, m);
    }
    if (m.kind === 'PLACE') placeTargets.set(`${m.to.r},${m.to.c}`, m);
  }

  const goalBlack = new Set(goalCellsFor('BLACK', config).map((g) => `${g.r},${g.c}`));
  const goalWhite = new Set(goalCellsFor('WHITE', config).map((g) => `${g.r},${g.c}`));
  const last = new Set(lastMoveCells(state).map((c) => `${c.r},${c.c}`));

  const cellSize = Math.min(52, Math.floor(560 / n));
  boardEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  boardEl.style.setProperty('--cell-size', `${cellSize}px`);
  boardEl.innerHTML = '';

  const FILES = 'abcdefghijk';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const key = `${r},${c}`;
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.title = `${FILES[c]}${n - r}`;
      if (r === n - 1) {
        const f = document.createElement('span');
        f.className = 'coord coord-file';
        f.textContent = FILES[c];
        cell.appendChild(f);
      }
      if (c === 0) {
        const rk = document.createElement('span');
        rk.className = 'coord coord-rank';
        rk.textContent = String(n - r);
        cell.appendChild(rk);
      }
      if (goalBlack.has(key)) cell.classList.add('goal-black');
      if (goalWhite.has(key)) cell.classList.add('goal-white');
      if (last.has(key)) cell.classList.add('last-move');
      if (selected && selected.r === r && selected.c === c) cell.classList.add('selected');

      const piece = state.board[r][c];
      if (piece) {
        const el = document.createElement('span');
        el.className = `piece ${piece.player.toLowerCase()}`;
        el.textContent = piece.type === 'KING' ? '王' : '';
        cell.appendChild(el);
        if (moveTargets.has(key)) cell.classList.add('capture');
      } else if (moveTargets.has(key)) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        cell.appendChild(dot);
      } else if (!selected && placeTargets.has(key)) {
        const dot = document.createElement('span');
        dot.className = 'place-dot';
        cell.appendChild(dot);
      }

      cell.addEventListener('click', () => onCellClick(r, c, moveTargets, placeTargets));
      boardEl.appendChild(cell);
    }
  }

  renderStatus(state);
}

function onCellClick(
  r: number,
  c: number,
  moveTargets: Map<string, Move>,
  placeTargets: Map<string, Move>,
) {
  const state = current();
  if (getResult(state, config)) return;
  if (aiThinking || (vsComputer && state.turn === 'WHITE')) return;
  const key = `${r},${c}`;
  const piece = state.board[r][c];

  if (selected) {
    const target = moveTargets.get(key);
    if (target) {
      states.push(applyMove(state, target));
      selected = null;
    } else if (piece && piece.player === state.turn && !(selected.r === r && selected.c === c)) {
      selected = { r, c }; // 다른 내 말로 선택 변경
    } else {
      selected = null;
    }
  } else if (piece && piece.player === state.turn) {
    selected = { r, c };
  } else {
    const place = placeTargets.get(key);
    if (place) states.push(applyMove(state, place));
  }
  render();
  maybeAiTurn();
}

render();
