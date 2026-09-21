import { createHash } from 'node:crypto';
import type { GameState, Move } from '../src/core/types';

export const JEV_PARALLEL_POLICY = {
  version: 'parallel-v16', rulesVersion: 'mongjin-core-1', protocolVersion: 1,
  turnLimitMs: 30_000, maxPlies: 240, targetP95Ms: 8_000,
  factsBudgetMs: 2_000, proposalBudgetMs: 8_000, searchBudgetMs: 3_000,
  searchProposalBudgetMs: 4_300,
  finalBudgetMs: 8_000, maxDepth: 4, maxNodes: 100_000, maxReproposals: 1,
  maxGuardAlternatives: 2,
  maxKingLaneAlternatives: 3,
  pressureBudgetMs: 1_000, pressureMaxNodes: 20_000,
  rolloutBudgetMs: 4_000, rolloutMaxPlies: 8, rolloutDecisionNodes: 64,
  // Provisional until fixed-condition timing measurements; never claim these targets were achieved.
  budgetStatus: 'provisional',
} as const;

export const JEV_ROLES = [
  { id: 'survival', purpose: 'Reduce the risk of our king being captured or surrounded and preserve escape routes. Compare deploying a guard with moving the king again; repeated retreat can surrender the goal race.', priority: 'Should preserving or opening our king escape routes take priority now?' },
  { id: 'blocking', purpose: 'Delay or prevent the opposing king from reaching its goal. Consider guard deployment or movement before the threat is one move from the goal; a reserve guard does not block any square.', priority: 'Should blocking the opposing king route take priority now?' },
  { id: 'breakthrough', purpose: 'Open an obstructed route for our king, using guards to challenge opposing blockers where useful. Compare developing a guard with repeatedly moving the king around the same obstacle.', priority: 'Should using guards to open a currently blocked route take priority now?' },
  { id: 'exchange', purpose: 'Find a favorable guard exchange, considering the opponent recapture and both reserves and deployed guards.', priority: 'Is there a favorable guard exchange opportunity now, after considering recapture?' },
  { id: 'advance', purpose: 'Find a king move that improves the race to the goal.', priority: 'Should advancing our king take priority now?' },
  { id: 'general', purpose: 'Choose the move most likely to help us win, without restricting yourself to a particular plan.', priority: null },
] as const;

export function jevMoveId(move: Move): string {
  return move.kind === 'PLACE' ? `p_${move.to.r}_${move.to.c}` : `m_${move.from.r}_${move.from.c}_${move.to.r}_${move.to.c}`;
}

export function jevStateHash(state: GameState): string {
  return createHash('sha256').update(JSON.stringify({
    board: state.board.map((row) => row.map((piece) => piece ? `${piece.player}:${piece.type}` : null)),
    turn: state.turn, guards: [state.guardsInHand.BLACK, state.guardsInHand.WHITE],
    history: state.history.map(jevMoveId),
    positions: Object.entries(state.positionCounts).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
}
