import type { Coord, GameState, Move, Player } from '../core/types';
import { DEFAULT_CONFIG, type RuleConfig } from '../core/config';
import { goalCellsFor, initialState, legalMoves } from '../core/rules';
import { applyMove } from '../core/apply';
import { getResult, type WinReason, type GameResult } from '../core/result';
import { chooseMove } from '../ai/ai';
import { getBotBrain } from '../bot/brain';
import {
  type GameSettings,
  type AiDifficulty,
  type HumanColorChoice,
  type OpponentMode,
  AI_DIFFICULTY_PRESETS,
  opponentOf,
  resolveHumanSide,
} from '../game/settings';
import {
  OnlineClient,
  type OnlineMatchReason,
  type OpponentProfile,
  type PlayerProfile,
} from '../net/online';
import { GhostController, GhostStore, ghostFromFinishedGame, type GhostTape } from '../ghost';
import { exportGameMgn } from '../../bot/learning/gameRecord';
import { localizeMessage, playerLabel, reasonLabel as localizedReasonLabel, t } from '../i18n';
import { buildLegacyProfileClaim } from '../profile/legacyProfile';

const PLAYER_KO: Record<Player, string> = { BLACK: '흑', WHITE: '백' };
const REASON_KO: Record<WinReason, string> = {
  goal: '왕이 목적지에 도달',
  capture: '상대 왕을 잡음',
  surround: '상대 왕을 포위',
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
  onlineMatchKind: 'random' | 'friend' | null;
  onlineOpponent: OpponentProfile | null;
  ghostOpponent: { name: string; rating: number } | null;
  profile: PlayerProfile | null;
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
  private settings: GameSettings = { mode: 'ai', humanColor: 'BLACK', aiDifficulty: 'normal' };
  private humanSide: Player = 'BLACK';
  private aiSide: Player = 'WHITE';
  private onlineSide: Player | null = null;
  private states: GameState[] = [initialState(this.config)];
  private selected: Coord | null = null;
  private aiThinking = false;
  private onlineWaiting = false;
  private onlineMatchKind: 'random' | 'friend' | null = null;
  private onlineOpponent: OpponentProfile | null = null;
  private ghostTape: GhostTape | null = null;
  private ghost: GhostController | null = null;
  private ghostStore = new GhostStore();
  private profile: PlayerProfile | null = null;
  private legacyMigrationRequested = false;
  private onlineStatus = '';
  private onlineError = false;
  private listeners = new Set<Listener>();
  private boardEl: HTMLElement | null = null;
  private snapshot: GameSnapshot;
  private learningRecorded = false;
  private aiTurnId = 0;

  private online = new OnlineClient({
    onState: (state) => {
      this.states = [state];
      this.selected = null;
      this.onlineWaiting = false;
      this.notify();
    },
    onJoined: (roomId, side) => {
      this.onlineMatchKind = 'friend';
      this.onlineOpponent = null;
      this.onlineSide = side;
      this.onlineWaiting = side === 'BLACK';
      this.onlineStatus = `입장코드 ${roomId} — ${PLAYER_KO[side]}`;
      this.onlineError = false;
      this.notify();
    },
    onMatchFound: (_roomId, side, opponent) => {
      this.onlineSide = side;
      this.onlineWaiting = false;
      // 친구 방(CREATED/JOINED 이후)의 MATCH_FOUND면 친구 대전 라벨을 유지한다.
      if (this.onlineMatchKind !== 'friend') this.onlineMatchKind = 'random';
      this.onlineOpponent = opponent;
      this.onlineStatus = `${opponent.name} 님과 매칭됐어요 — ${PLAYER_KO[side]}`;
      this.onlineError = false;
      this.notify();
    },
    onMatchResult: (winner, reason) => {
      const reasonLabel: Record<OnlineMatchReason, string> = {
        ...REASON_KO,
        forfeit: '상대가 대국을 떠남',
      };
      this.onlineStatus = `${PLAYER_KO[winner]} 승리 · ${reasonLabel[reason]}`;
      this.onlineError = false;
      this.onlineWaiting = false;
      this.notify();
    },
    onProfile: (profile) => {
      this.profile = profile;
      if (profile.legacyMigrationComplete) {
        this.legacyMigrationRequested = true;
      } else if (!this.legacyMigrationRequested && this.online.connected) {
        this.legacyMigrationRequested = true;
        const legacyProfile = buildLegacyProfileClaim(this.ghostStore.profile(), profile);
        void this.online.migrateLegacyProfile(legacyProfile).catch(() => {
          this.legacyMigrationRequested = false;
        });
      }
      this.notify();
    },
    onOpponentLeft: () => {
      this.onlineWaiting = false;
      this.onlineStatus = '상대가 나갔습니다';
      this.notify();
    },
    onMatchmakingTimeout: () => this.fallbackRandomMatch(),
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
    let turnLabel = t('status.turn', { player: playerLabel(state.turn) });
    if (this.aiThinking) {
      const difficulty = t(`difficulty.${this.settings.aiDifficulty}`);
      turnLabel += ` — ${t('status.aiThinking', { difficulty })}`;
    } else if (this.isOnlineMode() && this.onlineWaiting) turnLabel += ` — ${t('status.waiting')}`;
    else if (this.isOnlineMode() && this.onlineSide && !this.isMyTurn(state)) turnLabel += ` — ${t('status.opponentTurn')}`;

    const resultLabel = result
      ? t('result.win', { player: playerLabel(result.winner), reason: localizedReasonLabel(result.reason) })
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
      onlineStatus: localizeMessage(this.onlineStatus),
      onlineError: this.onlineError,
      aiThinking: this.aiThinking,
      onlineWaiting: this.onlineWaiting,
      onlineMatchKind: this.onlineMatchKind,
      onlineOpponent: this.onlineOpponent,
      ghostOpponent: this.ghostTape
        ? { name: this.ghostTape.ownerName, rating: this.ghostTape.ownerRating }
        : null,
      profile: this.profile,
      canUndo: this.canUndo(),
      isMyTurn: this.isMyTurn(state),
      turnLabel,
      resultLabel,
      lastMgn,
    };
  }

  setMode(mode: OpponentMode) {
    if (this.settings.mode === mode) return;
    this.cancelAiTurn();
    if (mode !== 'ghost') {
      this.ghostTape = null;
      this.ghost = null;
    }
    this.settings.mode = mode;
    if (this.isOnlineMode()) {
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineMatchKind = null;
      this.onlineOpponent = null;
      this.onlineStatus = '입장코드를 생성하거나 코드를 입력해 참가하세요';
      this.onlineError = false;
    } else {
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineMatchKind = null;
      this.onlineOpponent = null;
      this.newGame();
    }
    this.notify();
  }

  refreshLocale() {
    this.notify();
  }

  setHumanColor(color: HumanColorChoice) {
    if (this.settings.humanColor === color) return;
    this.settings.humanColor = color;
    if (this.isAiMode()) this.newGame();
    else {
      this.applySidesFromSettings();
      this.notify();
    }
  }

  setAiDifficulty(difficulty: AiDifficulty) {
    if (this.settings.aiDifficulty === difficulty) return;
    this.settings.aiDifficulty = difficulty;
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
      this.cancelAiTurn();
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineMatchKind = null;
      this.onlineOpponent = null;
      this.onlineStatus = '대전이 종료됐어요';
      this.onlineError = false;
      this.states = [initialState(this.config)];
      this.selected = null;
      this.notify();
      return;
    }
    this.newGame();
  }

  async createRoom() {
    this.onlineMatchKind = 'friend';
    try {
      await this.online.createRoom();
    } catch {
      /* onError */
    }
  }

  async joinRoom(code: string) {
    this.onlineMatchKind = 'friend';
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

  async startRandomMatch() {
    if (!this.isOnlineMode()) this.setMode('online');
    this.onlineMatchKind = 'random';
    this.onlineOpponent = null;
    this.onlineSide = null;
    this.onlineWaiting = true;
    this.onlineStatus = '랜덤 상대를 찾는 중…';
    this.onlineError = false;
    this.states = [initialState(this.config)];
    this.selected = null;
    this.notify();
    try {
      await this.online.startMatchmaking();
    } catch {
      this.fallbackRandomMatch();
    }
  }

  private fallbackRandomMatch() {
    if (!this.isOnlineMode() || this.onlineMatchKind !== 'random' || !this.onlineWaiting) return;
    this.onlineStatus = '상대를 연결하는 중…';
    this.onlineError = false;
    this.notify();
    void this.online.startBotMatch().catch(() => {
      if (!this.isOnlineMode() || this.onlineMatchKind !== 'random' || !this.onlineWaiting) return;
      this.onlineWaiting = false;
      this.onlineStatus = '온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';
      this.onlineError = true;
      this.notify();
    });
  }

  cancelRandomMatch() {
    this.online.cancelMatchmaking();
    this.onlineWaiting = false;
    this.onlineStatus = '랜덤 매칭을 취소했어요';
    this.notify();
  }

  async refreshProfile() {
    try {
      await this.online.getProfile();
    } catch {
      /* 연결 오류는 온라인 상태 메시지로 표시 */
    }
  }

  async updateProfileName(name: string) {
    try {
      await this.online.updateProfile(name);
    } catch {
      /* 연결 오류는 온라인 상태 메시지로 표시 */
    }
  }

  init() {
    this.applySidesFromSettings();
    this.notify();
    this.maybeAiTurn();
    void this.refreshProfile();
  }

  destroy() {
    this.cancelAiTurn();
    this.online.disconnect();
    this.listeners.clear();
  }

  private current(): GameState {
    return this.states[this.states.length - 1];
  }

  private isAiMode() {
    return this.settings.mode === 'ai';
  }

  private isGhostMode() {
    return this.settings.mode === 'ghost' && this.ghostTape !== null;
  }

  private isComputerMode() {
    return this.isAiMode() || this.isGhostMode();
  }

  private isOnlineMode() {
    return this.settings.mode === 'online';
  }

  private isMyTurn(state: GameState): boolean {
    if (this.isComputerMode()) return state.turn === this.humanSide;
    if (this.isOnlineMode()) return this.onlineSide !== null && state.turn === this.onlineSide;
    return true;
  }

  private canUndo(): boolean {
    if (this.isOnlineMode() || this.isGhostMode()) return false;
    return this.states.length > 1;
  }

  private applySidesFromSettings() {
    if (this.isGhostMode() && this.ghostTape) {
      this.humanSide = opponentOf(this.ghostTape.side);
      this.aiSide = this.ghostTape.side;
      return;
    }
    this.humanSide = resolveHumanSide(this.settings.humanColor);
    this.aiSide = opponentOf(this.humanSide);
  }

  private newGame() {
    this.cancelAiTurn();
    this.applySidesFromSettings();
    this.states = [initialState(this.config)];
    this.selected = null;
    this.learningRecorded = false;
    this.notify();
    this.maybeAiTurn();
  }

  private recordLearningIfEnded() {
    try {
      const state = this.current();
      const result = getResult(state, this.config);
      if (!result || (!this.isAiMode() && !this.isGhostMode()) || this.learningRecorded) return;
      this.learningRecorded = true;
      if (this.isGhostMode() && this.ghostTape) {
        const ownerName = this.profile?.name ?? '플레이어';
        const ownerRating = this.profile?.rating ?? 1200;
        const tape = ghostFromFinishedGame(
          state,
          result,
          ownerName,
          ownerRating,
          this.humanSide,
          'local',
          '빠른 대전에서 남긴 고스트 기보',
        );
        this.ghostStore.recordMatch(result.winner === this.humanSide, this.ghostTape.ownerRating, tape);
        return;
      }
      getBotBrain(this.config).onGameEnd(
        { state, result, config: this.config, settings: this.settings, humanSide: this.humanSide },
        this.aiSide,
      );
    } catch {
      /* 학습 저장 실패가 대국을 막지 않도록 */
    }
  }

  /** 힌트 실패·예외 시에도 합법 수를 반환 */
  private cancelAiTurn() {
    this.aiTurnId++;
    this.aiThinking = false;
  }

  private pickAiMove(state: GameState, maxMs: number, maxDepth: number): Move | null {
    const preset = AI_DIFFICULTY_PRESETS[this.settings.aiDifficulty];
    const baseOpts = {
      maxMs,
      maxDepth,
      maxNodes: preset.maxNodes,
      elite: preset.elite ?? false,
      rng: preset.choiceWindow > 0 ? Math.random : undefined,
      rootNoise: preset.rootNoise ?? 0,
      choiceWindow: preset.choiceWindow,
      planStrength: preset.planStrength ?? 1,
      strategyLevel: preset.strategyLevel ?? 1,
    };
    try {
      const brain = getBotBrain(this.config);
      const hintScale = preset.hintScale ?? 1;
      const hints = brain.hintsFor(state, this.aiSide, hintScale);
      const move = chooseMove(state, this.config, { ...baseOpts, hints, botSide: this.aiSide });
      if (move) return move;
    } catch {
      /* 힌트·전략서 오류 시 순수 미니맥스로 폴백 */
    }
    try {
      const move = chooseMove(state, this.config, baseOpts);
      if (move) return move;
    } catch {
      /* ignore */
    }
    const legal = legalMoves(state, this.config);
    return legal[0] ?? null;
  }

  private maybeAiTurn() {
    const state = this.current();
    if (!this.isComputerMode() || this.aiThinking || state.turn !== this.aiSide || getResult(state, this.config)) {
      return;
    }
    this.aiThinking = true;
    const aiTurnId = ++this.aiTurnId;
    const preset = AI_DIFFICULTY_PRESETS[this.settings.aiDifficulty];
    this.notify();
    const wallDeadline = Date.now() + preset.maxMs + 500;
    window.setTimeout(() => {
      if (aiTurnId !== this.aiTurnId) return;
      try {
        const cur = this.current();
        if (!this.isComputerMode() || getResult(cur, this.config) || cur.turn !== this.aiSide) return;
        const budget = Math.max(
          100,
          Math.min(preset.maxMs, wallDeadline - Date.now()),
        );
        const move = this.isGhostMode()
          ? this.ghost?.choose(cur, this.config)?.move ?? legalMoves(cur, this.config)[0] ?? null
          : this.pickAiMove(cur, budget, preset.maxDepth);
        if (move) this.states.push(applyMove(this.current(), move));
        this.recordLearningIfEnded();
      } finally {
        if (aiTurnId !== this.aiTurnId) return;
        this.aiThinking = false;
        this.notify();
        const after = this.current();
        if (
          this.isComputerMode() &&
          !getResult(after, this.config) &&
          after.turn === this.aiSide &&
          legalMoves(after, this.config).length > 0
        ) {
          this.maybeAiTurn();
        }
      }
    }, 120);
  }

  private notify() {
    this.snapshot = this.buildSnapshot();
    this.renderBoard();
    for (const fn of this.listeners) fn();
  }

  // SwiftUI BoardView와 동일하게 7px 인셋을 두고 셀 사이 여백은 만들지 않는다.
  // 외곽선은 inset으로 그려져 레이아웃 폭을 차지하지 않는다.
  private static readonly BOARD_BORDER = 0;
  private static readonly BOARD_PADDING = 14;
  private static readonly BOARD_GAP = 0;

  /** 보드 테두리·패딩·칸 간격을 제외한 실제 사용 가능 영역 */
  private availableBoardBox(): { width: number; height: number } {
    const wrap = this.boardEl?.parentElement;
    if (wrap && wrap.clientWidth > 0) {
      const height = wrap.clientHeight > 48 ? wrap.clientHeight : Number.POSITIVE_INFINITY;
      return { width: wrap.clientWidth, height };
    }

    const vw = window.innerWidth;
    const isMobile = vw <= 720;
    const appPad = isMobile ? 24 : 48;
    const maxApp = isMobile ? 480 : vw;
    return {
      width: Math.max(0, Math.min(maxApp, vw) - appPad),
      height: Number.POSITIVE_INFINITY,
    };
  }

  private cellSizeFor(n: number): number {
    const box = this.availableBoardBox();
    const chrome =
      GameController.BOARD_BORDER +
      GameController.BOARD_PADDING +
      GameController.BOARD_GAP * (n - 1);
    const inner = Math.min(box.width, box.height) - chrome;
    return Math.max(24, Math.min(64, Math.floor(inner / n)));
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
          el.className = `piece ${piece.player.toLowerCase()}${piece.type === 'KING' ? ' king' : ''}`;
          el.setAttribute('role', 'img');
          const pieceKey = piece.type === 'KING'
            ? (piece.player === 'BLACK' ? 'piece.king.black' : 'piece.king.white')
            : (piece.player === 'BLACK' ? 'piece.guard.black' : 'piece.guard.white');
          el.setAttribute('aria-label', t(pieceKey));
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
