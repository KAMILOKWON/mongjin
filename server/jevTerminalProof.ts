import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult, type GameResult } from '../src/core/result';
import { findKing, legalMoves, opponent, positionKey } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { jevMoveId } from './jevPolicy';

export type JevTerminalLossStopReason = 'complete' | 'deadline' | 'node-budget' | 'aborted';

export interface JevTerminalLossCandidate {
  move: Move;
  proven: 'loss' | 'unknown';
  proof: (GameResult & { plies: number }) | null;
  principalVariation: Move[];
  /** Deepest fully completed root iteration. Proofs may finish before maxDepth. */
  searchedDepth: number;
  /** True only when a proof was found or maxDepth was fully exhausted. */
  completed: boolean;
  nodes: number;
  stopReason: JevTerminalLossStopReason;
}

export interface JevTerminalLossResult {
  nodes: number;
  stopReason: JevTerminalLossStopReason;
  candidates: JevTerminalLossCandidate[];
}

export interface JevTerminalLossOptions {
  deadlineMs: number;
  maxNodes: number;
  maxDepth: number;
  signal?: AbortSignal;
}

type Proof = { principalVariation: Move[]; terminal: GameResult };
type CachedProof = Proof | null;

const HALT = Symbol('jev-terminal-loss-halt');

/**
 * One-sided exact terminal search. It proves only that OPPONENT can force a
 * terminal win after a supplied SELF root move. Unknown never means safe.
 *
 * OPPONENT nodes are existential; SELF nodes are universal. Internal ordering
 * changes traversal only. Root moves are processed in the caller's order.
 */
export function proveJevTerminalLosses(
  state: GameState,
  config: RuleConfig,
  moves: Move[],
  options: JevTerminalLossOptions,
): JevTerminalLossResult {
  validateOptions(options);

  const root = structuredClone(state);
  const rules = { ...config };
  if (getResult(root, rules)) throw new Error('JEV terminal proof cannot analyze a terminal state');

  const legalById = new Map(legalMoves(root, rules).map((move) => [jevMoveId(move), move]));
  const ids = moves.map(jevMoveId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('JEV terminal proof requires unique root moves');
  }
  const roots = ids.map((id) => {
    const move = legalById.get(id);
    if (!move) throw new Error(`JEV terminal proof received an illegal root move: ${id}`);
    return structuredClone(move);
  });

  const result: JevTerminalLossResult = {
    nodes: 0,
    stopReason: 'complete',
    candidates: roots.map((move) => ({
      move,
      proven: 'unknown',
      proof: null,
      principalVariation: [],
      searchedDepth: 0,
      completed: false,
      nodes: 0,
      stopReason: 'complete',
    })),
  };
  if (roots.length === 0) return result;

  const self = root.turn;
  const attacker = opponent(self);
  let haltReason: Exclude<JevTerminalLossStopReason, 'complete'> | null = null;

  const halt = (reason: Exclude<JevTerminalLossStopReason, 'complete'>): never => {
    haltReason = reason;
    result.stopReason = reason;
    throw HALT;
  };
  const checkInterruption = () => {
    if (options.signal?.aborted) halt('aborted');
    if (Date.now() >= options.deadlineMs) halt('deadline');
  };
  const visit = () => {
    checkInterruption();
    if (result.nodes >= options.maxNodes) halt('node-budget');
    result.nodes += 1;
  };

  // Current rules have no history-dependent terminal condition. positionKey
  // includes turn, reserves and board, so depth + position is cache-safe here.
  const cache = new Map<string, CachedProof>();

  const prove = (position: GameState, depth: number): CachedProof => {
    visit();
    const terminal = getResult(position, rules);
    if (terminal) {
      return terminal.winner === attacker
        ? { principalVariation: [], terminal }
        : null;
    }
    if (depth === 0) return null;

    const key = `${depth}|${positionKey(position)}`;
    if (cache.has(key)) return cache.get(key)!;

    const ordered = orderMoves(position, rules, checkInterruption);
    if (position.turn === attacker) {
      for (const entry of ordered) {
        const child = prove(entry.next, depth - 1);
        if (child) {
          const proof = {
            principalVariation: [entry.move, ...child.principalVariation],
            terminal: child.terminal,
          };
          cache.set(key, proof);
          return proof;
        }
      }
      cache.set(key, null);
      return null;
    }

    // SELF can refute a forced-loss claim with any unresolved defense. Do not
    // cache or return a proof until every legal SELF continuation is proven.
    let longest: Proof | null = null;
    for (const entry of ordered) {
      const child = prove(entry.next, depth - 1);
      if (!child) {
        cache.set(key, null);
        return null;
      }
      const proof = {
        principalVariation: [entry.move, ...child.principalVariation],
        terminal: child.terminal,
      };
      if (!longest || proof.principalVariation.length > longest.principalVariation.length) {
        longest = proof;
      }
    }

    // getResult classifies no-move terminals before this point, so a
    // nonterminal node always has at least one legal move.
    cache.set(key, longest);
    return longest;
  };

  for (let index = 0; index < roots.length; index += 1) {
    const candidate = result.candidates[index]!;
    if (haltReason) {
      candidate.stopReason = haltReason;
      continue;
    }

    const beforeNodes = result.nodes;
    try {
      const afterRoot = applyMove(root, candidate.move);
      for (let depth = 2; depth <= options.maxDepth; depth += 2) {
        const proof = prove(afterRoot, depth - 1);
        checkInterruption();
        candidate.searchedDepth = depth;
        if (proof) {
          const principalVariation = [candidate.move, ...proof.principalVariation];
          candidate.proven = 'loss';
          candidate.proof = {
            winner: proof.terminal.winner,
            reason: proof.terminal.reason,
            plies: principalVariation.length,
          };
          candidate.principalVariation = principalVariation;
          candidate.completed = true;
          break;
        }
      }
      if (candidate.proven === 'unknown') candidate.completed = true;
    } catch (error) {
      if (error !== HALT) throw error;
      candidate.stopReason = haltReason!;
    } finally {
      candidate.nodes = result.nodes - beforeNodes;
    }
  }

  if (haltReason) {
    for (const candidate of result.candidates) {
      if (!candidate.completed && candidate.stopReason === 'complete') {
        candidate.stopReason = haltReason;
      }
    }
  }
  return result;
}

function validateOptions(options: JevTerminalLossOptions): void {
  if (!Number.isFinite(options.deadlineMs)) {
    throw new Error('JEV terminal proof requires a finite deadlineMs');
  }
  if (!Number.isInteger(options.maxNodes) || options.maxNodes < 0) {
    throw new Error('JEV terminal proof maxNodes must be a non-negative integer');
  }
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 2 || options.maxDepth > 8 || options.maxDepth % 2 !== 0) {
    throw new Error('JEV terminal proof maxDepth must be one of 2, 4, 6, or 8');
  }
}

function orderMoves(
  state: GameState,
  config: RuleConfig,
  checkInterruption: () => void,
): Array<{ move: Move; next: GameState }> {
  const king = findKing(state, state.turn);
  return legalMoves(state, config)
    .map((move, index) => {
      checkInterruption();
      const next = applyMove(state, move);
      const terminalWin = getResult(next, config)?.winner === state.turn;
      const kingForward = move.kind === 'MOVE'
        && king?.r === move.from.r
        && king.c === move.from.c
        && (state.turn === 'BLACK' ? move.to.r < move.from.r : move.to.r > move.from.r);
      return { move, next, index, rank: terminalWin ? 0 : kingForward ? 1 : 2 };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ move, next }) => ({ move, next }));
}
