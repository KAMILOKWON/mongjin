import type { Coord, GameState, Move, Piece, Player } from '../../../../packages/game-core/src';
import {
  DEFAULT_CONFIG,
  applyMove,
  getResult,
  goalCellsFor,
  initialState,
  legalMoves,
  type GameResult,
  type RuleConfig,
  type WinReason,
} from '../../../../packages/game-core/src';
import { chooseMove, getBotBrain } from '../../../../packages/game-ai/src';
import {
  AI_DIFFICULTY_PRESETS,
  GhostController,
  ghostFromFinishedGame,
  opponentOf,
  resolveHumanSide,
  type AiDifficulty,
  type GhostTape,
  type GameSettings,
  type HumanColorChoice,
  type OpponentMode,
} from '../../../../packages/game-data/src';
import {
  OnlineClient,
  hasIdentity,
  hasTossIdentity,
  type OnlineMatchReason,
  type OpponentProfile,
  type PlayerProfile,
} from '../net/online';
import { TossProfileStore } from '../profile/catalog';
import { loginWithToss } from '../net/tossLogin';
import { exportGameMgn } from '../../../../bot/learning/gameRecord';

const PLAYER_KO: Record<Player, string> = { BLACK: '흑', WHITE: '백' };
const DEFAULT_PROFILE_NAME = '나그네';
const REASON_KO: Record<WinReason, string> = {
  goal: '왕이 목적지에 도달',
  capture: '상대 왕을 잡음',
  surround: '상대 왕을 포위',
  'no-moves': '상대가 둘 수 없음',
};

type ForcedResult = { winner: Player; reason: WinReason | 'timeout' | 'forfeit' };
type RawResult = GameResult | ForcedResult;

/** 모바일과 동일한 관점 문장 카피 */
export function resultTitleCopy(raw: RawResult, humanSide: Player, quick: boolean): string {
  if (!quick) return `${PLAYER_KO[raw.winner]} 승리`;
  return raw.winner === humanSide ? '승리' : '패배';
}

export function resultSentenceCopy(raw: RawResult, humanSide: Player, quick: boolean): string {
  const won = raw.winner === humanSide;
  switch (raw.reason) {
    case 'forfeit': return won ? '상대가 항복했습니다' : '항복했습니다';
    case 'timeout': return won ? '상대가 시간 안에 두지 못했습니다' : '1분 안에 두지 못했습니다';
    case 'goal': return quick ? (won ? '왕이 목적지에 도착했습니다' : '상대 왕이 목적지에 도착했습니다') : '왕이 목적지에 도착했습니다';
    case 'capture': return quick ? (won ? '상대 왕을 잡았습니다' : '왕이 잡혔습니다') : '왕을 잡아 이겼습니다';
    case 'surround': return quick ? (won ? '상대 왕을 포위했습니다' : '왕이 포위되었습니다') : '왕을 포위해 이겼습니다';
    case 'no-moves': return quick ? (won ? '상대가 둘 수 없었습니다' : '둘 수 있는 수가 없었습니다') : '둘 수 있는 수가 없었습니다';
  }
}

export interface VisibleProfile {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  winRate: number;
}

function sameCoord(a: Coord | null | undefined, b: Coord): boolean {
  return Boolean(a && a.r === b.r && a.c === b.c);
}

function sameMove(a: Move, b: Move | null): boolean {
  if (!b || a.kind !== b.kind) return false;
  if (a.kind === 'PLACE' && b.kind === 'PLACE') return sameCoord(a.to, b.to);
  if (a.kind === 'MOVE' && b.kind === 'MOVE') return sameCoord(a.from, b.from) && sameCoord(a.to, b.to);
  return false;
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

function makeTutorialState(
  pieces: Array<[number, number, Player, Piece['type']]>,
  blackHand = 8,
  whiteHand = 8,
): GameState {
  const state = initialState(DEFAULT_CONFIG);
  state.board = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
  for (const [r, c, player, type] of pieces) state.board[r]![c] = { player, type };
  state.turn = 'BLACK';
  state.guardsInHand = { BLACK: blackHand, WHITE: whiteHand };
  state.history = [];
  state.positionCounts = {};
  return state;
}

/** 모바일 앱과 동일한 5단계 인터랙티브 레슨 */
function tutorialLessons(): TutorialLesson[] {
  return [
    {
      title: '호위를 놓아 볼까요?',
      coach: '흑부터 시작해요. 검은 왕 바로 위에 파랗게 빛나는 칸을 눌러 호위를 놓아 보세요.',
      hintIdle: '파란 칸을 눌러 호위를 놓아 보세요', hintArmed: '파란 칸을 눌러 호위를 놓아 보세요',
      state: () => initialState(DEFAULT_CONFIG), move: { kind: 'PLACE', to: { r: 7, c: 4 } }, showGoals: false,
    },
    {
      title: '왕을 움직여 볼까요?',
      coach: '한 번에 한 가지 행동만 할 수 있어요. 왕을 누른 다음 파란 칸으로 옮겨 보세요.',
      hintIdle: '파란 왕을 먼저 눌러 보세요', hintArmed: '파란 칸으로 왕을 옮겨 보세요',
      state: () => { const state = applyMove(initialState(DEFAULT_CONFIG), { kind: 'PLACE', to: { r: 7, c: 4 } }); state.turn = 'BLACK'; return state; },
      move: { kind: 'MOVE', from: { r: 8, c: 4 }, to: { r: 7, c: 3 } }, showGoals: false,
    },
    {
      title: '호위로 잡아 볼까요?',
      coach: '호위는 상하좌우로 움직여요. 상대 호위가 있는 칸으로 이동하면 잡을 수 있어요.',
      hintIdle: '파란 호위를 먼저 눌러 보세요', hintArmed: '흰 호위를 눌러 잡아 보세요',
      state: () => makeTutorialState([[8, 4, 'BLACK', 'KING'], [6, 4, 'BLACK', 'GUARD'], [0, 4, 'WHITE', 'KING'], [5, 4, 'WHITE', 'GUARD']], 7, 7),
      move: { kind: 'MOVE', from: { r: 6, c: 4 }, to: { r: 5, c: 4 } }, showGoals: false,
    },
    {
      title: '왕을 잡으면 끝나요',
      coach: '호위는 목적지에는 들어갈 수 없지만 그 칸에 왕이 있으면 잡을 수 있어요. 왕을 잡으면 대국이 끝나요.',
      hintIdle: '파란 호위를 먼저 눌러 보세요', hintArmed: '흰 왕을 눌러 잡아 보세요',
      state: () => makeTutorialState([[8, 4, 'BLACK', 'KING'], [1, 4, 'BLACK', 'GUARD'], [0, 4, 'WHITE', 'KING']], 7, 8),
      move: { kind: 'MOVE', from: { r: 1, c: 4 }, to: { r: 0, c: 4 } }, showGoals: true,
    },
    {
      title: '목적지로 가 볼까요?',
      coach: '색이 다른 위쪽 가운데 세 칸이 목적지예요. 왕을 그중 한 칸으로 옮기면 이겨요.',
      hintIdle: '파란 왕을 먼저 눌러 보세요', hintArmed: '파란 목적지 칸을 눌러 보세요',
      state: () => makeTutorialState([[1, 3, 'BLACK', 'KING'], [0, 4, 'WHITE', 'KING']]),
      move: { kind: 'MOVE', from: { r: 1, c: 3 }, to: { r: 0, c: 3 } }, showGoals: true,
    },
  ];
}

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
  /** 로컬(고스트) 전적과 온라인 전적을 합산한 표시용 프로필 */
  visibleProfile: VisibleProfile | null;
  rankInfo: { rank: number; totalPlayers: number } | null;
  canUndo: boolean;
  isMyTurn: boolean;
  turnLabel: string;
  resultTitle: string | null;
  resultSentence: string | null;
  ghostNote: string | null;
  ghostFidelity: number;
  toast: string | null;
  tutorialActive: boolean;
  tutorialStep: number;
  tutorialTotal: number;
  tutorialFinished: boolean;
  tutorialTitle: string;
  tutorialCoach: string;
  tutorialHint: string;
  tutorialShowsGoals: boolean;
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
  private quickTape: GhostTape | null = null;
  private quickRecorded = false;
  private ghostNote: string | null = null;
  private ghostFidelity = 1;
  private moveDeadline: number | null = null;
  private moveClockTimer: number | null = null;
  private moveClockToken = 0;
  private forcedResult: ForcedResult | null = null;
  /** 매칭 흐름 재진입 시 오래된 MATCH_FOUND·타임아웃을 무시하기 위한 세대 번호 */
  private matchGeneration = 0;
  private pendingActionGen = -1;
  private toastText: string | null = null;
  private toastTimer: number | null = null;
  private readonly profiles = new TossProfileStore();
  private readonly lessons = tutorialLessons();
  private tutActive = false;
  private tutIndex = 0;
  private tutFinished = false;
  private tutSelected: Coord | null = null;
  private tutAllowed: Move | null = null;
  private tutTitle = '';
  private tutCoach = '';
  private tutHint = '';
  private tutShowsGoals = false;

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
      if (this.pendingActionGen !== this.matchGeneration && this.onlineMatchKind !== 'friend') return;
      this.pendingActionGen = -1;
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
      // 서버 판정을 결과 스냅샷에도 반영해야 forfeit를 포함한 모든 정상 종료가
      // 결과 화면·광고 등 공통 종료 흐름을 탄다.
      this.forcedResult = { winner, reason };
      // 서버 판정이 확정됐으니 내 차례 시계 타이머가 덮어쓰지 않게 끊는다
      this.clearMoveClock();
      this.notify();
    },
    onProfile: (profile) => {
      this.profile = profile;
      this.onlineLoggedOut = false;
      try {
        const onlineProfile = this.profiles.mergeOnlineProfile(profile);
        // 서버 닉네임을 로컬 기본값에 한 번만 반영한다
        if (this.profiles.profile().name === DEFAULT_PROFILE_NAME && profile.name !== DEFAULT_PROFILE_NAME) {
          this.profiles.updateName(profile.name);
        }
        if (!profile.legacyMigrationComplete && this.online.connected) {
          const local = this.profiles.profile();
          const wins = local.wins + onlineProfile.wins;
          const losses = local.losses + onlineProfile.losses;
          void this.online.migrateLegacyProfile({
            name: local.name,
            wins,
            losses,
            rating: Math.max(100, local.rating + onlineProfile.rating - 1200),
          });
        }
      } catch {
        /* 병합 실패가 세션을 막지 않도록 한다 */
      }
      this.notify();
    },
    onOpponentLeft: () => {
      const hadGame = this.onlineSide !== null && !this.isGameOver();
      this.onlineWaiting = false;
      this.onlineStatus = '상대가 나갔습니다';
      this.clearMoveClock();
      if (hadGame) this.showToast('상대가 대국을 떠났어요');
      this.notify();
    },
    onMatchmakingTimeout: () => this.fallbackRandomMatch(),
    onError: (msg) => {
      if (this.isGameOver()) return; // 종료 후 늦게 도착하는 오류는 결과 화면을 망치지 않는다
      this.onlineStatus = msg;
      this.onlineError = true;
      this.notify();
    },
    onLoggedOut: (msg) => {
      if (!this.isGameOver()) {
        this.onlineStatus = msg;
        this.onlineError = true;
      }
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
    this.profiles.hydrate();
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
    const rawResult: RawResult | null = this.forcedResult ?? getResult(state, this.config);
    const quick = this.isQuickMatch();
    let turnLabel = `${PLAYER_KO[state.turn]} 차례`;
    if (this.tutActive) turnLabel = '튜토리얼';
    else if (this.aiThinking) {
      if (this.quickGhost) {
        turnLabel += ' · 상대가 생각 중…';
      } else {
        const difficulty = AI_DIFFICULTY_PRESETS[this.settings.aiDifficulty].label;
        turnLabel += ` · 컴퓨터(${difficulty}) 생각 중…`;
      }
    }
    else if (this.isOnlineMode() && this.onlineWaiting) turnLabel += ' · 상대 대기 중…';
    else if (this.isOnlineMode() && this.onlineSide && !this.isMyTurn(state)) turnLabel += ' · 상대 차례';

    // MGN 기보와 스냅샷 결과는 core 이유만 담는다 (timeout/forfeit는 표시 계열로 변환)
    let lastMgn: string | null = null;
    const coreResult: GameResult | null = !rawResult
      ? null
      : {
          winner: rawResult.winner,
          reason:
            rawResult.reason === 'timeout' || rawResult.reason === 'forfeit'
              ? 'no-moves'
              : rawResult.reason,
        };
    if (coreResult && !this.tutActive) {
      lastMgn = exportGameMgn({
        state,
        result: coreResult,
        config: this.config,
        settings: this.settings,
        humanSide: this.humanSide,
      }).mgn;
    }

    const local = this.profiles.profile();
    const onlineMerged = this.profiles.onlineProfile();
    const official = onlineMerged?.legacyMigrationComplete ? onlineMerged : null;
    const wins = official?.wins ?? local.wins + (onlineMerged?.wins ?? 0);
    const losses = official?.losses ?? local.losses + (onlineMerged?.losses ?? 0);
    const games = wins + losses;
    const visibleProfile: VisibleProfile = {
      name: official?.name ?? local.name,
      rating: official?.rating ?? Math.max(100, local.rating + (onlineMerged?.rating ?? 1200) - 1200),
      wins,
      losses,
      winRate: games ? Math.round((wins / games) * 100) : 0,
    };

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
      visibleProfile,
      rankInfo: this.profile
        ? { rank: this.profile.rank, totalPlayers: this.profile.totalPlayers }
        : null,
      canUndo: this.canUndo(),
      isMyTurn: this.isMyTurn(state),
      turnLabel,
      resultTitle: rawResult && !this.tutActive ? resultTitleCopy(rawResult, this.humanSide, quick) : null,
      resultSentence: rawResult && !this.tutActive ? resultSentenceCopy(rawResult, this.humanSide, quick) : null,
      ghostNote: this.quickGhost ? this.ghostNote : null,
      ghostFidelity: this.quickGhost ? this.ghostFidelity : 1,
      toast: this.toastText,
      tutorialActive: this.tutActive,
      tutorialStep: this.tutIndex + 1,
      tutorialTotal: this.lessons.length,
      tutorialFinished: this.tutFinished,
      tutorialTitle: this.tutTitle,
      tutorialCoach: this.tutCoach,
      tutorialHint: this.tutHint,
      tutorialShowsGoals: this.tutShowsGoals,
      moveDeadline: quick ? this.moveDeadline : null,
      lastMgn,
    };
  }

  setMode(mode: OpponentMode) {
    if (this.settings.mode === mode && !this.tutActive) return;
    this.recordQuickResultIfEnded();
    this.cancelAiTurn();
    this.clearMoveClock();
    this.matchGeneration += 1;
    this.pendingActionGen = -1;
    this.forcedResult = null;
    this.quickGhost = null;
    this.quickTape = null;
    this.quickRecorded = false;
    this.ghostNote = null;
    this.ghostFidelity = 1;
    this.tutActive = false;
    this.tutFinished = false;
    this.tutAllowed = null;
    this.tutSelected = null;
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
    const roomId = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      this.showToast('6자리 입장코드를 입력해 주세요');
      return;
    }
    if (!this.isOnlineMode()) this.setMode('online');
    this.matchGeneration += 1;
    this.pendingActionGen = this.matchGeneration;
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
      await this.online.joinRoom(roomId);
    } catch {
      /* onError */
    }
  }

  async startRandomMatch() {
    if (!this.isOnlineMode()) this.setMode('online');
    this.matchGeneration += 1;
    this.pendingActionGen = this.matchGeneration;
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
    if (this.pendingActionGen !== this.matchGeneration) return;
    if (this.onlineMatchKind !== 'random' || !this.onlineWaiting) return;
    this.onlineStatus = '상대를 연결하는 중…';
    this.onlineError = false;
    this.notify();
    const generation = this.matchGeneration;
    void this.online.startBotMatch().catch(() => {
      if (generation !== this.matchGeneration) return;
      this.pendingActionGen = -1;
      this.onlineWaiting = false;
      this.onlineStatus = '온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';
      this.onlineError = true;
      this.notify();
    });
  }

  cancelRandomMatch() {
    this.matchGeneration += 1;
    this.pendingActionGen = -1;
    this.online.cancelMatchmaking();
    this.onlineWaiting = false;
    this.onlineStatus = '랜덤 매칭을 취소했어요';
    this.notify();
  }

  /** 입장코드(친구) 방 대기를 취소하고 방을 닫는다 */
  cancelFriendRoom() {
    this.matchGeneration += 1;
    this.pendingActionGen = -1;
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

  /** 닉네임을 기기에 먼저 저장하고 접속 중이면 서버에도 반영한다 */
  saveName(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 12) {
      this.showToast('닉네임은 2~12자로 적어 주세요');
      return false;
    }
    try {
      this.profiles.updateName(trimmed);
    } catch {
      this.showToast('닉네임을 저장하지 못했어요');
      return false;
    }
    if (this.online.connected) void this.online.updateProfile(trimmed).catch(() => {});
    this.notify();
    this.showToast('닉네임을 저장했어요');
    return true;
  }

  showToast(message: string) {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastText = message;
    this.toastTimer = window.setTimeout(() => {
      this.toastTimer = null;
      this.toastText = null;
      this.notify();
    }, 2200);
    this.notify();
  }

  private isGameOver(): boolean {
    return Boolean(this.forcedResult || getResult(this.current(), this.config));
  }

  /** 끝난 빠른 대전(고스트 폴백)을 기기 전적과 방어 테이프에 기록한다 */
  private recordQuickResultIfEnded() {
    if (this.quickRecorded || !this.quickGhost) return;
    const state = this.current();
    const raw = this.forcedResult ?? getResult(state, this.config);
    if (!raw) return;
    this.quickRecorded = true;
    try {
      const coreResult: GameResult = {
        winner: raw.winner,
        reason:
          raw.reason === 'timeout' || raw.reason === 'forfeit' ? 'no-moves' : raw.reason,
      };
      const card = this.profiles.profile();
      const tape = ghostFromFinishedGame(
        state,
        coreResult,
        card.name,
        card.rating,
        this.humanSide,
        'local',
        '빠른 대전에서 남긴 기보',
      );
      this.profiles.recordMatch(raw.winner === this.humanSide, this.quickTape?.ownerRating ?? tape.ownerRating, tape);
    } catch {
      /* 전적 저장 실패가 종료 흐름을 막지 않도록 한다 */
    }
  }

  /** 빠른 대전(랜덤 온라인·고스트 폴백)에서 항복한다 */
  resign() {
    if (this.isGameOver()) return;
    const onlineRandom = this.isOnlineMode() && this.onlineMatchKind === 'random' && this.onlineSide !== null;
    if (!onlineRandom && !this.quickGhost) return;
    if (onlineRandom) {
      try {
        this.online.sendResign();
      } catch {
        /* 연결이 끊긴 경우 서버 판정 없이 로컬 패배로 마친다 */
      }
      this.clearMoveClock();
    }
    this.finishAsLoss('forfeit');
  }

  init(options?: { fetchProfile?: boolean }) {
    this.applySidesFromSettings();
    this.notify();
    this.maybeAiTurn();
    if (options?.fetchProfile !== false) {
      // 토스 미니앱에서는 저장된 세션이 없으면 토스 로그인으로 프로필을 묶는다.
      // 일반 브라우저·개발 환경에서는 조용히 게스트로 계속한다.
      void this.ensureTossSession();
    }
  }

  /** 로그인 세션이 없으면 토스 로그인을 시도하고, 이후 프로필을 가져온다 */
  private async ensureTossSession(): Promise<void> {
    if (!hasIdentity()) await this.retryTossLogin(true);
    await this.refreshProfile().catch(() => {});
  }

  /** 토스 로그인을 다시 시도한다 (연결 해제 후 재로그인 등) */
  async retryTossLogin(silent = false): Promise<boolean> {
    if (!silent) {
      this.onlineStatus = '토스 로그인 중…';
      this.notify();
    }
    const outcome = await loginWithToss();
    if (outcome.ok) {
      this.onlineLoggedOut = false;
      this.onlineError = false;
      this.onlineStatus = '';
      this.notify();
      return true;
    }
    if (!silent) {
      this.onlineStatus = outcome.message ?? '토스 로그인에 실패했습니다';
      this.onlineError = !outcome.unavailable;
      this.notify();
    }
    return false;
  }

  /** 모바일과 같은 5단계 인터랙티브 튜토리얼을 시작한다 */
  enterTutorial() {
    this.cancelAiTurn();
    this.clearMoveClock();
    this.forcedResult = null;
    this.tutActive = true;
    this.loadLesson(0);
  }

  exitTutorial() {
    if (!this.tutActive) return;
    this.tutActive = false;
    this.newGame();
  }

  private loadLesson(index: number) {
    const lesson = this.lessons[index]!;
    this.tutIndex = index;
    this.tutFinished = false;
    this.tutSelected = null;
    this.tutAllowed = lesson.move;
    this.tutTitle = lesson.title;
    this.tutCoach = lesson.coach;
    this.tutHint = lesson.hintIdle;
    this.tutShowsGoals = lesson.showGoals;
    this.states = [lesson.state()];
    this.selected = null;
    this.notify();
  }

  private advanceTutorial() {
    if (this.tutIndex >= this.lessons.length - 1) {
      this.tutFinished = true;
      this.tutAllowed = null;
      this.tutSelected = null;
      this.tutShowsGoals = true;
      this.tutTitle = '이제 기본 규칙을 모두 익혔어요';
      this.tutCoach = '컴퓨터와 한 판 두면서 연습해 보세요.';
      this.tutHint = '';
      this.notify();
      return;
    }
    this.loadLesson(this.tutIndex + 1);
  }

  private tapTutorial(r: number, c: number) {
    if (this.tutFinished || !this.tutAllowed) return;
    const move = this.tutAllowed;
    const coord: Coord = { r, c };
    if (move.kind === 'PLACE') {
      if (sameCoord(move.to, coord)) {
        this.states.push(applyMove(this.current(), move));
        this.advanceTutorial();
      }
      return;
    }
    if (!this.tutSelected && sameCoord(move.from, coord)) {
      this.tutSelected = coord;
      this.tutHint = this.lessons[this.tutIndex]!.hintArmed;
      this.notify();
      return;
    }
    if (this.tutSelected && sameCoord(move.to, coord)) {
      this.states.push(applyMove(this.current(), move));
      this.advanceTutorial();
      return;
    }
    if (this.tutSelected && sameCoord(move.from, coord)) {
      this.tutSelected = null;
      this.tutHint = this.lessons[this.tutIndex]!.hintIdle;
      this.notify();
    }
  }

  destroy() {
    this.cancelAiTurn();
    this.clearMoveClock();
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
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

  /** 랜덤 온라인 대전에서 서버 상태에 맞춰 내 차례 시계를 집행한다 */
  private syncOnlineMoveClock(state: GameState, side = this.onlineSide) {
    if (this.onlineMatchKind !== 'random' || this.quickGhost) return;
    if (side && state.turn === side && !getResult(state, this.config)) {
      this.startMoveClock();
    } else {
      this.clearMoveClock();
    }
  }

  private ensureMoveClock() {
    const enforceable =
      this.quickGhost !== null || (this.isOnlineMode() && this.onlineMatchKind === 'random');
    if (!enforceable) return;
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
      this.finishAsLoss('timeout');
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

  private finishAsLoss(reason: 'timeout' | 'forfeit') {
    this.cancelAiTurn();
    this.clearMoveClock();
    this.selected = null;
    this.forcedResult = { winner: opponentOf(this.humanSide), reason };
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
      if (decision?.move) {
        this.ghostNote = `${this.quickTape?.ownerName ?? '상대'} · ${decision.note}`;
        this.ghostFidelity = this.quickGhost.fidelity;
        return decision.move;
      }
      this.ghostNote = null;
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
    if (wrap && wrap.clientWidth > 0) {
      const style = window.getComputedStyle(wrap);
      const horizontalPadding =
        Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      // clientWidth에는 wrap의 padding이 포함되므로 실제 content box만 사용한다.
      return Math.max(0, wrap.clientWidth - horizontalPadding);
    }

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
    if (this.tutActive) {
      this.tapTutorial(r, c);
      return;
    }
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
      this.clearMoveClock();
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
    const result = this.tutActive ? null : getResult(state, this.config);
    const myTurn = this.isMyTurn(state);
    const moves = this.tutActive
      ? legalMoves(state, this.config).filter((m) => sameMove(m, this.tutAllowed))
      : result || !myTurn
        ? []
        : legalMoves(state, this.config);

    const moveTargets = new Map<string, Move>();
    const placeTargets = new Map<string, Move>();
    for (const m of moves) {
      if (m.kind === 'MOVE' && (this.tutActive ? sameCoord(this.tutSelected ?? this.selected, m.from) : this.selected && m.from.r === this.selected.r && m.from.c === this.selected.c)) {
        moveTargets.set(`${m.to.r},${m.to.c}`, m);
      }
      if (m.kind === 'PLACE') placeTargets.set(`${m.to.r},${m.to.c}`, m);
    }

    const goalBlack = new Set(
      !this.tutActive || this.tutShowsGoals
        ? goalCellsFor('BLACK', this.config).map((g) => `${g.r},${g.c}`)
        : [],
    );
    const goalWhite = new Set(
      !this.tutActive || this.tutShowsGoals
        ? goalCellsFor('WHITE', this.config).map((g) => `${g.r},${g.c}`)
        : [],
    );
    const last = new Set(this.lastMoveCells(state).map((c) => `${c.r},${c.c}`));
    const selectedCell = this.tutActive ? this.tutSelected : this.selected;

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
        if (selectedCell && selectedCell.r === r && selectedCell.c === c) cell.classList.add('selected');

        if (this.tutActive && this.tutAllowed) {
          const allowed = this.tutAllowed;
          if (allowed.kind === 'PLACE' && allowed.to.r === r && allowed.to.c === c) {
            cell.classList.add('place-hint');
          }
          if (allowed.kind === 'MOVE') {
            if (!this.tutSelected && allowed.from.r === r && allowed.from.c === c) {
              cell.classList.add('hint-source');
            }
            if (this.tutSelected && allowed.to.r === r && allowed.to.c === c) {
              cell.classList.add('hint-target');
              if (state.board[r][c]) cell.classList.add('capture');
            }
          }
        }

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
