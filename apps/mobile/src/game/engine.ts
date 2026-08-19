import type { GameResult, GameState, Move, Player, Coord, Piece } from '../../../../packages/game-core/src';
import {
  DEFAULT_CONFIG,
  applyMove,
  getResult,
  initialState,
  isGoalCell,
  legalMoves,
  opponent,
} from '../../../../packages/game-core/src';
import { chooseMove } from '../../../../packages/game-ai/src';
import {
  AI_DIFFICULTY_PRESETS,
  type AiDifficulty,
  type HumanColorChoice,
  resolveHumanSide,
} from '../../../../packages/game-data/src';
import { GhostController, ghostFromFinishedGame, type GhostStyle, type GhostTape } from '../../../../packages/game-data/src';

export type PlayMode =
  | { kind: 'local' }
  | { kind: 'ai'; difficulty: AiDifficulty }
  | { kind: 'ghost'; tape: GhostTape }
  | { kind: 'tutorial' }
  | { kind: 'online'; opponentName: string; opponentRating: number; isBot: boolean; matchKind?: 'random' | 'friend' };

export type SessionResult = GameResult | { winner: Player; reason: 'forfeit' | 'timeout' };

export interface CellHighlight {
  isGoalBlack: boolean;
  isGoalWhite: boolean;
  isSelected: boolean;
  isLastMove: boolean;
  isTarget: boolean;
  isPlace: boolean;
  isCapture: boolean;
  isHint: boolean;
}

export interface SessionSnapshot {
  state: GameState;
  result: SessionResult | null;
  mode: PlayMode;
  humanSide: Player;
  selected: Coord | null;
  lastMove: Move | null;
  legal: Move[];
  thinking: boolean;
  ghostNote: string | null;
  ghostStyle: GhostStyle | null;
  ghostFidelity: number;
  canUndo: boolean;
  isMyTurn: boolean;
  moveDeadline: number | null;
  tutorialStep: number;
  tutorialFinished: boolean;
  tutorialTitle: string;
  tutorialCoach: string;
  tutorialHint: string;
  tutorialShowsGoals: boolean;
}

type Listener = () => void;

interface TutorialLesson {
  title: string;
  coach: string;
  hintIdle: string;
  hintArmed: string;
  state: () => GameState;
  move: Move;
  showGoals: boolean;
}

function sameCoord(a: Coord | null | undefined, b: Coord): boolean {
  return Boolean(a && a.r === b.r && a.c === b.c);
}

function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'PLACE' && b.kind === 'PLACE') return sameCoord(a.to, b.to);
  if (a.kind === 'MOVE' && b.kind === 'MOVE') return sameCoord(a.from, b.from) && sameCoord(a.to, b.to);
  return false;
}

function makeTutorialState(pieces: Array<[number, number, Player, Piece['type']]>, blackHand = 8, whiteHand = 8): GameState {
  const state = initialState(DEFAULT_CONFIG);
  state.board = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
  for (const [r, c, player, type] of pieces) state.board[r]![c] = { player, type };
  state.turn = 'BLACK';
  state.guardsInHand = { BLACK: blackHand, WHITE: whiteHand };
  state.history = [];
  state.positionCounts = {};
  return state;
}

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

export class GameSession {
  private listeners = new Set<Listener>();
  private selected: Coord | null = null;
  private lastMove: Move | null = null;
  private result: SessionResult | null = null;
  private legal: Move[];
  private thinking = false;
  private ghostNote: string | null = null;
  private ghostStyle: GhostStyle | null = null;
  private ghostFidelity = 1;
  private undoStack: GameState[] = [];
  private moveDeadline: number | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private turnToken = 0;
  private ghostController: GhostController | null = null;
  private tutorialIndex = 0;
  private tutorialFinished = false;
  private tutorialTitle = '';
  private tutorialCoach = '';
  private tutorialHint = '';
  private tutorialShowsGoals = false;
  private tutorialSelected: Coord | null = null;
  private tutorialAllowed: Move | null = null;
  private readonly lessons = tutorialLessons();

  public readonly config = DEFAULT_CONFIG;
  public humanSide: Player;
  public onOnlineMove: ((move: Move) => void) | null = null;

  constructor(public readonly mode: PlayMode, humanColor: HumanColorChoice = 'BLACK') {
    this.humanSide = mode.kind === 'ghost'
      ? opponent(mode.tape.side)
      : mode.kind === 'ai'
        ? resolveHumanSide(humanColor)
        : 'BLACK';
    this.legal = legalMoves(initialState(this.config), this.config);
    if (mode.kind === 'ghost') this.ghostController = new GhostController(mode.tape);
    if (mode.kind === 'tutorial') this.loadTutorial(0);
  }

  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  getSnapshot(): SessionSnapshot {
    return {
      state: this.state,
      result: this.result,
      mode: this.mode,
      humanSide: this.humanSide,
      selected: this.selected,
      lastMove: this.lastMove,
      legal: this.legal,
      thinking: this.thinking,
      ghostNote: this.ghostNote,
      ghostStyle: this.ghostStyle,
      ghostFidelity: this.ghostFidelity,
      canUndo: !this.isQuickMatch && this.undoStack.length > 0 && !this.thinking && !this.result,
      isMyTurn: this.isMyTurn,
      moveDeadline: this.moveDeadline,
      tutorialStep: this.tutorialIndex,
      tutorialFinished: this.tutorialFinished,
      tutorialTitle: this.tutorialTitle,
      tutorialCoach: this.tutorialCoach,
      tutorialHint: this.tutorialHint,
      tutorialShowsGoals: this.tutorialShowsGoals,
    };
  }

  private state: GameState = initialState(DEFAULT_CONFIG);

  private get isQuickMatch(): boolean { return this.mode.kind === 'ghost' || this.mode.kind === 'online'; }
  private get isMyTurn(): boolean {
    if (this.result) return false;
    if (this.mode.kind === 'local' || this.mode.kind === 'tutorial') return true;
    return this.state.turn === this.humanSide && !this.thinking;
  }

  start(): void { if (this.mode.kind !== 'tutorial') void this.playOpponentIfNeeded(); }

  tap(coord: Coord): void {
    if (this.result || !this.isMyTurn) return;
    if (this.mode.kind === 'tutorial') { this.tapTutorial(coord); return; }
    if (this.selected) {
      const selected = this.selected;
      const move = this.legal.find((candidate) => candidate.kind === 'MOVE' && sameCoord(candidate.from, selected) && sameCoord(candidate.to, coord));
      if (move) { this.playHuman(move); return; }
      if (sameCoord(this.selected, coord)) { this.selected = null; this.notify(); return; }
      const piece = this.state.board[coord.r]?.[coord.c];
      if (piece?.player === this.state.turn) { this.selected = coord; this.notify(); return; }
    }
    const piece = this.state.board[coord.r]?.[coord.c];
    if (piece?.player === this.state.turn) { this.selected = coord; this.notify(); return; }
    const place = this.legal.find((candidate) => candidate.kind === 'PLACE' && sameCoord(candidate.to, coord));
    if (place) this.playHuman(place);
  }

  resign(): void {
    if (!this.isQuickMatch || this.result) return;
    this.finishAsLoss('forfeit');
  }

  undo(): void {
    if (this.isQuickMatch || this.thinking || this.result) return;
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.state = previous;
    this.selected = null;
    this.lastMove = this.state.history[this.state.history.length - 1] ?? null;
    this.result = getResult(this.state, this.config);
    this.refreshLegal();
    this.notify();
  }

  bindOnlineSide(side: Player): void {
    this.humanSide = side;
    this.notify();
  }

  applyServerState(next: GameState): void {
    this.state = next;
    this.lastMove = next.history[next.history.length - 1] ?? null;
    this.result = getResult(next, this.config);
    this.selected = null;
    this.thinking = next.turn !== this.humanSide && !this.result;
    this.refreshLegal();
    this.notify();
  }

  applyServerResult(winner: Player, reason: SessionResult['reason']): void {
    this.result = { winner, reason };
    this.thinking = false;
    this.selected = null;
    this.legal = [];
    this.moveDeadline = null;
    this.notify();
  }

  makeGhostFromResult(ownerName: string, ownerRating: number): GhostTape | null {
    return this.result ? ghostFromFinishedGame(this.state, this.result as GameResult, ownerName, ownerRating, this.humanSide, 'local', '빠른 대전에서 남긴 기보') : null;
  }

  highlights(coord: Coord): CellHighlight {
    const mark: CellHighlight = {
      isGoalBlack: false, isGoalWhite: false, isSelected: sameCoord(this.selected, coord),
      isLastMove: Boolean(this.lastMove && (sameCoord(this.lastMove.to, coord) || (this.lastMove.kind === 'MOVE' && sameCoord(this.lastMove.from, coord)))),
      isTarget: false, isPlace: false, isCapture: false, isHint: false,
    };
    if (!this.mode.kind.includes('tutorial') || this.tutorialShowsGoals) {
      mark.isGoalBlack = isGoalCell('BLACK', coord, this.config);
      mark.isGoalWhite = isGoalCell('WHITE', coord, this.config);
    }
    const allowed = this.mode.kind === 'tutorial' ? this.tutorialAllowed : null;
    if (allowed) {
      if (allowed.kind === 'PLACE' && sameCoord(allowed.to, coord)) mark.isHint = mark.isPlace = true;
      if (allowed.kind === 'MOVE') {
        if (!this.tutorialSelected && sameCoord(allowed.from, coord)) mark.isHint = true;
        if (this.tutorialSelected && sameCoord(allowed.to, coord)) { mark.isHint = mark.isTarget = true; mark.isCapture = Boolean(this.state.board[coord.r]?.[coord.c]); }
      }
    } else if (this.isMyTurn) {
      const selected = this.selected;
      if (selected && this.legal.some((move) => move.kind === 'MOVE' && sameCoord(move.from, selected) && sameCoord(move.to, coord))) {
        mark.isTarget = true; mark.isCapture = Boolean(this.state.board[coord.r]?.[coord.c]);
      } else if (!this.selected && this.legal.some((move) => move.kind === 'PLACE' && sameCoord(move.to, coord))) mark.isPlace = true;
    }
    return mark;
  }

  private tapTutorial(coord: Coord): void {
    if (this.tutorialFinished || !this.tutorialAllowed) return;
    const move = this.tutorialAllowed;
    if (move.kind === 'PLACE' && sameCoord(move.to, coord)) { this.playHuman(move); return; }
    if (move.kind === 'MOVE') {
      if (!this.tutorialSelected && sameCoord(move.from, coord)) { this.tutorialSelected = coord; this.tutorialHint = this.lessons[this.tutorialIndex]!.hintArmed; this.notify(); }
      else if (this.tutorialSelected && sameCoord(move.to, coord)) this.playHuman(move);
      else if (this.tutorialSelected && sameCoord(move.from, coord)) { this.tutorialSelected = null; this.tutorialHint = this.lessons[this.tutorialIndex]!.hintIdle; this.notify(); }
    }
  }

  private playHuman(move: Move): void {
    if (this.mode.kind === 'online') {
      this.selected = null; this.thinking = true; this.onOnlineMove?.(move); this.notify(); return;
    }
    if (this.mode.kind !== 'tutorial') this.undoStack.push(this.state);
    this.clearTimeout();
    this.apply(move);
    this.selected = null;
    if (this.mode.kind === 'tutorial') { this.advanceTutorial(); return; }
    void this.playOpponentIfNeeded();
  }

  private apply(move: Move): void {
    this.state = applyMove(this.state, move);
    this.lastMove = move;
    this.result = getResult(this.state, this.config);
    if (this.mode.kind === 'tutorial' && this.tutorialIndex < this.lessons.length - 1) { this.result = null; this.state.turn = 'BLACK'; }
    this.refreshLegal();
    if (this.ghostController) this.ghostFidelity = this.ghostController.fidelity;
    this.notify();
  }

  private async playOpponentIfNeeded(): Promise<void> {
    if (this.result) return;
    if (this.mode.kind === 'ai' && this.state.turn !== this.humanSide) await this.playAI();
    if (this.mode.kind === 'ghost' && this.state.turn !== this.humanSide) await this.playGhost();
    if (this.mode.kind === 'ghost' && this.state.turn === this.humanSide && !this.result) this.startMoveClock();
  }

  private async playAI(): Promise<void> {
    const token = ++this.turnToken;
    this.thinking = true; this.notify();
    await new Promise((resolve) => setTimeout(resolve, 24));
    const preset = AI_DIFFICULTY_PRESETS[this.mode.kind === 'ai' ? this.mode.difficulty : 'normal'];
    const move = chooseMove(this.state, this.config, preset);
    if (token !== this.turnToken || this.result || !move) { this.thinking = false; this.notify(); return; }
    await new Promise((resolve) => setTimeout(resolve, 280));
    this.apply(move); this.thinking = false; this.notify();
    await this.playOpponentIfNeeded();
  }

  private async playGhost(): Promise<void> {
    const controller = this.ghostController;
    if (!controller) return;
    const token = ++this.turnToken;
    this.thinking = true; this.notify();
    await new Promise((resolve) => setTimeout(resolve, 24));
    const decision = controller.choose(this.state, this.config);
    if (token !== this.turnToken || this.result || !decision) { this.thinking = false; this.notify(); return; }
    this.ghostStyle = decision.style;
    this.ghostNote = `${this.mode.kind === 'ghost' ? this.mode.tape.ownerName : '상대'} · ${decision.note}`;
    this.ghostFidelity = controller.fidelity;
    await new Promise((resolve) => setTimeout(resolve, decision.style === 'recorded' ? 420 : 560));
    this.apply(decision.move); this.thinking = false; this.notify();
    await this.playOpponentIfNeeded();
  }

  private startMoveClock(): void {
    this.clearTimeout();
    this.moveDeadline = Date.now() + 60_000;
    const token = ++this.turnToken;
    this.timeout = setTimeout(() => { if (token === this.turnToken && !this.result) this.finishAsLoss('timeout'); }, 60_000);
    this.notify();
  }

  private finishAsLoss(reason: SessionResult['reason']): void {
    this.turnToken += 1; this.clearTimeout(); this.thinking = false; this.selected = null; this.legal = []; this.moveDeadline = null;
    this.result = { winner: opponent(this.humanSide), reason }; this.notify();
  }

  private clearTimeout(): void { if (this.timeout) clearTimeout(this.timeout); this.timeout = null; this.moveDeadline = null; }

  private loadTutorial(index: number): void {
    const lesson = this.lessons[index]!;
    this.tutorialIndex = index; this.tutorialFinished = false; this.tutorialSelected = null; this.tutorialAllowed = lesson.move;
    this.tutorialTitle = lesson.title; this.tutorialCoach = lesson.coach; this.tutorialHint = lesson.hintIdle; this.tutorialShowsGoals = lesson.showGoals;
    this.state = lesson.state(); this.selected = null; this.lastMove = null; this.result = null; this.refreshLegal(); this.notify();
  }

  private advanceTutorial(): void {
    if (this.tutorialIndex >= this.lessons.length - 1) {
      this.tutorialFinished = true; this.tutorialAllowed = null; this.tutorialShowsGoals = true; this.tutorialTitle = '이제 기본 규칙을 모두 익혔어요'; this.tutorialCoach = '컴퓨터와 한 판 두면서 연습해 보세요.'; this.tutorialHint = ''; this.notify(); return;
    }
    this.loadTutorial(this.tutorialIndex + 1);
  }

  private refreshLegal(): void {
    const all = this.result ? [] : legalMoves(this.state, this.config);
    this.legal = this.mode.kind === 'tutorial' && this.tutorialAllowed ? all.filter((move) => sameMove(move, this.tutorialAllowed!)) : all;
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}
