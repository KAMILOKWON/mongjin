import type { Coord, GameState, Move, Player } from '../core/types';
import { DEFAULT_CONFIG, type RuleConfig } from '../core/config';
import { goalCellsFor, initialState, legalMoves } from '../core/rules';
import { applyMove } from '../core/apply';
import { getResult, type WinReason, type GameResult } from '../core/result';
import { chooseMove, DEFAULT_AI_OPTIONS } from '../ai/ai';
import { getBotBrain } from '../bot/brain';
import {
  type GameSettings,
  type HumanColorChoice,
  type OpponentMode,
  opponentOf,
  resolveHumanSide,
} from '../game/settings';
import { OnlineClient } from '../net/online';
import { exportGameMgn } from '../../bot/learning/gameRecord';

const PLAYER_KO: Record<Player, string> = { BLACK: '흑', WHITE: '백' };
const REASON_KO: Record<WinReason, string> = {
  goal: '왕이 목적지에 도달',
  capture: '상대 왕을 잡음',
  surround: '상대 왕을 포위',
  repetition: '상대가 동형 국면 3회 반복',
  'no-moves': '상대가 둘 수 없음',
};

export interface GameSnapshot {
  state: GameState;
  result: GameResult | null;
  settings: GameSettings;
  humanSide: Player;
  onlineSide: Player | null;
  onlineRoomId: string | null;
  onlineStatus: string;
  onlineError: boolean;
  aiThinking: boolean;
  onlineWaiting: boolean;
  canUndo: boolean;
  isMyTurn: boolean;
  turnLabel: string;
  resultLabel: string | null;
  /** 대국 종료 시 MGN 기보 텍스트 (학습·저장용) */
  lastMgn: string | null;
}

type Listener = () => void;

export class GameController {
  private config: RuleConfig = { ...DEFAULT_CONFIG };
  private settings: GameSettings = { mode: 'ai', humanColor: 'BLACK' };
  private humanSide: Player = 'BLACK';
  private aiSide: Player = 'WHITE';
  private onlineSide: Player | null = null;
  private states: GameState[] = [initialState(this.config)];
  private selected: Coord | null = null;
  private aiThinking = false;
  private onlineWaiting = false;
  private onlineStatus = '';
  private onlineError = false;
  private listeners = new Set<Listener>();
  private boardEl: HTMLElement | null = null;
  private snapshot: GameSnapshot;
  private learningRecorded = false;

  private online = new OnlineClient({
    onState: (state) => {
      this.states = [state];
      this.selected = null;
      this.onlineWaiting = false;
      this.notify();
    },
    onJoined: (roomId, side) => {
      this.onlineSide = side;
      this.onlineWaiting = side === 'BLACK';
      this.onlineStatus = `입장코드 ${roomId} — ${PLAYER_KO[side]}`;
      this.onlineError = false;
      this.notify();
    },
    onOpponentLeft: () => {
      this.onlineWaiting = false;
      this.onlineStatus = '상대가 나갔습니다';
      this.notify();
    },
    onError: (msg) => {
      this.onlineStatus = msg;
      this.onlineError = true;
      this.notify();
    },
    onStatus: (msg) => {
      this.onlineStatus = msg;
      this.onlineError = false;
      this.notify();
    },
  });

  constructor() {
    this.snapshot = this.buildSnapshot();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attachBoard(el: HTMLElement) {
    this.boardEl = el;
    this.renderBoard();
  }

  /** 보드 DOM은 유지하고 크기만 다시 그린다 */
  refreshBoardLayout() {
    if (this.boardEl) this.renderBoard();
  }

  getSnapshot(): GameSnapshot {
    return this.snapshot;
  }

  private buildSnapshot(): GameSnapshot {
    const state = this.current();
    const result = getResult(state, this.config);
    let turnLabel = `${PLAYER_KO[state.turn]} 차례`;
    if (this.aiThinking) turnLabel += ' — 컴퓨터 생각 중…';
    else if (this.isOnlineMode() && this.onlineWaiting) turnLabel += ' — 상대 대기 중…';
    else if (this.isOnlineMode() && this.onlineSide && !this.isMyTurn(state)) turnLabel += ' — 상대 차례';

    const resultLabel = result
      ? `${PLAYER_KO[result.winner]} 승리! — ${REASON_KO[result.reason]}`
      : null;

    let lastMgn: string | null = null;
    if (result) {
      lastMgn = exportGameMgn({
        state,
        result,
        config: this.config,
        settings: this.settings,
        humanSide: this.humanSide,
      }).mgn;
    }

    return {
      state,
      result,
      settings: { ...this.settings },
      humanSide: this.humanSide,
      onlineSide: this.onlineSide,
      onlineRoomId: this.online.currentRoomId,
      onlineStatus: this.onlineStatus,
      onlineError: this.onlineError,
      aiThinking: this.aiThinking,
      onlineWaiting: this.onlineWaiting,
      canUndo: this.canUndo(),
      isMyTurn: this.isMyTurn(state),
      turnLabel,
      resultLabel,
      lastMgn,
    };
  }

  setMode(mode: OpponentMode) {
    this.settings.mode = mode;
    if (this.isOnlineMode()) {
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineStatus = '입장코드를 생성하거나 코드를 입력해 참가하세요';
      this.onlineError = false;
    } else {
      this.online.disconnect();
      this.onlineSide = null;
      this.applySidesFromSettings();
      this.newGame();
    }
    this.notify();
  }

  setHumanColor(color: HumanColorChoice) {
    this.settings.humanColor = color;
    this.applySidesFromSettings();
    if (this.isAiMode()) this.newGame();
    else this.notify();
  }

  undo() {
    if (this.aiThinking || !this.canUndo()) return;
    this.states.pop();
    if (this.isAiMode() && this.states.length > 1 && this.current().turn !== this.humanSide) {
      this.states.pop();
    }
    this.selected = null;
    this.notify();
  }

  reset() {
    if (this.aiThinking) return;
    if (this.isOnlineMode()) {
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineStatus = '입장코드를 생성하거나 코드를 입력해 참가하세요';
      this.onlineError = false;
      this.states = [initialState(this.config)];
      this.selected = null;
      this.notify();
      return;
    }
    this.newGame();
  }

  async createRoom() {
    try {
      await this.online.createRoom();
    } catch {
      /* onError */
    }
  }

  async joinRoom(code: string) {
    if (!code.trim()) {
      this.onlineStatus = '입장코드를 입력하세요';
      this.onlineError = true;
      this.notify();
      return;
    }
    try {
      await this.online.joinRoom(code);
    } catch {
      /* onError */
    }
  }

  init() {
    this.applySidesFromSettings();
    this.notify();
    this.maybeAiTurn();
  }

  destroy() {
    this.online.disconnect();
    this.listeners.clear();
  }

  private current(): GameState {
    return this.states[this.states.length - 1];
  }

  private isAiMode() {
    return this.settings.mode === 'ai';
  }

  private isOnlineMode() {
    return this.settings.mode === 'online';
  }

  private isMyTurn(state: GameState): boolean {
    if (this.isAiMode()) return state.turn === this.humanSide;
    if (this.isOnlineMode()) return this.onlineSide !== null && state.turn === this.onlineSide;
    return true;
  }

  private canUndo(): boolean {
    if (this.isOnlineMode()) return false;
    return this.states.length > 1;
  }

  private applySidesFromSettings() {
    this.humanSide = resolveHumanSide(this.settings.humanColor);
    this.aiSide = opponentOf(this.humanSide);
  }

  private newGame() {
    this.applySidesFromSettings();
    this.states = [initialState(this.config)];
    this.selected = null;
    this.learningRecorded = false;
    this.notify();
    this.maybeAiTurn();
  }

  private recordLearningIfEnded() {
    const state = this.current();
    const result = getResult(state, this.config);
    if (!result || !this.isAiMode() || this.learningRecorded) return;
    this.learningRecorded = true;
    getBotBrain(this.config).onGameEnd(
      { state, result, config: this.config, settings: this.settings, humanSide: this.humanSide },
      this.aiSide,
    );
  }

  private maybeAiTurn() {
    const state = this.current();
    if (!this.isAiMode() || this.aiThinking || state.turn !== this.aiSide || getResult(state, this.config)) {
      return;
    }
    this.aiThinking = true;
    this.notify();
    setTimeout(() => {
      const cur = this.current();
      const brain = getBotBrain(this.config);
      const hints = brain.hintsFor(cur, this.aiSide);
      const move = chooseMove(cur, this.config, {
        ...DEFAULT_AI_OPTIONS,
        hints,
        botSide: this.aiSide,
      });
      this.aiThinking = false;
      if (move) this.states.push(applyMove(this.current(), move));
      this.recordLearningIfEnded();
      this.notify();
    }, 120);
  }

  private notify() {
    this.snapshot = this.buildSnapshot();
    this.renderBoard();
    for (const fn of this.listeners) fn();
  }

  private static readonly BOARD_BORDER = 12;
  private static readonly BOARD_PADDING = 12;
  private static readonly BOARD_GAP = 2;

  /** 보드 테두리·패딩·칸 간격을 제외한 실제 사용 가능 너비 */
  private availableBoardWidth(): number {
    const wrap = this.boardEl?.parentElement;
    if (wrap && wrap.clientWidth > 0) return wrap.clientWidth;

    const vw = window.innerWidth;
    const isMobile = vw <= 640;
    const appPad = isMobile ? 32 : 48;
    const maxApp = isMobile ? 480 : vw;
    return Math.max(0, Math.min(maxApp, vw) - appPad);
  }

  private cellSizeFor(n: number): number {
    const chrome =
      GameController.BOARD_BORDER +
      GameController.BOARD_PADDING +
      GameController.BOARD_GAP * (n - 1);
    const inner = this.availableBoardWidth() - chrome;
    return Math.max(24, Math.min(52, Math.floor(inner / n)));
  }

  private boardPixelWidth(n: number, cellSize: number): number {
    return (
      cellSize * n +
      GameController.BOARD_GAP * (n - 1) +
      GameController.BOARD_PADDING +
      GameController.BOARD_BORDER
    );
  }

  private lastMoveCells(state: GameState): Coord[] {
    const m = state.history[state.history.length - 1];
    if (!m) return [];
    return m.kind === 'PLACE' ? [m.to] : [m.from, m.to];
  }

  private onCellClick(
    r: number,
    c: number,
    moveTargets: Map<string, Move>,
    placeTargets: Map<string, Move>,
  ) {
    const state = this.current();
    if (getResult(state, this.config)) return;
    if (this.aiThinking || !this.isMyTurn(state)) return;

    const key = `${r},${c}`;
    const piece = state.board[r][c];
    let move: Move | undefined;

    if (this.selected) {
      move = moveTargets.get(key);
      if (move) {
        this.selected = null;
      } else if (piece && piece.player === state.turn && !(this.selected.r === r && this.selected.c === c)) {
        this.selected = { r, c };
        this.notify();
        return;
      } else {
        this.selected = null;
        this.notify();
        return;
      }
    } else if (piece && piece.player === state.turn) {
      this.selected = { r, c };
      this.notify();
      return;
    } else {
      move = placeTargets.get(key);
    }

    if (!move) return;

    if (this.isOnlineMode()) {
      this.online.sendMove(move);
      return;
    }

    this.states.push(applyMove(state, move));
    this.recordLearningIfEnded();
    this.notify();
    this.maybeAiTurn();
  }

  private renderBoard() {
    if (!this.boardEl) return;
    const state = this.current();
    const n = state.board.length;
    const result = getResult(state, this.config);
    const myTurn = this.isMyTurn(state);
    const moves = result || !myTurn ? [] : legalMoves(state, this.config);

    const moveTargets = new Map<string, Move>();
    const placeTargets = new Map<string, Move>();
    for (const m of moves) {
      if (m.kind === 'MOVE' && this.selected && m.from.r === this.selected.r && m.from.c === this.selected.c) {
        moveTargets.set(`${m.to.r},${m.to.c}`, m);
      }
      if (m.kind === 'PLACE') placeTargets.set(`${m.to.r},${m.to.c}`, m);
    }

    const goalBlack = new Set(goalCellsFor('BLACK', this.config).map((g) => `${g.r},${g.c}`));
    const goalWhite = new Set(goalCellsFor('WHITE', this.config).map((g) => `${g.r},${g.c}`));
    const last = new Set(this.lastMoveCells(state).map((c) => `${c.r},${c.c}`));

    const cellSize = this.cellSizeFor(n);
    const boardWidth = this.boardPixelWidth(n, cellSize);
    this.boardEl.style.gridTemplateColumns = `repeat(${n}, ${cellSize}px)`;
    this.boardEl.style.width = `${boardWidth}px`;
    this.boardEl.style.maxWidth = '100%';
    this.boardEl.style.setProperty('--cell-size', `${cellSize}px`);
    this.boardEl.innerHTML = '';

    const FILES = 'abcdefghijk';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const key = `${r},${c}`;
        const cell = document.createElement('button');
        cell.className = 'cell';
        cell.type = 'button';
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
        if (this.selected && this.selected.r === r && this.selected.c === c) cell.classList.add('selected');

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
        } else if (!this.selected && placeTargets.has(key)) {
          const dot = document.createElement('span');
          dot.className = 'place-dot';
          cell.appendChild(dot);
        }

        cell.addEventListener('click', () => this.onCellClick(r, c, moveTargets, placeTargets));
        this.boardEl.appendChild(cell);
      }
    }
  }
}

export function stoneHtml(player: Player, n: number): string {
  return Array.from({ length: n }, () => `<span class="stone ${player.toLowerCase()}"></span>`).join('');
}

export { PLAYER_KO, REASON_KO };
