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
  hasIdentity,
  hasTossIdentity,
  type OnlineMatchReason,
  type OpponentProfile,
  type PlayerProfile,
} from '../net/online';
import { exportGameMgn } from '../../bot/learning/gameRecord';
import {
  BUILT_IN_GHOSTS,
  GhostController,
  withEphemeralGhostNickname,
} from '../../../../packages/game-data/src';

const PLAYER_KO: Record<Player, string> = { BLACK: '흑', WHITE: '백' };
const LAST_QUICK_MATCH_NAME_KEY = 'mongjin.ait.last-quick-name.v1';
const REASON_KO: Record<WinReason, string> = {
  goal: '왕이 목적지에 도달',
  capture: '상대 왕을 잡음',
  surround: '상대 왕을 포위',
  'no-moves': '상대가 둘 수 없음',
};

type ForcedResult = { winner: Player; reason: WinReason | 'timeout' };

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
  /** 서버가 세션을 무효화해 재로그인이 필요한 상태 */
  onlineLoggedOut: boolean;
  onlineMatchKind: 'random' | 'friend' | null;
  onlineOpponent: OpponentProfile | null;
  profile: PlayerProfile | null;
  canUndo: boolean;
  isMyTurn: boolean;
  turnLabel: string;
  resultLabel: string | null;
  /** 빠른 대전 수 제한 시각. 없으면 시계를 숨긴다 */
  moveDeadline: number | null;
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
  private onlineLoggedOut = false;
  private onlineMatchKind: 'random' | 'friend' | null = null;
  private onlineOpponent: OpponentProfile | null = null;
  private profile: PlayerProfile | null = null;
  private onlineStatus = '';
  private onlineError = false;
  private listeners = new Set<Listener>();
  private boardEl: HTMLElement | null = null;
  private snapshot: GameSnapshot;
  private learningRecorded = false;
  private aiTurnId = 0;
  private quickGhost: GhostController | null = null;
  private moveDeadline: number | null = null;
  private moveClockTimer: number | null = null;
  private moveClockToken = 0;
  private forcedResult: ForcedResult | null = null;
  private lastQuickMatchGhostName = (() => {
    try { return localStorage.getItem(LAST_QUICK_MATCH_NAME_KEY); }
    catch { return null; }
  })();

  private online = new OnlineClient({
    onState: (state) => {
      this.states = [state];
      this.selected = null;
      this.onlineWaiting = false;
      this.syncOnlineMoveClock(state);
      this.notify();
    },
    onJoined: (roomId, side) => {
      this.onlineMatchKind = 'friend';
      this.onlineOpponent = null;
      this.onlineSide = side;
      this.onlineWaiting = side === 'BLACK';
      this.onlineStatus = `입장코드 ${roomId} · ${PLAYER_KO[side]}`;
      this.onlineError = false;
      this.notify();
    },
    onMatchFound: (_roomId, side, opponent) => {
      this.onlineSide = side;
      this.onlineWaiting = false;
      // 입장코드(친구) 방의 MATCH_FOUND에서는 friend를 유지한다
      if (this.onlineMatchKind !== 'friend') this.onlineMatchKind = 'random';
      this.onlineOpponent = opponent;
      this.onlineStatus = opponent.isBot
        ? `${opponent.name}와 대국해요 · ${PLAYER_KO[side]}`
        : `${opponent.name} 님과 매칭됐어요 · ${PLAYER_KO[side]}`;
      this.onlineError = false;
      this.syncOnlineMoveClock(this.current(), side);
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
      this.onlineLoggedOut = false;
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
    onLoggedOut: (msg) => {
      this.onlineStatus = msg;
      this.onlineError = true;
      this.onlineLoggedOut = true;
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

  /** 게임 화면을 떠나면 보드 DOM 참조를 끊어 분리된 노드에 그리지 않는다 */
  detachBoard() {
    if (this.boardEl) {
      this.boardEl.innerHTML = '';
      this.boardEl = null;
    }
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
    const result = this.forcedResult ?? getResult(state, this.config);
    let turnLabel = `${PLAYER_KO[state.turn]} 차례`;
    if (this.aiThinking) {
      const difficulty = AI_DIFFICULTY_PRESETS[this.settings.aiDifficulty].label;
      turnLabel += ` · 컴퓨터(${difficulty}) 생각 중…`;
    }
    else if (this.isOnlineMode() && this.onlineWaiting) turnLabel += ' · 상대 대기 중…';
    else if (this.isOnlineMode() && this.onlineSide && !this.isMyTurn(state)) turnLabel += ' · 상대 차례';

    const resultLabel = result
      ? `${PLAYER_KO[result.winner]} 승리 · ${result.reason === 'timeout' ? '시간 초과' : REASON_KO[result.reason]}`
      : null;

    let lastMgn: string | null = null;
    const coreResult: GameResult | null = !result
      ? null
      : result.reason === 'timeout'
        ? { winner: result.winner, reason: 'no-moves' }
        : { winner: result.winner, reason: result.reason };
    if (coreResult) {
      lastMgn = exportGameMgn({
        state,
        result: coreResult,
        config: this.config,
        settings: this.settings,
        humanSide: this.humanSide,
      }).mgn;
    }

    return {
      state,
      result: coreResult,
      settings: { ...this.settings },
      humanSide: this.humanSide,
      onlineSide: this.onlineSide,
      onlineRoomId: this.online.currentRoomId,
      onlineStatus: this.onlineStatus,
      onlineError: this.onlineError,
      aiThinking: this.aiThinking,
      onlineWaiting: this.onlineWaiting,
      onlineLoggedOut: this.onlineLoggedOut,
      onlineMatchKind: this.onlineMatchKind,
      onlineOpponent: this.onlineOpponent,
      profile: this.profile,
      canUndo: this.canUndo(),
      isMyTurn: this.isMyTurn(state),
      turnLabel,
      resultLabel,
      moveDeadline: this.isQuickMatch() ? this.moveDeadline : null,
      lastMgn,
    };
  }

  setMode(mode: OpponentMode) {
    if (this.settings.mode === mode) return;
    this.cancelAiTurn();
    this.clearMoveClock();
    this.forcedResult = null;
    this.quickGhost = null;
    this.settings.mode = mode;
    if (this.isOnlineMode()) {
      this.online.disconnect();
      this.onlineSide = null;
      this.onlineMatchKind = null;
      this.onlineOpponent = null;
      this.onlineStatus = '';
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
    this.clearMoveClock();
    this.forcedResult = null;
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
    if (!this.isOnlineMode()) this.setMode('online');
    this.onlineMatchKind = 'friend';
    this.onlineOpponent = null;
    this.onlineSide = null;
    this.onlineWaiting = true;
    this.onlineStatus = '입장코드를 만드는 중…';
    this.onlineError = false;
    this.states = [initialState(this.config)];
    this.selected = null;
    this.notify();
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
    if (!this.isOnlineMode()) this.setMode('online');
    this.onlineMatchKind = 'friend';
    this.onlineOpponent = null;
    this.onlineSide = null;
    this.onlineWaiting = true;
    this.onlineStatus = '입장코드를 확인하는 중…';
    this.onlineError = false;
    this.states = [initialState(this.config)];
    this.selected = null;
    this.notify();
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
    if (this.onlineMatchKind !== 'random' || !this.onlineWaiting) return;
    const rating = this.profile?.rating ?? 1200;
    const baseTape = [...BUILT_IN_GHOSTS].sort(
      (a, b) => Math.abs(a.ownerRating - rating) - Math.abs(b.ownerRating - rating),
    )[0];
    if (!baseTape) return;
    const tape = withEphemeralGhostNickname(baseTape, {
      previousName: this.lastQuickMatchGhostName,
      playerName: this.profile?.name,
    });
    this.lastQuickMatchGhostName = tape.ownerName;
    try { localStorage.setItem(LAST_QUICK_MATCH_NAME_KEY, tape.ownerName); } catch { /* session fallback */ }
    this.online.cancelMatchmaking();
    this.online.disconnect();
    this.onlineSide = null;
    this.onlineWaiting = false;
    this.onlineOpponent = { name: tape.ownerName, rating: tape.ownerRating, isBot: true };
    this.onlineStatus = `${tape.ownerName} 님과 대국해요`;
    this.onlineError = false;
    this.quickGhost = new GhostController(tape);
    this.settings.mode = 'ai';
    this.settings.humanColor = opponentOf(tape.side);
    this.newGame();
    this.ensureMoveClock();
  }

  cancelRandomMatch() {
    this.online.cancelMatchmaking();
    this.onlineWaiting = false;
    this.onlineStatus = '랜덤 매칭을 취소했어요';
    this.notify();
  }

  /** 입장코드(친구) 방 대기를 취소하고 방을 닫는다 */
  cancelFriendRoom() {
    this.online.disconnect();
    this.onlineSide = null;
    this.onlineMatchKind = null;
    this.onlineOpponent = null;
    this.onlineWaiting = false;
    this.onlineStatus = '친구 대전을 취소했어요';
    this.onlineError = false;
    this.notify();
  }

  /** 로컬에 온라인 identity(로그인 세션)가 저장돼 있는지 */
  hasOnlineIdentity(): boolean {
    return hasIdentity();
  }

  /** 토스 로그인으로 발급된 세션인지 (앱인토스 랜덤 대전용) */
  hasTossIdentity(): boolean {
    return hasTossIdentity();
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

  init(options?: { fetchProfile?: boolean }) {
    this.applySidesFromSettings();
    this.notify();
    this.maybeAiTurn();
    if (options?.fetchProfile !== false) void this.refreshProfile();
  }

  destroy() {
    this.cancelAiTurn();
    this.clearMoveClock();
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

  private isQuickMatch() {
    return this.quickGhost !== null || this.onlineMatchKind === 'random' || this.onlineOpponent?.isBot === true;
  }

  private syncOnlineMoveClock(state: GameState, side = this.onlineSide) {
    if (this.onlineMatchKind !== 'random' || this.quickGhost) return;
    if (side && state.turn === side && !getResult(state, this.config)) {
      this.moveDeadline = Date.now() + 60_000;
    } else {
      this.moveDeadline = null;
    }
  }

  private ensureMoveClock() {
    if (!this.quickGhost) return;
    const state = this.current();
    if (this.forcedResult || getResult(state, this.config) || !this.isMyTurn(state) || this.aiThinking) {
      this.clearMoveClock();
      return;
    }
    if (this.moveDeadline && this.moveDeadline > Date.now()) return;
    this.startMoveClock();
  }

  private startMoveClock() {
    this.clearMoveClock();
    this.moveDeadline = Date.now() + 60_000;
    const token = ++this.moveClockToken;
    this.moveClockTimer = window.setTimeout(() => {
      if (token !== this.moveClockToken) return;
      this.finishAsTimeoutLoss();
    }, 60_000);
    this.notify();
  }

  private clearMoveClock() {
    this.moveClockToken += 1;
    if (this.moveClockTimer !== null) {
      window.clearTimeout(this.moveClockTimer);
      this.moveClockTimer = null;
    }
    this.moveDeadline = null;
  }

  private finishAsTimeoutLoss() {
    this.clearMoveClock();
    this.cancelAiTurn();
    this.selected = null;
    this.forcedResult = { winner: opponentOf(this.humanSide), reason: 'timeout' };
    this.notify();
  }

  private isMyTurn(state: GameState): boolean {
    if (this.isAiMode()) return state.turn === this.humanSide;
    if (this.isOnlineMode()) return this.onlineSide !== null && state.turn === this.onlineSide;
    return true;
  }

  private canUndo(): boolean {
    if (this.isOnlineMode() || this.quickGhost) return false;
    return this.states.length > 1;
  }

  private applySidesFromSettings() {
    this.humanSide = resolveHumanSide(this.settings.humanColor);
    this.aiSide = opponentOf(this.humanSide);
  }

  private newGame() {
    this.cancelAiTurn();
    this.clearMoveClock();
    this.forcedResult = null;
    this.applySidesFromSettings();
    this.states = [initialState(this.config)];
    this.selected = null;
    this.learningRecorded = false;
    this.notify();
    this.maybeAiTurn();
    this.ensureMoveClock();
  }

  private recordLearningIfEnded() {
    try {
      const state = this.current();
      const result = getResult(state, this.config);
      if (!result || !this.isAiMode() || this.quickGhost || this.learningRecorded) return;
      this.learningRecorded = true;
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
    if (this.quickGhost) {
      const decision = this.quickGhost.choose(state, this.config);
      if (decision?.move) return decision.move;
    }
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
    if (!this.isAiMode() || this.aiThinking || state.turn !== this.aiSide || getResult(state, this.config) || this.forcedResult) {
      this.ensureMoveClock();
      return;
    }
    this.clearMoveClock();
    this.aiThinking = true;
    const aiTurnId = ++this.aiTurnId;
    const preset = AI_DIFFICULTY_PRESETS[this.settings.aiDifficulty];
    this.notify();
    const wallDeadline = Date.now() + preset.maxMs + 500;
    window.setTimeout(() => {
      if (aiTurnId !== this.aiTurnId) return;
      try {
        const cur = this.current();
        if (!this.isAiMode() || getResult(cur, this.config) || cur.turn !== this.aiSide) return;
        const budget = Math.max(
          100,
          Math.min(preset.maxMs, wallDeadline - Date.now()),
        );
        const move = this.pickAiMove(cur, budget, preset.maxDepth);
        if (move) this.states.push(applyMove(this.current(), move));
        this.recordLearningIfEnded();
      } finally {
        if (aiTurnId !== this.aiTurnId) return;
        this.aiThinking = false;
        this.notify();
        const after = this.current();
        if (
          this.isAiMode() &&
          !this.forcedResult &&
          !getResult(after, this.config) &&
          after.turn === this.aiSide &&
          legalMoves(after, this.config).length > 0
        ) {
          this.maybeAiTurn();
        } else {
          this.ensureMoveClock();
        }
      }
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
      this.moveDeadline = null;
      this.notify();
      return;
    }

    this.clearMoveClock();
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
          const file = document.createElement('span');
          file.className = 'coord coord-file';
          file.textContent = FILES[c];
          cell.appendChild(file);
        }
        if (c === 0) {
          const rank = document.createElement('span');
          rank.className = 'coord coord-rank';
          rank.textContent = String(n - r);
          cell.appendChild(rank);
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
          el.setAttribute('aria-label', `${PLAYER_KO[piece.player]} ${piece.type === 'KING' ? '왕' : '호위'}`);
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
