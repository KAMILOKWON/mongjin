import { applyMove } from '../src/core/apply';
import type { RuleConfig } from '../src/core/config';
import { getResult } from '../src/core/result';
import { findKing, legalMoves, opponent } from '../src/core/rules';
import type { GameState, Move } from '../src/core/types';
import { jevMoveId } from './jevPolicy';

export interface JevPressureExample {
  opponentReply: Move;
  captureThreatsIfUnanswered: Move[];
  /** These avoid a terminal loss on the following reply, not every later threat. */
  checkedResponses: number;
  totalResponses: number;
  responsesComplete: boolean;
  safeResponses: { move: Move; action: 'king' | 'guard'; advancesRow: boolean; immediateWin: boolean }[];
}

export interface JevPressureAnalysis {
  scope: 'opponent-capture-threats-and-next-reply-safety';
  complete: boolean;
  stopReason: 'complete' | 'deadline' | 'node-budget' | 'aborted';
  nodes: number;
  candidates: {
    id: string;
    checkedOpponentReplies: number;
    totalOpponentReplies: number;
    complete: boolean;
    threatsFound: number;
    /** At most three legal examples; never an exhaustive opponent strategy. */
    examples: JevPressureExample[];
  }[];
}

/** Exposes chasing replies that a single heuristic principal variation can omit.
 * This supplies evidence only: no candidate filtering, score or move override. */
export function analyzeJevPressure(state: GameState, config: RuleConfig, moves: Move[], options: {
  deadlineMs: number; maxNodes: number; signal?: AbortSignal;
}): JevPressureAnalysis {
  const result: JevPressureAnalysis = {
    scope: 'opponent-capture-threats-and-next-reply-safety', complete: false,
    stopReason: 'complete', nodes: 0, candidates: [],
  };
  const halt = Symbol('pressure-analysis-halt');
  const check = () => {
    if (options.signal?.aborted) result.stopReason = 'aborted';
    else if (Date.now() >= options.deadlineMs) result.stopReason = 'deadline';
    else if (result.nodes >= options.maxNodes) result.stopReason = 'node-budget';
    else return;
    throw halt;
  };
  const apply = (position: GameState, move: Move) => {
    check(); result.nodes++; return applyMove(position, move);
  };
  const self = state.turn;
  const enemy = opponent(self);
  const legalIds = new Set(legalMoves(state, config).map(jevMoveId));
  if (getResult(state, config) || moves.some((move) => !legalIds.has(jevMoveId(move)))) {
    throw new Error('Invalid JEV pressure root');
  }
  try {
    for (const move of moves) {
      const entry: JevPressureAnalysis['candidates'][number] = {
        id: jevMoveId(move), checkedOpponentReplies: 0, totalOpponentReplies: 0,
        complete: false, threatsFound: 0, examples: [],
      };
      result.candidates.push(entry);
      const after = apply(state, move);
      if (getResult(after, config)) { entry.complete = true; continue; }
      const replies = legalMoves(after, config);
      entry.totalOpponentReplies = replies.length;
      for (const reply of replies) {
        const threatened = apply(after, reply);
        if (getResult(threatened, config)) { entry.checkedOpponentReplies++; continue; }
        const king = findKing(threatened, self)!;
        // A hypothetical capture *if SELF does not resolve it*, not a legal pass.
        const captureThreats = legalMoves({ ...threatened, turn: enemy }, config).filter((m) =>
          m.kind === 'MOVE' && m.to.r === king.r && m.to.c === king.c);
        if (captureThreats.length) {
          entry.threatsFound++;
          const responses = legalMoves(threatened, config);
          const example: JevPressureExample = {
            opponentReply: reply, captureThreatsIfUnanswered: captureThreats,
            checkedResponses: 0, totalResponses: responses.length, responsesComplete: false, safeResponses: [],
          };
          entry.examples.push(example);
          for (const response of responses) {
            const escaped = apply(threatened, response);
            const terminal = getResult(escaped, config);
            let safe = terminal?.winner === self;
            if (!terminal) {
              safe = true;
              for (const counter of legalMoves(escaped, config)) {
                if (getResult(apply(escaped, counter), config)?.winner === enemy) { safe = false; break; }
              }
            }
            example.checkedResponses++;
            if (safe) {
              const isKing = response.kind === 'MOVE' && threatened.board[response.from.r]?.[response.from.c]?.type === 'KING';
              example.safeResponses.push({ move: response, action: isKing ? 'king' : 'guard',
                advancesRow: isKing && response.kind === 'MOVE'
                  && (self === 'BLACK' ? response.to.r < response.from.r : response.to.r > response.from.r),
                immediateWin: terminal?.winner === self,
              });
            }
          }
          example.responsesComplete = true;
        }
        entry.checkedOpponentReplies++;
      }
      entry.complete = true;
    }
    result.complete = true;
  } catch (error) { if (error !== halt) throw error; }
  for (const entry of result.candidates) {
    // Show completed restrictive replies first, preserving their actual moves.
    entry.examples.sort((a, b) => Number(b.responsesComplete) - Number(a.responsesComplete)
      || a.safeResponses.filter((r) => r.advancesRow || r.immediateWin).length
        - b.safeResponses.filter((r) => r.advancesRow || r.immediateWin).length
      || a.safeResponses.length - b.safeResponses.length);
    entry.examples = entry.examples.slice(0, 3);
  }
  return result;
}
