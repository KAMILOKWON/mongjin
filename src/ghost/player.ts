import { chooseMove } from '../ai/ai';
import type { RuleConfig } from '../core/config';
import { legalMoves } from '../core/rules';
import type { Coord, GameState, Move } from '../core/types';
import type { GhostTape } from './types';

export type GhostStyle = 'recorded' | 'adapted' | 'improvised';

export interface GhostDecision {
  move: Move;
  style: GhostStyle;
  note: string;
}

function moveSignature(move: Move): string {
  return move.kind === 'PLACE'
    ? `P:${move.to.r},${move.to.c}`
    : `M:${move.from.r},${move.from.c}>${move.to.r},${move.to.c}`;
}

function distance(a: Coord, b: Coord): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

function isCapture(state: GameState, move: Move): boolean {
  return move.kind === 'MOVE' && state.board[move.to.r]?.[move.to.c] != null;
}

/** 저장된 기보를 재생하되, 사용자가 다른 수를 두면 가까운 합법 수와 AI로 적응한다. */
export class GhostController {
  private ply = 0;
  private recordedCount = 0;
  private adaptedCount = 0;
  private improvisedCount = 0;

  constructor(public readonly tape: GhostTape) {}

  get fidelity(): number {
    const total = this.recordedCount + this.adaptedCount + this.improvisedCount;
    return total === 0 ? 1 : this.recordedCount / total;
  }

  choose(state: GameState, config: RuleConfig): GhostDecision | null {
    const legal = legalMoves(state, config);
    if (legal.length === 0) return null;

    if (this.ply < this.tape.moves.length) {
      const recorded = this.tape.moves[this.ply++];
      const exact = legal.find((move) => moveSignature(move) === moveSignature(recorded));
      if (exact) {
        this.recordedCount += 1;
        return { move: exact, style: 'recorded', note: `기보 ${this.ply}수` };
      }
      const adapted = this.adapt(recorded, legal, state);
      if (adapted) {
        this.adaptedCount += 1;
        return { move: adapted, style: 'adapted', note: `기보 ${this.ply}수를 응용` };
      }
    }

    const move = chooseMove(state, config, {
      maxMs: 220,
      maxDepth: 3,
      maxNodes: 700,
      choiceWindow: 40,
      rootNoise: 40,
      planStrength: 0.8,
      strategyLevel: 1,
    }) ?? legal[0];
    this.improvisedCount += 1;
    return {
      move,
      style: 'improvised',
      note: this.ply > this.tape.moves.length ? '기보가 끝나 즉흥으로 둠' : '기보를 응용할 수 없어 즉흥으로 둠',
    };
  }

  private adapt(recorded: Move, legal: Move[], state: GameState): Move | null {
    if (recorded.kind === 'PLACE') {
      return legal
        .filter((move) => move.kind === 'PLACE')
        .sort((a, b) => distance(a.to, recorded.to) - distance(b.to, recorded.to))[0] ?? null;
    }

    const moves = legal.filter((move): move is Extract<Move, { kind: 'MOVE' }> => move.kind === 'MOVE');
    const sameFrom = moves.filter((move) => move.from.r === recorded.from.r && move.from.c === recorded.from.c);
    if (sameFrom.length > 0) {
      return sameFrom.sort((a, b) => distance(a.to, recorded.to) - distance(b.to, recorded.to))[0] ?? null;
    }
    const captureMoves = moves.filter((move) => isCapture(state, move));
    const pool = state.board[recorded.to.r]?.[recorded.to.c] && captureMoves.length > 0 ? captureMoves : moves;
    return pool.sort((a, b) => {
      const aOrigin = a.from;
      const bOrigin = b.from;
      return (distance(aOrigin, recorded.from) * 2 + distance(a.to, recorded.to))
        - (distance(bOrigin, recorded.from) * 2 + distance(b.to, recorded.to));
    })[0] ?? null;
  }
}
